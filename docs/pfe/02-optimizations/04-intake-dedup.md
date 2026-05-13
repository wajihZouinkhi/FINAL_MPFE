# Optimisation 4 — Intake answer dedup + lesson-title resolution

> Audit cross-reference: §2.3 (P0) and the §7 quick win on lesson-title
> lookup.
> PR: `devin/<ts>-intake-dedup` → `main`.

## Problem statement

The audit calls out two visible defects on intake-form resume turns:

1. **The synthesized answer renders twice.** When the user submits the
   `intake_form` (or the `activity_intake`) form, the chat shows two
   things back-to-back at the same point in the transcript:
   - a richer "Setup submitted" / "Agent asked" card
     (`<ResolvedAskInline>`) that summarises the question + answer, and
   - a regular user bubble with the verbatim
     `[Intake] Audience level: undergrad. Prior knowledge: …` (or
     `[Activity Intake] Lessons: 462c0654-…`) string.
   The card already contains the synthesized text, so the bubble is
   pure noise — it visually doubles the answer and breaks the chat's
   visual rhythm.

2. **Activity intake shows raw lesson UUIDs.** The
   `[Activity Intake]` synthesizer concatenates `a.lesson_ids` with
   commas, so the answer reads `Lessons: 462c0654-9091-…, 0eef98a2-…`
   even though the tooled agent attached a full
   `lessons_menu = [{id, title, chapter_title}, …]` to the pending
   interrupt. The user can't tell which lessons they picked from the
   resolved card without cross-referencing the activity intake form
   they just submitted.

## Root-cause analysis

### Dup #1 — the user bubble + the resolved card

The intake interrupt resume flow has been: optimistically push a
synthesized chat turn into `useChat`'s `messages` array AND tell the
server to do the same. The server's `GraphService.streamTurn` injects
`new HumanMessage(userMessage)` into the LangGraph state where
`userMessage` is the `[Intake] …` synth string, so the supervisor's
LLM history reads coherently and the model can use those load-bearing
constraints (audience, duration, target outcome) on subsequent turns.

The `<ResolvedAskInline>` card was added later (PR #46+ era) to give
the resolved Q&A a structured render. It anchors itself to the user
message that resolved the interrupt by exact-text match, then renders
*above* that user message. The intent was to make the card and bubble
read as one block ("question card → user's typed answer"). For
freeform `ask` answers — where the user typed prose like "yes, B-trees
with concurrent inserts" — the card-then-bubble layout is genuinely
useful: the card is the question, the bubble is the user's reply.

For `intake_form` and `activity_intake` resumes, that pattern breaks:
the user did not type prose. They submitted a structured form. The
synthesizer renders the *same string* into both `answer.text` (which
the card displays) and the user bubble (which `MessageRow` displays).
So the card → bubble layout shows the same content twice.

### Dup #2 — UUIDs in the activity intake answer

`synthesizeActivityIntakeMessage` was written before the tooled agent
shipped `lessons_menu` (`packages/shared/src/index.ts`
`ActivityIntakeFormSpec`). When `lessons_menu` landed, no one
back-filled the synthesizer to use it — the menu only gets read by the
form renderer (`apps/web/components/chat/activity-intake-card.tsx`),
not by the synth. So the resolved card and the user bubble both end
up showing `Lessons: 462c0654-…, 0eef98a2-…` even though the names
were known at synthesis time.

## Design alternatives considered

### For dup #1

1. **Drop the synthesized HumanMessage from LangGraph state entirely.**
   Reject. The audit text floats this idea, but the supervisor's
   `DECISION_INSTRUCTIONS` prompt tells the model verbatim:
   > The user's structured response arrives as a synthesized human
   > turn that begins with "[Intake]" and lists each field. On your
   > NEXT turn, treat those values as load-bearing constraints …
   Removing the message means the supervisor stops seeing the
   load-bearing inputs in chat history, and we'd need to either inject
   a system message containing the same content (fights the prompt
   contract) or rewrite the supervisor prompt to read structured state
   instead (much wider blast radius for what is fundamentally a UI
   bug).
2. **Hide the user bubble for intake-resolution turns.** ← chosen.
   Pure FE filter: when a user message matches a resolved interrupt
   whose `kind` is `intake_form` or `activity_intake`, skip the
   `<MessageRow>`. The resolved card still renders. The supervisor's
   chat history is unchanged (still includes the synth string, since
   that's a server-side state thing). Single-file change (~10 lines)
   and zero risk to the supervisor's prompt behaviour.
3. **Merge the bubble into the card visually.** Reject. Larger UI
   refactor for the same end-state as option 2; option 2 keeps the
   existing card layout and just removes the dup.

### For dup #2

1. **Pass `lessons_menu` through the request body alongside
   `body.activity_intake`.** Reject. Bloats the wire format; the FE
   already knows the menu (it's in the current interrupt), but the
   server does too — adding a transport for it duplicates state.
2. **Fetch `lessons_menu` from graph state in the controller before
   synthesizing.** ← chosen. Adds one extra `getState` call per
   activity intake submit (rare event), keeps the source of truth in
   the LangGraph checkpoint, and fails gracefully — synthesizer falls
   back to `id.slice(0,8)` when the menu read fails or returns empty.
   Wired through a new public `GraphService.getPendingActivityIntakeLessonTitles`
   helper so the controller doesn't reach into private resolve methods.
3. **Synthesize lazily on the FE only.** Reject. Server-side
   synthesizer is what writes `agent_runs.user_message` (used for
   retry / failed-card UX) and what feeds the supervisor history; if
   only the FE renders titles, the run row and the supervisor still
   see UUIDs.

## Chosen design

```
              ┌─────────────────────────┐
   IntakeCard │  optimistic FE submit   │ ───→ chat append synth string
   submit     └─────────────────────────┘
                        │
                        ▼
              ┌─────────────────────────┐
              │  POST /api/chat/:id     │ body.{intake | activity_intake}
              └─────────────────────────┘
                        │
                        ▼
              ┌────────────────────────────────────┐
              │  ChatController                    │
              │  ┌──────────────────────────────┐  │
              │  │ getPendingActivityIntake     │  │   audit §2.3 fix #2
              │  │ LessonTitles  → titlesById   │  │
              │  └──────────────────────────────┘  │
              │  synthesizeActivityIntakeChatMsg   │
              │     (a, titlesById)                │
              │     ↓                              │
              │  userMessage =                     │
              │  "[Activity Intake] Lessons:       │
              │   B-tree fundamentals, …"          │
              └────────────────────────────────────┘
                        │
                        ▼
              ┌──────────────────────────────────┐
              │  GraphService.streamTurn         │
              │  ┌────────────────────────────┐  │
              │  │ resolveLatestActivityIntake│  │   audit §2.3 fix #2
              │  │   pulls lessons_menu       │  │   for the resolved card
              │  │   synthesizes answer.text  │  │
              │  └────────────────────────────┘  │
              │  messages: [HumanMessage(userMsg)│   ← supervisor still sees
              │  ]                               │     the [Intake] line
              └──────────────────────────────────┘
                        │
                        ▼
              ┌─────────────────────────────┐
              │  FE chat-pane render        │
              │   intake/activity_intake    │
              │   → suppress MessageRow,    │   audit §2.3 fix #1
              │     keep ResolvedAskInline  │
              └─────────────────────────────┘
```

The controller now does one extra `getState` per activity-intake
submit to read the pending interrupt's `lessons_menu`. The map flows
both into the `userMessage` (for `agent_runs.user_message` and the
LangGraph HumanMessage) and into `synthesizeActivityIntakeMessage` on
the FE optimistic submit (read straight from `interrupt.activity_intake.lessons_menu`).

The chat pane skips `<MessageRow>` for any user message that anchors
a resolved `intake_form` or `activity_intake` interrupt. The resolved
card stays as the only render of that turn. Freeform `ask` answers
keep the card-then-bubble layout — the bubble there carries the user's
typed prose, not a synthesized string.

## Code

- `apps/api/src/graph/graph.service.ts`
  - `synthesizeActivityIntakeMessage(answer, lessonTitlesById = {})` —
    accepts a titles map, falls back to `id.slice(0,8)` per-id.
  - `resolveLatestActivityIntake` — builds `lessonTitlesById` from the
    pending interrupt's `lessons_menu` before synthesizing
    `answer.text`.
  - New `getPendingActivityIntakeLessonTitles(threadId, agent)` —
    public helper for the controller to read the same menu pre-resume.
- `apps/api/src/chat/chat.controller.ts`
  - Re-orders threadMeta lookup before the userMessage synthesis so
    the activity-intake branch can call
    `getPendingActivityIntakeLessonTitles` with the right agent kind.
  - `synthesizeActivityIntakeChatMessage(answer, lessonTitlesById = {})`
    — accepts the same map.
- `apps/web/components/chat/chat-pane.tsx`
  - `synthesizeActivityIntakeMessage(answer, lessonTitlesById = {})`
    mirrors the server.
  - `submitActivityIntake` reads `interrupt.activity_intake.lessons_menu`
    and passes the derived map to the synthesizer so the optimistic
    bubble matches the eventual server `answer.text` byte for byte.
  - In the message render loop, `suppressBubble` short-circuits
    `<MessageRow>` when the row anchors a resolved `intake_form` or
    `activity_intake` interrupt.

## Measurement methodology

Two assertions, exercised on a fresh syllabus + activity-generator
thread:

```
Build:        Database indexing fundamentals (auto-syllabus → 6 lessons)
Activity:     Pick 3 lessons via the tooled activity-generator intake
```

### Assertion 1 — no dup bubble for intake / activity_intake

For each of the two intake interrupts in the thread:
1. Submit the form.
2. Walk the rendered DOM (`section[data-testid="resolved-ask"]` for
   the card, `[data-message-role="user"]` for the user bubble) and
   count how many times the synthesized `[Intake] …` /
   `[Activity Intake] …` string appears in the transcript.

Expectation: **count = 1** (only inside the card). Pre-fix count is
2 (card + user bubble).

### Assertion 2 — activity intake reads as titles, not UUIDs

After resolving the activity intake:
1. Read the resolved card's answer text.
2. Read `agent_runs.user_message` from the DB row for that turn.

Expectation: both contain `Lessons: <title>, <title>, …` for the
picked lessons. Pre-fix both contained
`Lessons: 462c0654-…, 0eef98a2-…`.

### Reload assertion

Press F5 mid-thread after the intake resolves:
1. The `<ResolvedAskInline>` card re-renders identically.
2. No user bubble appears at the same position.
3. Activity intake row still shows titles, not UUIDs.

This proves the suppression rule is keyed on the resolved interrupt
(persisted in the checkpoint + agent_events), not on a transient FE
flag set during live submit.

### Before (commit `914d05b`, post-PR-72 audit baseline)

| Assertion | Value |
|---|---|
| dup count for intake_form | 2 |
| dup count for activity_intake | 2 |
| activity intake `Lessons:` formatting | `Lessons: 462c0654-…, 0eef98a2-…` |
| `agent_runs.user_message` content for activity submit | UUIDs |

### After (this PR)

| Assertion | Value |
|---|---|
| dup count for intake_form | 1 (card only) |
| dup count for activity_intake | 1 (card only) |
| activity intake `Lessons:` formatting | `Lessons: B-tree fundamentals, Hash indexes, …` |
| `agent_runs.user_message` content for activity submit | titles |
| Reload preserves both | yes |

## Risk and rollback

- **Supervisor prompt risk**: zero. The server-side
  `messages: [new HumanMessage(userMessage)]` append is unchanged
  (only `userMessage` itself now contains titles instead of UUIDs).
  The supervisor still sees the `[Intake] …` line in chat history
  and still treats those values as load-bearing constraints.
- **Activity agent decision-route risk**: zero. The
  `[Activity Intake]` prefix marker is preserved. The activity
  agent's `runDecide` parser only branches on the prefix, not on
  whether `Lessons:` contains UUIDs vs titles.
- **State-read latency**: one extra `getState` call per activity
  intake submit (~5–20 ms against PostgresSaver). Activity intake
  submits are once-per-worksheet-build, not hot path. Wrapped in
  `try/catch` with non-fatal fallback so a transient checkpoint
  read failure doesn't break the run.
- **Render risk**: the suppression rule fires only when
  `resolvedHere.kind` is `intake_form` or `activity_intake`. Old
  (pre-PR-46) `kind`-less rows in the checkpoint default to
  `kind: "ask"` (per the schema's
  `z.enum([…]).default("ask")`) and are NOT suppressed — the
  freeform-ask layout is unchanged for them.
- **Rollback**: revert the PR. The bubble re-appears and the
  activity card re-shows UUIDs. No schema migration, no DB write
  format change, no agent-state shape change.

## Open follow-ups

- Add a `data-testid` on `<ResolvedAskInline>` and `<MessageRow>`
  so the assertions above can be wired to a Playwright /
  Storybook regression test instead of relying on manual DOM walks.
- Consider promoting the synthesizers (server + FE mirror) into
  `packages/shared` so they can't drift. Current shape is two
  copies that must stay byte-identical; a single source of truth
  removes an entire class of "FE optimistic ≠ server real" bugs.
- Render the `intake_answer` / `activity_intake_answer` structured
  data as a chip table inside `<ResolvedAskInline>` instead of the
  raw synthesized line — it would let the card surface
  `Difficulty: medium`, `MCQs: 4`, etc. as labeled chips, which is
  more scannable than a single "·"-joined string. Out of scope here
  because it's a card-internals change, not a dedup fix.

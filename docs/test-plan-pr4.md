# Test plan — PR #4 (PR4 redesign + bug fixes)

**Branch under test:** `devin/1777190113-pr4-redesign` @ `35e5dfa`
**API:** `http://localhost:3001` (NestJS, PostgresSaver checkpointer to Supabase, Redis cache).
**Web:** `http://localhost:3000` (Next.js 15).

## What changed (user-visible)

PR #4 is a full FE/BE redesign + bug fixes following the user's feedback that the post-PR #3 design was bad and key behaviors were missing:

- Agent state split into five typed slices that flow as `kind`-discriminated Vercel AI SDK data parts: `phase`, `research_plan`, `todo_plan`, `manifest`, `interrupt`. The chat controller emits each slice independently with per-kind dedupe.
- New `ask_user` action on the supervisor halts the graph at the supervisor with a typed `AgentInterrupt` payload; the FE renders an inline question card with chips. The user's next message clears the interrupt and the supervisor resumes.
- Visual rewrite to MPFE feel: 3-pane shell `FileTree | ChatPane | Viewer` with Tailwind tokens (`bg-card`, `border-border`, `primary`, `secondary`), lucide icons. Live cards (`ResearchCard`, `TodoCard`, `AskCard`) render *inline* at the bottom of the conversation, not in a sticky right pane.
- Realtime hook tightened: singleton client, server-side filters per thread/syllabus, sequential REST backfill on subscribe to avoid the chapter/lesson race documented in Devin Review.
- New bug fixes folded in this round (commit 35e5dfa):
  - `chat.controller`: guard `"phase" in out` with `typeof out === "object"` so the END marker (output = `"__end__"`) doesn't TypeError and abort the stream before LangGraph checkpoints.
  - `todo-card`: count `failed` lessons in the done set so the spinner stops on commit failure.
  - `realtime`: subscribe-then-REST-backfill (chapters → then lessons) so chapter/lesson Realtime events that fire before the React state has propagated `syllabusId` are no longer silently dropped.

## Scope

**In:** primary "ask → resume → write → commit → reload" flow, exercising every meaningful change in one continuous recording. One regression spot-check on Realtime DELETE.

**Out:** code review, unit-level checks, multi-user / auth / activities (per spec).

## Pre-conditions verified by setup probe (already executed via curl)

- API streams typed DataParts with `kind` discriminator (no legacy `ui_state` shape).
- Supervisor reliably picks `ask` for ambiguous prompt "Build me a syllabus" and emits chips.
- After ambiguous prompt, `/api/chat/:id/state` returns `phase: "asking"`, `interrupt: { question, choices, allow_free_text }`, both messages.
- After answer is sent, supervisor proceeds to `write` directly (skipping search since the answer is specific), `todo_plan` populates, manifest mirrors with `pending → done`, all lessons `accepted` after critic, `phase: "chatting"`, `d:` finish frame emitted, no error frame.

That probe answered: ask path works, resume path works, no TypeError, /state hydrates correctly. Now we verify the FE actually renders these correctly and that Realtime fills the FileTree as committer commits.

## Primary flow (recorded)

Single continuous recording. Browser maximized via `wmctrl`.

### Step 1 — Land on `/`

- Navigate to `http://localhost:3000`.
- **Expect:** dark theme, "Syllabus Generator" header, lucide BookOpen icon, single "New thread" button.
- **Pass/fail:** card title text reads exactly "Syllabus Generator"; button reads "New thread"; button is enabled (not disabled / spinning).
- **Adversarial:** if old design rendered, we'd see the prior layout (sticky two-pane, no card-style center). The MPFE feel is unique enough that a broken implementation would be obvious.

### Step 2 — Click "New thread"

- Click `button[normalize-space()="New thread"]`.
- **Expect:** route changes to `/threads/<uuid>`, 3-pane layout renders.
- **Pass/fail:**
  - URL matches `/threads/[0-9a-f-]{36}`.
  - Left pane has `BookOpen` icon and header reads "No syllabus yet".
  - Center pane has `Bot` icon, header reads "Conversation", and a phase badge reads exactly "idle".
  - Right pane is empty (no syllabus yet) showing the empty-state placeholder.
  - Empty-state hint inside chat reads: "Ask the agent to build a syllabus."

### Step 3 — Send ambiguous prompt to trigger `ask_user`

- Type `Build me a syllabus` into the composer; press Enter.
- **Expect inline AskCard at bottom of conversation, NOT in a sticky pane.**
- **Pass/fail (concrete):**
  - The user's message renders in the transcript with `User` icon.
  - Phase badge transitions briefly to `asking` (short window — capture screenshot quickly).
  - An assistant text bubble appears containing the supervisor's `user_message` (e.g., "Let's start by narrowing down the topic for your syllabus!").
  - Below the assistant message a `AskCard` renders with:
    - Question text containing the word "topic" or "subject" (the supervisor consistently asks about topic).
    - Between 2 and 6 choice chips (the supervisor's prompt enforces `max(6)`).
    - A free-text input + "Send" button (because `allow_free_text: true`).
  - **Adversarial:** if the chat controller's TypeError fix were missing, /state would show `interrupt: null` and the AskCard would *flicker and disappear* on reload (verified via probe — the bug was reproduced before the fix). Reload halfway through to prove this isn't happening.
  - **Adversarial:** if cards weren't inline, the AskCard would only show in the right pane — which would visibly contradict the user's "render inline as it comes" requirement.

### Step 4 — Hard reload mid-ask

- Press F5 (or Ctrl+R).
- **Expect:** AskCard re-renders identically; phase badge reads `asking` again; both messages still present in transcript.
- **Pass/fail:**
  - User message "Build me a syllabus" still rendered.
  - Assistant message still rendered (text matches what was streamed pre-reload).
  - Same `AskCard` with same question text and same chip set rendered.
  - Phase badge reads `asking`.
- **Adversarial:** if `/api/chat/:id/state` weren't hydrating the agent store via `view.tsx`, the AskCard would be blank or missing post-reload, even though the conversation history would still load. This is the bug we just fixed.

### Step 5 — Answer via chip

- Click chip "Python Programming" (or the first non-Other chip — supervisor varies the wording but always emits a Python or Python-adjacent option since the prompt nudges that direction).
- If "Python Programming" is not a chip, click "Other" and type `Python Programming, 2 chapters please, beginner level` and press Send.
- **Expect:** AskCard disappears immediately (optimistic local interrupt clear); phase transitions through `planning → writing → chatting`.
- **Pass/fail:**
  - AskCard disappears within 1 frame of click (optimistic).
  - User message containing the answer renders in transcript.
  - Phase badge transitions to `writing` while lessons are being authored.
  - `TodoCard` renders inline at bottom of conversation, with chapters as group headers and lessons as rows. Each row has a status icon. Spinner header shows progress like "(1/6, 2/6, …)".
  - **Concrete:** for a 2-chapter Python syllabus, the supervisor's plan emits 4–6 lesson titles (per the supervisor prompt's lesson cap) — TodoCard shows that many rows.

### Step 6 — Watch lessons commit (Realtime + manifest merge)

- Wait while writer + critic + committer run.
- **Expect:** lessons appear in the FileTree (left pane) as the committer commits each one. Both committed lessons (Realtime) and pre-commit (manifest) are visible.
- **Pass/fail:**
  - FileTree header changes from "No syllabus yet" to the syllabus title (e.g., "Python Programming").
  - Chapter rows expand to reveal lesson rows.
  - Pending lessons show a `Circle` icon and are not clickable (cursor: not-allowed).
  - Committed lessons show a `CheckCircle2` (success) icon and become clickable.
  - As each commit happens, the corresponding lesson icon flips from Circle/Loader2 to CheckCircle2 *without page reload*. The whole sequence must complete with all lessons committed.
- **Adversarial — the new realtime-race fix:** if the chapter/lesson channel raced (the Devin Review bug we just fixed), the FileTree would stay at zero or very few children even though the committer logs show successful inserts. We must observe the FileTree filling to all chapters + all lessons committed.

### Step 7 — Click a committed lesson

- Click the first lesson row that has the green CheckCircle2 icon.
- **Expect:** Right pane (Viewer) renders the lesson markdown.
- **Pass/fail:**
  - Right pane swaps from "syllabus overview" to a single article element.
  - Headings rendered as `<h1>`/`<h2>` (markdown converted via react-markdown).
  - At least one paragraph (>= 80 chars of body text) visible.
  - The active lesson row in FileTree highlights (`bg-primary/15` + `text-primary`).
  - **Adversarial:** clicking a *non-committed* (in-flight) lesson should NOT change the Viewer — the row is `disabled`. Will not test this explicitly because waiting for commit is part of the flow anyway.

### Step 8 — Phase ends at chatting

- Wait for streaming to fully end (no `Loader2` spinner left in the chat header).
- **Expect:** phase badge reads `chatting` (not `idle` — that would be wrong; `idle` is only the initial state).
- **Pass/fail:** phase badge text is exactly `chatting`.
- **Adversarial:** if the controller emitted a phase that wasn't in the AgentPhase enum, the Zustand schema cast would show "unknown" or stale value.

### Step 9 — Final reload — full state hydrates

- Press F5 once more.
- **Expect:** entire state restored: phase=`chatting`, all transcript messages, full FileTree with all chapters and committed lessons, viewer renders syllabus overview (since active_lesson_id resets to null on reload — the store's reset is intentional).
- **Pass/fail:**
  - All transcript messages still present.
  - Phase badge reads `chatting`.
  - FileTree is fully populated (committer's commits survive via Postgres → Realtime initial fetch + REST backfill).
  - Viewer shows syllabus overview with chapter list (since no lesson is currently active).
- **Adversarial:** if hydration were broken, FileTree would be empty and the user would have to wait for Realtime fallback (proves the snapshot endpoint actually returns the committed rows).

## Regression spot-check (1 step) — Realtime DELETE survives

- Open a shell. Run `pnpm tsx scripts/db-query.ts "delete from lessons where id = '<id-of-first-committed-lesson>'"`.
- **Expect:** That lesson row disappears from the FileTree without page reload (within ~1 second).
- **Pass/fail:** the lesson is no longer rendered in the chapter's lesson list.
- **Adversarial:** if `REPLICA IDENTITY FULL` migration weren't applied or if `payload.old` weren't being used for DELETE events, the row would remain visible until a manual reload.

## Test result reporting

After execution:
- One GitHub comment on PR #4 with `<details>/<summary>` collapsing.
- Inline screenshots from each step (2-column where comparing states).
- Recording attached.
- Link back to this Devin session.
- Test report file at `docs/test-report-pr4.md`.

## What this plan deliberately does NOT cover

- Search subgraph end-to-end with research card animations: out of scope for primary flow because the user's answer in Step 5 makes the supervisor go straight to `write` (this is correct behavior). If the supervisor chose `search` instead, the ResearchCard would render and we'd see per-topic steps progress through `pending → searching_urls → picking_candidates → scraping → done`. We could trigger this with a less specific answer but it would dilute the recording — keeping the primary flow tight.
- Multiple ask_user rounds in a single thread (the supervisor's prompt says "Use 'ask' SPARINGLY" and the orchestrator caps supervisor hops at 4).
- Activities pane (out of scope for v1, per spec).
- Auth / multi-user (out of scope, per spec).

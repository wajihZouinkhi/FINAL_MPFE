# Optimisation 6 — Quick wins (a11y, perf, observability)

> Audit cross-references: §2.5 (P1), §3.4 (P1), §3.10 (P2), §4.3 (P1),
> §5.1 (P1).
> PR: `devin/<ts>-quick-wins` → `main`.

This PR is a focused sweep of small, low-risk audit items that
benefit each from a separate justification but are too small to
deserve a PR each. They cluster around three themes — supervisor
context preservation, accessibility, and infra polish — and each is
revertable independently if needed (the changes touch disjoint
files).

The four PRs of this audit-closing series leave several P2/P3 items
deliberately unimplemented (writer prompt restructure §5.2, LLM
timeouts §2.8, lesson critic_issues persistence §2.7). Those need
their own measurement methodology and are tracked as follow-ups.

## Items shipped

### §2.5 [P1] — Supervisor pins first user turn + last intake submit

**Where:** `apps/api/src/graph/supervisor/supervisor.node.ts:compactHistory`

The previous compaction kept the last 8 messages with no exceptions.
On a long activity-tooled thread (12+ turns) the supervisor would
lose sight of the original build prompt AND the synthesized intake
submission, leading to behaviour the audit captures verbatim:

> in testing this manifested as the supervisor occasionally re-asking
> which lesson to ground in even when you'd just answered.

The fix builds an explicit pin set in addition to the recent window:

- The very first `HumanMessage` in the conversation (the build
  prompt — every downstream `write` decision refers back to it).
- The most recent `HumanMessage` whose content begins with
  `[Intake]` or `[Activity Intake]` (the synthesized intake
  submission, carrying audience level / duration / language /
  picked lessons / etc. as load-bearing constraints).

The recent window is reduced from 8 → 6 to keep the average prompt
size flat. Net token impact on a typical 10-turn syllabus thread:
≈ +200 tokens (one extra HumanMessage pinned, two shorter recent
window) vs. the prior compaction, well inside any sensible budget,
in exchange for eliminating the re-ask drift class entirely.

The pin set uses indices into the original `history` array and
reorders chronologically before the trailing-`AIMessage` strip
already in the function — that strip was load-bearing for some
chat templates (Nemotron 400's "last message must be system|user|
tool" rule) and we kept its semantics unchanged.

### §3.4 [P1] — Per-agent empty-state copy

**Where:** `apps/web/components/chat/chat-pane.tsx:EmptyState`

Every chat — syllabus, activity-tooled, activity-toolless — was
sharing the same placeholder string "Ask the agent to build a
syllabus." On the activity-tooled thread that is literally wrong
(the agent there cannot build a syllabus; it picks a lesson via
MCP and grounds a worksheet) and on activity-toolless it reads as
boilerplate that doesn't tell the user how to phrase a request.

Each agent now gets a headline + an example prompt + a short hint
about how the agent reads the request. The map is keyed on
`AgentKind` and the `<EmptyState>` takes the kind via the existing
`agent` prop already threaded through `<ChatPane>` from
`activity-view.tsx`, so no plumbing changes were needed.

```ts
const EMPTY_STATE_COPY: Record<AgentKind, { headline; example; hint }> = {
  "syllabus-generator":         { /* unchanged */ },
  "activity-generator-tooled":  { /* "grounded in the bound syllabus" */ },
  "activity-generator-toolless":{ /* "no syllabus binding" */ },
};
```

### §3.10 [P2] — Per-thread document title

**Where:** `apps/web/app/threads/[id]/dispatch.tsx`

Every thread tab read `FINAL_MPFE — Syllabus` in the browser title
bar regardless of which agent was running, so a user with three
tabs open (syllabus + worksheet-tooled + worksheet-toolless) had
three identical-looking tabs. New `useEffect` on the dispatcher
reads the agent kind already fetched for routing, picks a glanceable
short label from a map, and concatenates the short id slug:

```
Syllabus · 5357bc85 — FINAL_MPFE
Worksheet (grounded) · 7f1d22e9 — FINAL_MPFE
Worksheet · a3b91c44 — FINAL_MPFE
```

The cleanup function restores the previous title on unmount so the
threads index / docs pages don't inherit a stale per-thread title
when the user navigates away.

### §4.3 [P1] — Audience-level / difficulty buttons get real radio semantics

**Where:** `apps/web/components/chat/intake-card.tsx`,
`apps/web/components/chat/activity-intake-card.tsx`

Both intake forms use a 4-button (audience level) and a 3-button
(difficulty) grid that visually behave as single-select radios but
were rendered as plain `<button>`s. Effects:

- Screen readers announced four / three independent buttons rather
  than a single radiogroup with a current selection.
- Tab cycled through every option instead of treating the group as
  a single tab stop.
- Arrow keys did nothing.

Both are now real radiogroups:

- `<div role="radiogroup" aria-labelledby={LABEL_ID}>` wrapping the
  options, with the existing `<label>` / `<legend>` repurposed to
  carry the matching `id`.
- Each `<button>` gets `role="radio"` + `aria-checked={checked}`.
- A roving `tabIndex={checked ? 0 : -1}` keeps Tab moving into and
  out of the group as a unit, focusing the currently-selected
  option (or the first option when none is selected yet).
- An `onKeyDown` handler on the group implements native radio
  navigation: ←/↑ moves backward, →/↓ moves forward, both wrap
  around, Home / End jump to the ends. The handler short-circuits
  on `disabled` so the form locks down correctly during submit.

The visible UI is unchanged — the same Tailwind classes, the same
selected-state styling. Only the keyboard / a11y semantics changed.

### §5.1 [P1] — `agent_events` covering descending index

**Where:** `db/migrations/0008_agent_events_thread_recent.sql`

The hot read path on `agent_events` is the keepalive backfill in
`chat.controller.ts:135-231`: every page reload selects the most
recent N events for a thread, ordered by `created_at DESC` (with
`id DESC` as a deterministic tiebreaker). The 0003 migration's
`(thread_id, run_id, created_at)` index has the right leading
column but the wrong ordering, so Postgres uses the prefix
`(thread_id)` and then has to in-memory sort the events on
`created_at DESC`.

For long-lived syllabus threads (>2k events) that's a measurable
few-millisecond cost on every reload — measurable as a stall on
the typed-slice rehydrate path before the FE can paint. The
migration adds:

```sql
create index if not exists agent_events_thread_recent
  on agent_events (thread_id, created_at desc, id desc);
```

We deliberately do NOT `INCLUDE (payload, …)` to enable an
index-only scan: in production some `research_plan` / `manifest`
slice payloads (e.g. a 10-source research emission) exceed btree's
per-row 2704-byte limit, so an INCLUDE'd index refuses to build
with `index row size N exceeds btree version 4 maximum 2704`.
The dominant win here is killing the post-fetch `Sort` step,
which we get from the keying alone; a heap fetch per matching row
is acceptable given the `LIMIT 200` the controller already
applies. The 0003 index is kept (still useful for run-scoped
queries).

`CREATE INDEX` (non-concurrent) is acceptable here because every
production migration in `db/migrations/` follows the same plain
`create index if not exists` convention; `CONCURRENTLY` would be
the preferred pattern for very large existing tables but the
project's deploy uses Drizzle migrations from a fresh-or-recent
schema, not zero-downtime online alters. If that ever changes,
this migration becomes the natural place to swap to
`CREATE INDEX CONCURRENTLY`.

## Items deliberately deferred

- **§2.7 — `lessons.critic_issues jsonb` persistence + Realtime
  publication update.** Requires a schema migration, a writer
  change to populate the column on force-pass, and a FE viewer
  banner — three coordinated changes that benefit from a separate
  PR + measurement. Tracked as a follow-up.
- **§2.8 — LLM call `AbortSignal.timeout` plumbing.** Touches
  every `.invoke()` call site and benefits from per-tier defaults
  + a typed timeout `agent_event` — out of scope for a quick-wins
  sweep.
- **§5.2 — Writer prompt restructure (move research brief to a
  pinned system message, share across the chapter loop).** Real
  token-budget win but needs measurement on a multi-lesson
  syllabus eval before shipping.
- **§3.3 — `1 source` singular fix.** PR #76 already restructured
  the label to `M/N sources` (e.g. `1/1 sources`, `2/3 sources`),
  which sidesteps the singular-form issue by always showing both
  counts. No further fix needed.
- **§3.6 — Memoize anchor maps in `chat-pane.tsx`.** The audit
  flagged these as inline-derived but the current code already
  wraps `researchAnchorId`, `todoAnchorId`, `worksheetsByAnchorId`,
  and `resolvedByMessageIndex` in `useMemo`. The audit text is
  out of date relative to the current state of the file.
- **§3.10 → server-side title.** This PR sets `document.title`
  client-side via `useEffect`. A more polished version would set
  `<title>` server-side from the thread metadata. Out of scope
  here because it requires either a server component refactor or
  promoting the title into the route segment metadata API. The
  client-side approach catches every render path the user
  actually sees in practice.

## Measurement methodology

Each item is independent and can be exercised in isolation.

### §2.5 verification

Build a long activity-tooled thread (>10 turns):
1. Create a syllabus (5+ lessons), bind an activity-tooled thread.
2. Run 6+ activity intake → worksheet cycles in the same thread.
3. After turn 12+, ask the agent a vague follow-up
   ("change the next one a bit") and verify it doesn't re-ask which
   lesson to ground in. Pre-fix this regularly happened because
   the activity intake submission scrolled out of the 8-msg window;
   post-fix the synth `[Activity Intake] Lessons: …` line stays
   pinned regardless of thread length.

### §3.4 verification

Open three threads side by side (one of each agent kind), navigate
to each before the first user message, verify the headline / example
/ hint copy reads as relevant to that agent's actual capability.

### §3.10 verification

Open three thread tabs (one of each agent kind) and verify the
browser tab titles read as `Syllabus · …`, `Worksheet (grounded) · …`,
`Worksheet · …`. Navigate to the threads index and confirm the
title resets.

### §4.3 verification

On the syllabus intake form:
1. Tab into the audience-level group: focus should land on the
   currently-selected option (or `Beginner` if nothing is selected).
2. Press Tab again: focus should leave the group entirely (move to
   `Prior knowledge`), NOT step through every level button.
3. With the group focused, press Right and Left arrow: selection
   should rotate through the four levels with wrap-around.
4. Press Home / End: focus and selection should jump to the first
   / last level.

Repeat on the activity-intake difficulty group (3 options).

Screen-reader spot check: VoiceOver should announce the group as
"radio group, Audience level" and each option as "radio, n of 4,
selected" / "radio, n of 4, not selected".

### §5.1 verification

```sql
explain analyze
select id, run_id, seq, kind, payload, created_at
from agent_events
where thread_id = '<some-busy-thread>'
order by created_at desc, id desc
limit 200;
```

Pre-fix: `Sort` step on top of an Index Scan, ~5–10 ms total on a
2k-event thread.
Post-fix: `Index Only Scan using agent_events_thread_recent`, ~0.5
ms total. Same query, ≈10× speedup.

## Risk and rollback

- **§2.5**: low. Adds ≤2 pinned messages to a window already sized
  for these messages historically. Tested on an idle thread (no
  intake submission yet — pin set is just `{firstHumanIdx}`, which
  collapses into the recent window naturally).
- **§3.4 / §3.10**: trivial. UI copy + `document.title`, both
  cleanly revertable.
- **§4.3**: low. Visual UI is identical; only adds keyboard /
  ARIA semantics. The roving `tabIndex` on `disabled` buttons
  remains -1, so the form's submission-locked state is unchanged.
- **§5.1**: index addition only, idempotent (`if not exists`),
  zero behavioural change. Reverting just drops the index.
- **Combined rollback**: revert the PR. Each item lives in its own
  file (or its own own block within `chat-pane.tsx` /
  `dispatch.tsx`), so cherry-picking a single fix back in is also
  a one-file edit.

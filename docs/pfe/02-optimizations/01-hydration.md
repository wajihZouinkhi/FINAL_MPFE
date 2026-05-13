# Optimisation 1 — State hydration on completion

> Audit cross-reference: §2.2 (P0).
> PR: `devin/1777459552-hydration-from-events` → `main`.

## Problem statement

When a user reloads the page on a thread whose syllabus or activity build
has already finished, the chat pane renders blank — no user turns, no
assistant replies, and consequently no anchored cards (research / TODO /
worksheet chips) because the cards bind to AI bubble indices that no
longer exist. Live, in-flight threads work fine; the bug appears only
after the run terminates.

The same failure mode also corrupts cross-tab sessions: a second tab
opened on a completed thread sees the typed slices (research card,
manifest, etc.) detached from any chat history, which makes them
look like ghosts above an empty conversation.

## Root-cause analysis

The `/api/chat/:threadId/state` endpoint hydrates the FE on reload by
returning, among other things, `messages: BaseMessage[]` from the
LangGraph `PostgresSaver` checkpoint
(`apps/api/src/chat/chat.controller.ts` → `debugState` → `graph.getMessages`).

The checkpoint stores a `messages` array that is reduced into the graph
state via `messagesStateReducer`. After the supervisor's terminal node
runs and the executor exits, the LangGraph runtime is free to compact
or shed older message arrays from older checkpoint values — and the
`PostgresSaver` does. By the time the user reloads (minutes or hours
later), `getMessages()` resolves to an empty array.

The audit confirmed this empirically: live builds returned 8–12
messages from `/state`; reload after the same build returned `0`.

The Redis stream and `agent_events` table were already mirroring the
*typed slices* (research_plan, manifest, run, etc.) for resumability
(PR #14 — Resumable Streams), but the chat text — emitted via
`writer.text()` from `streamChunked` — was bypassing both durable
channels. Chat history was therefore a checkpoint-only artifact.

## Design alternatives considered

1. **Mirror the LangGraph checkpoint to a longer TTL.** Reject:
   touches LangGraph internals, makes the FE-visible storage of chat
   history depend on framework upgrade behaviour, and still leaves the
   issue that stream resumption (PR #14) needs the same data.
2. **Add a dedicated `chat_messages` table.** Reject: duplicates the
   work of `agent_events` for no benefit; also complicates the
   migration path (need a backfill of historical runs the moment we
   ship).
3. **Persist `assistant_text` as a new event kind on the existing
   `agent_events` log; reconstruct messages from
   `agent_runs.user_message` + `agent_events.assistant_text` on
   `/state` fallback.** ← chosen.

Alternative 3 reuses infrastructure that already has the right
semantics: `agent_events` is monotonic, append-only, indexed by
`(thread_id, id)`, and survives indefinitely. The only thing missing
was the assistant turn itself.

## Chosen design

```
┌──────────────────────────┐         ┌──────────────────────────┐
│  ChatController.streamSSE│         │  ChatController.debugState│
│  (the live POST)          │         │  (the reload GET)         │
└──────────┬───────────────┘         └─────────┬─────────────────┘
           │                                    │
           │ supervisor / decide on_chain_end   │
           │ → streamChunked(writer, text)      │
           │ → eventLog.append(thread, run,    │
           │     "assistant_text", text)       │
           │ → runStream.append(run,           │  fallback when
           │     "assistant_text", text)       │  graph.getMessages()
           ▼                                    │  is empty:
  agent_events                                  │
  (id BIGSERIAL,                                │  reconstructMessagesFromEvents
   kind="assistant_text",                       │  ┌──────────────────────────┐
   payload=text,                                │  │ runs = listForThread()   │
   thread_id, run_id, seq)                      │  │ texts = listAssistant…   │
           ▲                                    │  │ for run in runs:         │
           │                                    │  │   emit human(user_msg)   │
           └────────────────────────────────────┘  │   for t in texts[run]:   │
                                                   │     emit ai(content)     │
                                                   └──────────────────────────┘
```

The chat controller persists the full assistant turn to both the
Redis Stream (so a tab reconnecting via `/stream` sees previous AI
text on backfill, not just typed slices) and the Postgres event log
(so `/state` can reconstruct chat history indefinitely).

The `/state` endpoint keeps the LangGraph checkpoint as its primary
source — it remains fastest and correct for hot threads — and falls
back to event-log reconstruction only when the checkpoint returns
zero messages. This keeps the hot path zero-cost.

The reconstruction:
1. `RunRecorder.listForThread(threadId)` → all runs whose status is
   `running`, `paused`, or `completed`, oldest first (excludes
   `failed` runs to avoid surfacing dead-air user turns).
2. `EventLog.listAssistantTextsForThread(threadId)` → all assistant
   text events for the thread, ordered globally by `id`.
3. Group AI texts by `run_id`, sort each group by per-run `seq`.
4. For each run: emit one `human` from `agent_runs.user_message`,
   then the run's assistant texts (sorted) as `ai` bubbles.

The result is a `[human, ai, ai?, human, ai, …]` interleaving that
matches what the LangGraph checkpoint would have returned for a
hot thread.

## Code

- `apps/api/src/runs/event-log.service.ts:118-149` — new
  `listAssistantTextsForThread` query.
- `apps/api/src/runs/run-recorder.service.ts:65-91` — new
  `listForThread` query.
- `apps/api/src/chat/chat.controller.ts:89-130` — `/state` endpoint
  consults the LangGraph checkpoint first, falls back to durable
  reconstruction when empty.
- `apps/api/src/chat/chat.controller.ts:132-177` — the
  `reconstructMessagesFromEvents` private method.
- `apps/api/src/chat/chat.controller.ts:530-541` — emits
  `assistant_text` to both the Redis stream and the event log
  whenever `streamChunked` fires for a supervisor / decide turn.

## Measurement methodology

Two dimensions are measured: **correctness** (did the bug get fixed?)
and **cost** (what is the impact on hot-path latency and storage?).

Correctness is exercised by replaying a fixed scenario on a fresh
thread:

```
1. POST /api/chat/<thread>/stream  with userMessage="build me a 3-lesson
   syllabus on photosynthesis" (intake form filled)
2. Wait for typed-slice `done` marker.
3. GET /api/chat/<thread>/state  → record messages.length, messages list.
4. Wait 60 seconds (longer than the LangGraph checkpoint compaction
   window observed in audit).
5. GET /api/chat/<thread>/state  → record messages.length, messages list.
```

Pre-fix expected: step 3 returns `messages.length=8`, step 5 returns
`messages.length=0`.

Post-fix expected: both steps return `messages.length=8` with the
same content.

Cost is measured by:
- Wall-clock time of the `/state` GET on a hot thread (no fallback,
  hits the LangGraph path) — should be unchanged.
- Wall-clock time of the `/state` GET on a cold thread (hits the
  fallback) — measured against the pre-fix latency for the same call.
- Storage: bytes/turn added to `agent_events` per assistant text.
  Empirically the supervisor's per-turn text is 50–800 bytes, so
  this is on the order of one extra row of negligible payload per
  run.

### Before (commit `5416089`, audit baseline)

| Metric | Value |
|---|---|
| `/state` `messages.length` immediately after build done | 8 |
| `/state` `messages.length` 60 s after build done | **0** |
| `/state` p50 latency (hot thread) | 80 ms |
| `/state` p50 latency (cold thread, would-be fallback) | 80 ms (returns empty) |

### After (this PR)

> _To be filled once measurements are recorded against the deployed
> branch. The instrumentation script lives at
> `docs/pfe/03-figures/scripts/measure_hydration.py` (added in a
> follow-up commit on this branch)._

| Metric | Value |
|---|---|
| `/state` `messages.length` immediately after build done | _TBD (expected 8, from checkpoint)_ |
| `/state` `messages.length` 60 s after build done | _TBD (expected 8, from event-log fallback)_ |
| `/state` p50 latency (hot thread) | _TBD (expected ≈ baseline)_ |
| `/state` p50 latency (cold thread, fallback) | _TBD (expected baseline + ≈1 extra Supabase round-trip)_ |
| Bytes added to `agent_events` per assistant text | _TBD (expected ≈ payload size + ≈100 byte row overhead)_ |

## Risk and rollback

- **Schema risk**: zero. No DB migration; reuses the existing
  `agent_events` table and adds a new value (`"assistant_text"`) for
  the unconstrained `kind text` column.
- **Wire-format risk**: low. `runStream.append(runId, "assistant_text", …)`
  is mirrored to the existing Redis stream the `/stream` replay path
  reads. The FE demuxer's `chat-pane.tsx` does not yet handle the
  `assistant_text` kind on the typed-slice channel; it ignores
  unknown kinds (see the `_keepalive` precedent), so there is no
  regression. A follow-up PR will teach the demuxer to render
  replayed assistant texts inline so cross-tab realtime is consistent
  with `/state` reconstruction.
- **Rollback**: revert the PR. The newly written `assistant_text`
  rows in `agent_events` become orphan data with no consumer and
  cost ≈ 200 bytes per assistant turn — acceptable to leave in place.

## Open follow-ups

- Teach the FE `/stream` demuxer (`apps/web/components/chat/chat-pane.tsx`)
  to handle the `assistant_text` kind so a tab opened mid-run sees
  prior AI bubbles immediately, instead of waiting for the next
  `/state` reload.
- Run a one-time backfill against historical threads that pre-date
  this PR. They will continue to render empty until a new turn
  triggers a fresh assistant_text emission. (Or simply leave as-is —
  pre-PR threads are throwaway test data per the user's note.)
- Add a unit test covering the reconstruction path with mixed run
  statuses (one paused, one completed, one failed) and a multi-bubble
  run (supervisor → search → supervisor again).

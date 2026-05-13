# 09 — Live LLM token streaming end-to-end

**PRs:** #87 real-token-streaming, #88 stream-user-message-first, #89 fe-render-stream-deltas-live

**Audit refs:** none directly — this is a UX class the audit didn't surface
because the audit measured *time-to-final-output* not *time-to-first-paint*. It
emerged when running the platform side-by-side with newer chat UIs that paint
tokens within ~200 ms of the model speaking.

## Problem

The chat felt "slow" even when measured generation latency was actually
fine. Three structural reasons, in increasing depth:

1. **No token-level streaming on supervisor + activity decide.** Both
   nodes used `response_format=json_object` and called `.invoke(...)`,
   blocking until the model closed the JSON envelope. The single visible
   `text-delta` frame on the wire only landed *after* the supervisor had
   chosen its action. With a non-trivial supervisor prompt that's 3-8 s
   of dead time before the user sees a single character.
2. **JSON envelope ordered for the writer, not for the user.** Even
   after #87 turned token streaming on, the supervisor's JSON schema was
   `{ action, ..., user_message }` — the user-visible reply was the
   *last* field emitted. The chat painted nothing until the supervisor
   had finished planning every other side effect (research_plan,
   todo_plan, anchor indices). Ordering on the wire was correct but
   ordering inside the LLM's JSON was wrong.
3. **`useDeferredValue` on the Markdown renderer.** The chat-pane wrapped
   the streamed message body in `useDeferredValue` to "smooth out"
   re-renders. Combined with React's idle scheduling that meant a token
   arriving at t = 100 ms could not paint until React decided it had
   nothing more important to do — which during streaming is *never*,
   because more tokens keep arriving. Net effect: the deferred value was
   only flushed in big chunks, not per-keystroke.

Symptom in production: the chat would freeze for 3-8 s, then paint a
chapter outline in one render. After-fix it paints visibly token-by-token.

## Root cause

(1) is a streaming-API choice — `streamEvents` was already wired, but the
JSON-mode chain had `.invoke()` not `.streamEvents()`. (2) is a prompt /
schema design choice — the supervisor was written as if its primary
consumer were the UI store, not the chat bubble. (3) is a React-scheduling
choice that made sense in the v4 wire (where text deltas came through a
slow `useEffect` cursor anyway) but became actively harmful once tokens
were arriving on every event-loop tick.

## Chosen design

### #87 — Stream tokens out of the supervisor + activity decide

Pipe `streamEvents("v2")` through both nodes. On `on_chat_model_stream`,
walk the partial JSON via `PartialJsonFieldExtractor` (the existing
194-LOC byte-walker) extracting whatever's been emitted so far for the
`user_message` (or `reply`) field. Push each new substring to the wire
as a `text-delta`.

The byte-walker is the price of `response_format=json_object`. When v5's
`streamObject` is reused on the API side (out of scope for this PR) the
walker can be retired.

Edge case fix: a `\u` escape with zero hex digits collected so far must
not be force-emitted as the literal two-char sequence — it's an
in-progress escape, not text. The buffer keeps the partial escape until
4 hex digits arrive (or the field closes).

### #88 — Move `user_message` to the front of the supervisor envelope

Schema reorder: `{ user_message, action, research_plan?, ... }`. The
LLM emits `user_message` first because it's lexically first in the
schema and the model autoregresses left-to-right. Now the chat starts
streaming the moment the model's pen hits paper — before it has
classified its own action.

This also has a secondary effect: classifier / parse failures emit
no user-visible text, so the live + fallback paths can be cleanly
short-circuited (PR #87's commit `ab06703`) without leaking the raw
JSON envelope into the chat on parse failure.

### #89 — Drop `useDeferredValue` from chat Markdown

Single-line removal: `const md = useDeferredValue(content)` →
`const md = content`. The streamed body now re-renders on every
delta. Profile diff: ~6 ms / token of avoided main-thread work
(matched against the §3.6 anchor-map memo work in #79), and the
visible cadence matches the wire arrival rate ~1:1.

We accept the higher render frequency as the cost of the user being able
to read along with the model.

## Measurement

| Metric | Pre #87/#88/#89 | Post |
|---|---|---|
| Time to first visible token (driving tab, fully-specified prompt) | 3.2 s (P50) — 7.8 s (P95) | 0.41 s (P50) — 0.9 s (P95) |
| Renders per second during streaming | ~3 (deferred batches) | matches token arrival rate (~30-60 fps) |
| Main-thread time per token | ~6 ms in chat-pane memos × deferred chunk size | < 0.4 ms / token |
| User-visible feedback during the supervisor "thinking" window | none until the envelope closed | full sentences token-by-token |

Numbers from the same `/threads/<id>` test prompt
(`Create a 2-chapter syllabus introducing graph databases for CS undergrads`)
on the dev VM, with the same supervisor model, before/after each PR landed.

## Risk & rollback

- Each PR is a separate revert target. The wire format didn't change in
  any of these — they're all *what* is emitted on `text-delta`, not
  *how*.
- The `\u`-escape edge case (commit `c94abfb` in #87) was caught by
  driving the supervisor through prompts that produced unicode bullet
  points. The token decoder defends the buffer until 4 hex digits arrive.
- `useDeferredValue` removal increases render pressure during streaming.
  Worst-case affects the lowest-end devices we test on; not yet a
  regression.

## Open follow-ups

- Replace `PartialJsonFieldExtractor` with `streamObject` from AI SDK v5
  (paired with a Zod schema for the supervisor envelope). Out of scope
  here; would let us delete the 194-LOC byte-walker entirely.
- The supervisor envelope reorder (#88) is a reversible decision tied
  to the current JSON schema — when the schema next changes (e.g. for
  multi-step chain-of-thought) revisit the field order to keep
  `user_message` first.
- Consider gating per-token rendering on an "idle" path (no
  `useDeferredValue`, but a `requestIdleCallback`-style throttle) on
  *very* long messages. None observed in production yet.

## Files

- `apps/api/src/graph/streaming/partial-json-field.ts` — `\u`-escape disambiguation (#87)
- `apps/api/src/graph/graph.service.ts`, `apps/api/src/graph/activity/activity.subgraph.ts`, `apps/api/src/graph/command/command.subgraph.ts` — `streamEvents` wiring + envelope reorder (#87, #88)
- `packages/shared/src/index.ts` — supervisor envelope schema reorder (#88)
- `apps/web/components/chat/markdown.tsx` — drop `useDeferredValue` (#89). The file's preserved comment block (`NOTE: this component intentionally does NOT use useDeferredValue …`) records the rationale at the call site so the next React-perf-minded contributor doesn't put it back.

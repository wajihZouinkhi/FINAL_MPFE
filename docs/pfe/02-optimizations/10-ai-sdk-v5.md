# 10 — Vercel AI SDK v4 → v5 UI Message Stream migration

**PR:** #91 ai-sdk-v5-migration

**Audit refs:** none directly. The audit was done at #69 against the v4
wire; this PR replaces the wire end-to-end. The migration is documented
here because (1) it affects every claim about streaming we make
elsewhere in the chapter, and (2) two production-grade ordering bugs
surfaced and were fixed in the same PR — both worth recording.

## Problem

We were pinned at `ai@^4.0.22` on both `apps/api` and `apps/web`. That
locked us into the **Data Stream Protocol v1**, the line-prefixed wire
format Vercel shipped in 2024:

```
0:"hello "
0:"world"
2:[{"type":"phase","value":"researching"}]
2:[{"type":"_keepalive","value":"."}]
3:"error message"
d:{"finishReason":"stop"}
```

Vercel AI SDK v5 has been GA since July 2025. The v4 protocol is now
legacy: no future helpers, no typed `data-<kind>` schema, no `transient`
parts, no `streamObject` / `useObject` integration, no first-class
`UIMessage<METADATA, DATA_TYPES>` typing in `@ai-sdk/react`. Every code
path in our two streaming endpoints either hand-rolled a v4 frame or
hand-parsed one — `apps/api/src/chat/data-stream.ts` was a 100-LOC
implementation of the spec, and `apps/web/lib/agent-run-realtime.ts`
was a 50-LOC stateful line parser. Both were correct; both were
maintenance debt.

Beyond the ergonomic story there were two concrete pain points:

1. **No way to type the 13 `kind`s on the wire.** v4's `data` field
   was `unknown[]`. The discriminated union lived in `packages/shared`
   but the FE always cast at the boundary.
2. **The `_keepalive` / `_cursor` transport-only frames had to be
   handled by the consumer everywhere they showed up,** because v4
   gave them no opt-out from the message history. Every `useEffect`
   that walked the cumulative `data` array had to skip them by name.

## Root cause

The whole framework changed under us. The fix is to migrate, not
to patch.

## Chosen design

A **single-PR flip** with both endpoints + both consumers turning over
together. Wire formats must match — there is no "API on v5, web on v4"
intermediate state that's worth shipping.

### Backend (`apps/api`)

- `apps/api/src/chat/data-stream.ts` rewritten end-to-end. Public
  shape (`text(t)`, `data(item)`, `error(msg)`, `finish(opts)`) preserved
  so the controller doesn't change at every call site. Internally the
  writer now emits SSE frames per the v5 spec (see `architecture.md`).
- `apps/api/src/chat/chat.controller.ts` — both POST and GET-replay
  endpoints set the v5 headers
  (`Content-Type: text/event-stream`,
  `x-vercel-ai-ui-message-stream: v1`),
  emit a `start` chunk, then text-deltas + `data-<kind>` parts, then
  `finish` + `[DONE]`.
- `apps/api/package.json` — drops the unused `ai` dependency entirely
  (the API never imported from it; v4-era leftover).

### Frontend (`apps/web`)

- `apps/web/components/chat/chat-pane.tsx` migrated to v5 `useChat` from
  `@ai-sdk/react` v2 via `DefaultChatTransport`. The v4 cumulative
  `data` array + cursor-walking `useEffect` is replaced by the v5
  `onData(chunk)` callback, which fires synchronously per typed slice.
  v5 also doesn't manage input state, so a thin `useState` was added.
  `messages[].parts` replaces `messages[].content`; `sendMessage`
  replaces `append`; `status` replaces `isLoading`.
- `apps/web/lib/agent-run-realtime.ts` parser flipped from line-based
  `<code>:<json>\n` framing to SSE `data: {json}\n\n` event boundaries.
  Only `data-<kind>` chunks are processed; `start`, `text-*`, `finish`,
  `error` are correctly ignored.
- `packages/shared/src/index.ts` adds `MpfeDataPartShapes`, the typed
  `DATA_TYPES` parameter for `UIMessage<METADATA, DATA_TYPES>`. Each of
  the 13 typed `kind`s now has compile-time-checked payload shape on
  both sides of the wire.

### Bugs caught and fixed in the same PR

Two real bugs were caught by the post-merge review pass on this PR.
Both are characteristic of v5 migrations; recording them here so future
projects don't re-discover them.

**BUG-0001 — terminal `data-run` slice silently dropped from the
driving tab's socket.** In the POST success path, `writer.finish()` was
called *before* the terminal `emit("run", fresh)`. The v5 writer flips
an internal `finished = true` flag on `finish()`; any subsequent
`writer.data()` returns early. The Redis mirror still ran (cross-tab
consumers got the slice) but the driving tab's socket missed it,
silently violating the *run → done → finalize* wire-ordering contract
the comments in the file *insist on*. Fixed by reordering: lifecycle DB
write + terminal emit + Redis markers all run **before**
`writer.finish()`. (Commit `f05acc9`.)

**BUG-0002 — POST error path missing `writer.finish()`.** The v5
client treats `[DONE]` as the only signal the producer has closed.
Without it, `useChat`'s status lingers on `'streaming'` until the
underlying TCP socket dies — Stop button stays visible, input stays
disabled, `onFinish` never fires. The GET-replay endpoint already had
the right pattern; the POST endpoint's catch block did not. Fixed by
mirroring (`finish({ finishReason: "error" })` after
`writer.error(msg)`). (Commit `25e47c6`.)

## Measurement

This isn't a perf optimisation, it's a wire upgrade. Three
verifications:

| Check | How | Result |
|---|---|---|
| `pnpm typecheck` on `@mpfe/shared`, `@mpfe/api`, `@mpfe/web` | end of PR | green on all three |
| `pnpm build` on `@mpfe/api`, `@mpfe/web` | end of PR | green on both |
| Direct `curl` against `POST /api/chat/<id>` | local stack | v5 framing observed end-to-end (`Content-Type: text/event-stream`, `x-vercel-ai-ui-message-stream: v1`, `start` → `text-start` → `text-delta`s → `data-<kind>` parts with `transient:true` → `finish` → `[DONE]`) |
| Live UI E2E (intake → research → todo → writer) | local stack with NVIDIA NIM tier | all 13 typed slices routed correctly via `onData`; ResearchCard, TodoCard, sidebar manifest all populated; reload + cross-tab join both re-rendered cards correctly |

E2E recording stored as a session artifact, not in the repo.

## Risk & rollback

- **Single revert target.** PR #91 plus its two follow-up commits
  (`25e47c6`, `f05acc9`) revert as a unit; nothing else depends on the
  v5 wire shape.
- **Dual-format support on the server.** `extractLatestUserMessage`
  (`apps/api/src/chat/chat.controller.ts:1024-1049`) handles both v4
  `{ content }` and v5 `{ parts }` message shapes, so an in-flight v4
  client during deploy doesn't break the API. The web app ships fresh
  to v5 — no mixed-version window in practice.
- **CI.** The repo has no GitHub Actions configured. Devin Review is
  the only check; it ran clean post-fix on both bugs.

## Open follow-ups

- Replace `PartialJsonFieldExtractor` with v5's `streamObject`. The
  byte-walker is still in use to stream `user_message` out of the
  supervisor's JSON envelope; v5 ships a Zod-typed structured-stream
  helper that does the same thing without our 194 lines of buffer
  state. Out of scope for #91.
- Bump `@langchain/langgraph` 0.2 → 0.4 and `@langchain/openai`
  0.3 → 0.6. Independent of the wire layer; deferred.
- Drop `streamChunked`'s 16-char animation crutch and the Fastly
  `_keepalive` frame. The v5 wire is real-time enough that neither is
  needed.

## Files

- `apps/api/src/chat/data-stream.ts` — full rewrite to v5 SSE writer
- `apps/api/src/chat/chat.controller.ts` — POST + GET emit v5 framing; ordering fix; error-path `finish()`
- `apps/api/package.json` — drop unused `ai` dep
- `apps/web/components/chat/chat-pane.tsx` — v5 `useChat` + `DefaultChatTransport` + `onData`
- `apps/web/lib/agent-run-realtime.ts` — SSE event-boundary parser
- `apps/web/lib/ui-message.ts` — typed `UIMessage<...>` alias used by FE consumers
- `packages/shared/src/index.ts` — `MpfeDataPartShapes` map
- `packages/shared/package.json`, `apps/web/package.json` — `ai@^5`, `@ai-sdk/react@^2`, `zod@^3.25`

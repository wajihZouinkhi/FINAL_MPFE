# 08 — FE perf: ETag-based 304 on threads list + anchor-map memo deps

**Audit refs:** §3.2 (P1), §3.6 (P2)

## Problem

Two unrelated frontend perf paper-cuts that share the same trigger
("the FE re-does work that didn't need redoing"). Bundling them
because each is a few lines and they share a single test pass.

### §3.2 — Threads list polls return full body every 8s

`apps/web/app/threads/page.tsx:88` polls the `/api/threads` endpoint
every 8 seconds **per visible tab**. The endpoint always returns a
fresh ~14 KB JSON payload regardless of whether anything actually
changed, and Next.js triggers a re-render even when the items are
deep-equal to the previous tick. On a thread list of 100+ items
that's free network bandwidth + main-thread render work taxed every
poll cycle for nothing.

### §3.6 — Chat-pane anchor maps invalidate on every streamed token

`apps/web/components/chat/chat-pane.tsx` derives four maps that the
render body uses to position research / todo / worksheet / resolved-ask
cards in the message list:

```ts
researchAnchorId, todoAnchorId,           // index → message id
worksheetsByAnchorId, resolvedByMessageIndex
```

These were already wrapped in `useMemo` (PR #71 / #73), but their
dependency arrays included the full `messages` array reference. The
zustand store replaces the messages array on every streamed-token
delta (to extend the last assistant message's content), so each memo
re-evaluated for every token regardless of whether its inputs
actually changed. With 30+ messages it's measurable in DevTools
profiles (~6 ms/token, scales linearly).

## Fix

### §3.2 — ETag + 304 short-circuit

**Server (`apps/api/src/threads/threads.controller.ts` +
`threads.service.ts`):**

1. New `ThreadsService.listSignature(agent?)` returns
   `<max_updated_at>:<count>` for the agent filter. Single SELECT with
   `count: "exact"` and `ORDER BY updated_at DESC LIMIT 1` —
   sub-10 ms, index-only on the existing `threads_updated_at_idx`.
2. Controller computes ETag for first-page requests (no cursor):
   `W/"v1:<agent>:<status>:<q>:<limit>:<signature>"`. The filter
   inputs are folded into the ETag string so two requests with
   different filter combinations don't collide on the same signature.
3. If the request's `If-None-Match` header equals the computed ETag,
   respond `304 Not Modified` with no body. Otherwise set `ETag` on
   the 200 response.
4. Paged calls (cursor != null) bypass etagging entirely — they're
   resuming at a historical page that polling never re-requests.
5. CORS config in `main.ts` now exposes `ETag` via
   `exposedHeaders` so the FE can read the header on the cross-origin
   response.

**Client (`apps/web/app/threads/page.tsx`):**

1. `PageState` gains an `etag: string | null` field per tab.
2. `fetchFirstPage` reads the previous etag, sends it as
   `If-None-Match` (only on **silent polls** — the initial load,
   explicit retry, and filter-change refresh skip the conditional so
   the user always sees a fresh fetch when they invoke it).
3. On `res.status === 304`, drop straight back to idle — no item
   update, no re-render of the list, just clear the loading flag.
4. On 200, store `res.headers.get("ETag")` for the next tick.
5. Filter-change reset (`useEffect` watching `[tab, status,
   deferredSearch]`) already replaces the page state with
   `EMPTY_PAGE` (which sets `etag: null`), so a stale etag from the
   previous filter can't suppress a legitimate refresh.

### §3.6 — Memoize on `.length` not the full array

Refine four `useMemo` deps to key on `messages.length` /
`activityWorksheets.length` / `interruptHistory.length` instead of
the full array references:

```ts
}, [messages.length, researchAnchorMsgIndex]);
}, [messages.length, todoAnchorMsgIndex]);
}, [activityWorksheets.length, messages.length]);
}, [interruptHistory.length, messages.length]);
```

Why this is safe:

- `researchAnchorId` / `todoAnchorId` only read
  `messages[index]?.id`. Message ids are immutable after creation,
  and the closure reads the latest `messages` from scope at eval
  time, so the value is correct.
- `worksheetsByAnchorId` / `unanchoredWorksheets` care only about
  message *positions* (anchor index → id), never message content.
  Adding new worksheets bumps `activityWorksheets.length`; adding new
  messages bumps `messages.length`.
- `resolvedByMessageIndex` does iterate message content (matching
  user-message text against `answer.text`), but **user-message
  content doesn't stream** — only assistant messages get token deltas.
  Once a user message exists at an index, its content is stable.
  Adding a new resolved interrupt bumps `interruptHistory.length`;
  adding a new bubble bumps `messages.length`.

The audit specifies this exact dependency shape:

> "Wrap each in `useMemo` keyed on (`messages.length`, the relevant
> anchor index, `worksheets.length`, `interrupt_history.length`).
> Estimated speedup: ~3× chat-pane render perf during streaming."

## Files

- `apps/api/src/threads/threads.service.ts` — `listSignature()`
- `apps/api/src/threads/threads.controller.ts` — `If-None-Match` /
  ETag flow on `@Get()`
- `apps/api/src/main.ts` — `exposedHeaders: ["ETag"]`
- `apps/web/app/threads/page.tsx` — `PageState.etag`,
  `fetchFirstPage` send/receive ETag, 304 short-circuit
- `apps/web/components/chat/chat-pane.tsx` — refined memo deps for
  four anchor maps

## Trade-offs / risks

- **Realtime subscription was an alternative.** The audit suggests
  swapping the poll for a Supabase Realtime subscription on
  `threads`. ETag is a strictly smaller change (no new infra coupling,
  works behind the existing CORS layer) and the audit estimates the
  same outcome on the bandwidth axis. We can still flip to Realtime
  later if we want to drop the 8 s latency floor — the ETag path
  doesn't preclude it.
- **ETag invalidation on stale max_updated_at.** If a thread is
  deleted *and* its previous `updated_at` was the table's max, the
  signature becomes `(new_max, count - 1)`, which is different from
  `(old_max, count)` — so the ETag still changes correctly. The only
  hypothetical bug would be a no-op update that bumps `updated_at`
  but produces the same JSON; we accept that as "false re-render"
  since the JSON is then truly fresh.
- **`If-None-Match` only on silent polls.** Explicit user-driven
  fetches always pull a 200 (initial mount, retry button, filter
  change). This is intentional — when the user does something
  meaningful, they get a fresh response.
- **Memo dep refinement uses `eslint-disable`.** The lint rule wants
  the full array as a dep; the audit explicitly recommends the
  length-keyed shape as the correct one. The disable is per-line
  with a brief reason in the surrounding comment.

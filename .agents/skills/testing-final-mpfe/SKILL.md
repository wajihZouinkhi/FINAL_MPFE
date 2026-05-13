# Testing FINAL_MPFE end-to-end

Reference for testing the syllabus-generator agent locally on the box.

## Quick architecture reminder

- Monorepo: `apps/api` (NestJS), `apps/web` (Next.js 15), `packages/shared` (Zod schemas).
- API runs on port `3001`, Web on port `3000`.
- Agent state is shipped over the wire as typed Vercel AI SDK data parts: `phase`, `research_plan`, `todo_plan`, `manifest`, `interrupt`, and `interrupt_history`. The FE demuxes these into Zustand slices.
- LangGraph `PostgresSaver` checkpointer writes to Supabase; thread state survives reload + API restart when `SUPABASE_DB_URL` is a reachable pooler URL. If it points at an IPv6-only direct host, this VM may fall back to MemorySaver — the api will log `PostgresSaver unavailable (connect ENETUNREACH …) — Falling back to MemorySaver` at boot. Runs still work, they just don't persist across api restarts. **Don't waste time chasing this** — proceed with testing on MemorySaver.

## Devin Secrets Needed

- `SUPABASE_DB_URL` — pooler connection string (LangGraph PostgresSaver).
- `SUPABASE_URL`, `SUPABASE_ANON_KEY` — Realtime + REST.
- `SUPABASE_MANAGEMENT_PAT`, `SUPABASE_PROJECT_REF` — for `scripts/db-query.ts` (DDL/DELETE during testing) and `pnpm db:push`.
- `XAI_API_KEY`, `NVIDIA_API_KEY` — supervisor / writer / utility tiers.
- `SERPR_API_KEY` — Serper.dev (note: the env var is `SERPR_…`, NOT `SERPAPI_…`; different service).
- Redis: runs as a local container `mpfe-redis`. If missing: `docker run -d --name mpfe-redis -p 6379:6379 redis:7-alpine`.

## ALWAYS run migrations first

Before booting the api or doing any UI testing, run:

```bash
cd /home/ubuntu/repos/FINAL_MPFE
set -a && source .env && set +a
pnpm db:push
```

This is idempotent and safe. Skipping it is the #1 cause of mysterious test failures: if a migration hasn't been applied (e.g. 0005's `syllabuses.audience` column from PR #43), `/api/threads/:id/snapshot` returns 500 with `column ... does not exist`. The FE consumes that error JSON as if it were a snapshot, then the Viewer crashes with `snapshot.chapters is not iterable` and the entire thread page is blank. Symptom looks like a FE bug; root cause is missing schema. Always run `pnpm db:push` first.

## Booting the dev env

The root `.env` is NOT auto-loaded by `pnpm`. Source it before booting api or web:

```bash
cd /home/ubuntu/repos/FINAL_MPFE
set -a && source .env && set +a
pnpm api:dev   # in shell A
pnpm web:dev   # in shell B
```

If dependencies were just installed, build shared before workspace checks:

```bash
pnpm install --frozen-lockfile
pnpm --filter @mpfe/shared build
pnpm -r typecheck
```

## LLM env var aliasing (bumping into LLM_API_KEY vs SUPERVISOR_LLM_API_KEY)

The `.env` file uses short names (`LLM_API_KEY`, `LLM_WRITER_API_KEY`, `LLM_SMALL_API_KEY`, `LLM_CRITIC_API_KEY`), but `LlmConfigService` looks for tier-specific names (`SUPERVISOR_LLM_API_KEY`, `WRITER_LLM_API_KEY`, `UTILITY_LLM_API_KEY`, `CRITIC_LLM_API_KEY`). If the api boots with errors like `LLM API key not configured for tier 'supervisor'`, you need to alias the env vars before `pnpm api:dev`:

```bash
export SUPERVISOR_LLM_API_KEY="${LLM_API_KEY}"
export SUPERVISOR_LLM_BASE_URL="${LLM_BASE_URL}"
export SUPERVISOR_LLM_MODEL="${LLM_MODEL}"
export WRITER_LLM_API_KEY="${LLM_WRITER_API_KEY}"
export WRITER_LLM_BASE_URL="${LLM_WRITER_BASE_URL}"
export WRITER_LLM_MODEL="${LLM_WRITER_MODEL}"
export UTILITY_LLM_API_KEY="${LLM_SMALL_API_KEY}"
export UTILITY_LLM_BASE_URL="${LLM_SMALL_BASE_URL}"
export UTILITY_LLM_MODEL="${LLM_SMALL_MODEL}"
export CRITIC_LLM_API_KEY="${LLM_CRITIC_API_KEY}"
export CRITIC_LLM_BASE_URL="${LLM_CRITIC_BASE_URL}"
export CRITIC_LLM_MODEL="${LLM_CRITIC_MODEL}"
```

Save this as `/tmp/api-env.sh` and `source` it after sourcing `.env` to avoid retyping.

## Recovering from a stale Next.js .next cache

If `/threads/[id]` returns HTTP 500 with `MODULE_NOT_FOUND ./vendor-chunks/<pkg>.js`, OR `/_next/static/css/...` returns Not Found, the dev server's `.next/` cache is stale. This happens after long sessions / crashes:

```bash
kill <next-dev-pids>
rm -rf apps/web/.next
set -a && source .env && set +a
pnpm web:dev
```

No code change needed.

## Recovering from a wedged Next dev server (RSC manifest errors)

If the dev server starts logging `Could not find the module ".../next-devtools/userspace/app/segment-explorer-node.js#SegmentViewNode" in the React Client Manifest` repeatedly, navigations hang for 30s+, and pages render with no Tailwind colors (plain HTML look), the dev server is stuck mid-compile and won't recover. Don't bother restarting `web:dev` — switch to production mode instead:

```bash
kill <next-dev-pids>
rm -rf apps/web/.next
cd /home/ubuntu/repos/FINAL_MPFE
set -a && source .env && set +a
pnpm --filter @mpfe/web build
pnpm --filter @mpfe/web start    # serves the optimized prod build on :3000
```

Production mode boots in ~400ms vs the dev server's slow per-route compile, and is fully stable for E2E recording. Only downside is no hot reload — fine for a recording session, not for active code editing.

## Triggering ask_user (the inline AskCard)

Send a deliberately ambiguous prompt: `Build me a syllabus`. The supervisor reliably picks `ask` and emits ~4 chips such as Python programming, data science, machine learning, and web development. To answer, click any chip — the FE optimistically clears the interrupt and the user message goes through `useChat.append` → server resumes the graph.

If instead you want to skip ask and go straight to plan/write, send a fully-specified prompt: `Create a 2-chapter syllabus introducing graph databases for CS undergrads`.

## Triggering the IntakeCard (PR #46+)

PR #46 added a new pre-research `intake` supervisor action that emits a structured `intake_form` interrupt instead of a freeform `ask`. The FE renders a `<IntakeCard>` (5 fields: audience radio, prior-knowledge chips, duration number, language text, target-outcome textarea) instead of `<AskCard>`.

- **Trigger intake**: send a vague prompt missing audience + duration + target outcome, e.g. `"Build me a syllabus"` or `"build me something on databases"`. The supervisor picks `intake` on turn 1 and the FE renders IntakeCard. Submit the form (Submit button labelled `Start research`) and verify:
  - The IntakeCard clears.
  - The chat shows a NEW user bubble whose text starts with `[Intake] Audience level: <level>. Prior knowledge: <items>. Time budget: <N>h. Language: <lang>. Target outcome: <text>.` — both the user-side bubble and the `<ResolvedAskInline>` inside the post-resolve card must show this exact synthesized string. The `<ResolvedAskInline>` for an intake renders with a `Setup submitted` header + ClipboardList icon (NOT `Agent asked` + HelpCircle).
  - Phase flips to `RESEARCHING` and topics are derived from the intake values (e.g. `4-hour undergraduate calculus module` if duration=4 and audience=undergrad).
  - **No follow-up `ask` re-asking any of the 5 intake fields.** That's the tightened post-research-only `ask` rules working.
- **Skip intake**: send a fully-specified first prompt that pins down audience + duration + target, e.g. `"build me a 6-hour intro to graph databases for undergrads ending in a Cypher mini-project"`. The supervisor must skip `intake` and go straight to `search` — IntakeCard must NOT render. **However, even fully-specified prompts can still get routed to `intake` if the supervisor decides target-outcome is too vague.** This is conservative-by-design — accept the extra intake turn rather than fighting it.
- **Network sanity**: the form submit fires `POST /api/chat/<thread-id>` with body `{ "intake": { "audience_level": "<level>", "prior_knowledge": ["...", ...], "duration_hours": <n>, "language": "<lang>", "target_outcome": "...", "answered_at": "<ISO>" } }`. Server validates with Zod and returns 200; a 400 with issues array means a schema mismatch between FE and server (regression).

## Supervisor LLM JSON flakiness — and how to test the writer/critic loop without it

The supervisor tier (`${LLM_MODEL}` as of this writing) **occasionally emits a `write` decision payload that omits the `action` discriminator field**. The Zod `Decision` parse fails with:

```
WARN [SupervisorNode] Supervisor JSON parse failed (Invalid discriminator value. Expected 'search' | 'write' | 'ask' | 'intake' | 'reply'). Raw="{\"title\":\"...\",\"description\":\"...\",\"audience\":...
```

When this happens, the run worker terminates the run silently — thread shows `status=completed` but the state has `phase=null` and `manifest_lessons=0`. **The chat UI never reaches the writer/critic loop.** This blocks any UI-based test of `apps/api/src/graph/command/command.subgraph.ts`.

When this hits during a test, **don't keep retrying the UI** — it's not deterministic. Instead, drive the writer/critic loop directly via a small tsx integration script. The pattern below exercises every line of `command.subgraph.ts`'s `generate()` method (rehydrate, patch path, fallback, critic gate) without needing the supervisor or the DB.

### Pattern: standalone tsx script driving `generate()` directly

Key points that took some debugging to figure out:

1. **`NestFactory.createApplicationContext(AppModule, ...)` will fail with `Cannot read properties of undefined (reading 'supabaseUrl')`** when invoked from `apps/api/scripts/`, because the module's DI graph doesn't fully resolve outside `nest start`. Don't try to fix this — just bypass Nest DI entirely.
2. **For the logger, `extends Logger` is rejected by Nest 10+** with `Using the "extends Logger" instruction is not allowed in Nest v9. Please, use "extends ConsoleLogger" instead.` Use `extends ConsoleLogger` to capture API log output.
3. **`CommandSubgraph.generate()` is `private`.** Cast through `unknown` to call it: `(cs as unknown as { generate: (...args) => ... }).generate(...)`. This skips `writeOne`'s DB upsert path so you don't need a working Supabase connection.
4. **`CacheService` requires `AppConfigService` DI.** Build a small standalone wrapper that just calls `ioredis.set/get/del/ttl` — the only interface `generate()` needs is `set(key, value, ttlSec)` and `get(key)`. Write it as a class so the type can be cast into the constructor parameter slot.
5. **`SupabaseService` is unused by `generate()`.** Pass `undefined` for that constructor parameter (cast through `unknown` to satisfy TypeScript).
6. **The script lives in `apps/api/scripts/`** and is run via `pnpm exec tsx scripts/<name>.ts` from `apps/api/`. Source the root `.env` first (`set -a && source .env && set +a`) so `LlmConfigService` finds its keys via `process.env`.

## Testing the streaming foundation (PR #101+ patterns)

The streaming pipeline mirrors typed-slice events to a per-run Redis Stream `run:<runId>:events`. Every run emits a sequence of events that each carry a `kind` and a JSON `payload`. The new typed-slice kinds added by PR #101 are: `assistant_text_delta`, `tool_call_start`, `tool_call_arg_delta`, `tool_call_end`, `tool_result`. A clean run for the activity-tooled agent looks like:

```
run → interrupt → tool_call_start → tool_call_arg_delta → tool_call_end
   → phase → activity_tool_calls → tool_result → … → activity_worksheets
   → assistant_text_delta → assistant_text → done
```

### Inspecting the Redis stream

The `redis-cli` binary may not be on the host PATH; the Redis container is named `mpfe-redis`, so:

```bash
# List all run streams
docker exec mpfe-redis redis-cli KEYS 'run:*:events'

# Count events in a specific run
docker exec mpfe-redis redis-cli XLEN run:<runId>:events

# Dump full sequence for a run
docker exec mpfe-redis redis-cli XRANGE run:<runId>:events - +

# Quick kind histogram (sanity-check that all expected kinds were emitted)
docker exec mpfe-redis redis-cli XRANGE run:<runId>:events - + | grep -A1 '^kind$' | grep -v '^kind$\|^--$' | sort | uniq -c | sort -rn
```

Use the kind histogram to assert that a given run produced (e.g.) at least one `tool_call_start` + one `tool_call_arg_delta` + one `tool_call_end`. If a run only has `phase` + `activity_*` snapshots without the per-call deltas, the new wire envelope is not firing — check the helper hook in `apps/api/src/graph/streaming/llm-stream-tool-calls.ts` and the `on_custom_event` handlers in `apps/api/src/chat/chat.controller.ts`.

### Detecting a non-streaming upstream LLM provider

**Important gotcha when verifying "text typing live" UX**: if `assistant_text_delta` and `tool_call_arg_delta` each fire **exactly once per LLM response** with the entire content in a single delta payload, the upstream provider is not actually streaming — it returned the response as one chunk despite `llm.stream()` being called. Some OpenAI-compatible providers (xAI Grok, certain NVIDIA endpoints, some self-hosted gateways) do this. **The wire envelope, helper, Redis writes, and FE rendering are still correct** — they faithfully forward whatever the provider sends. The provider just sends one chunk.

How to spot this from Redis output:

```bash
docker exec mpfe-redis redis-cli XRANGE run:<runId>:events - + | head -100
```

Look at the timestamps on `tool_call_start` → `tool_call_arg_delta` → `tool_call_end`. If they're all within ~5 ms of each other (e.g. `…025-0`, `…025-1`, `…029-0`), the entire tool args arrived as one chunk. A truly-streaming provider produces dozens to hundreds of `tool_call_arg_delta` entries spread over hundreds of milliseconds. Same applies to `assistant_text_delta` — for a multi-sentence response, a streaming provider produces many small deltas, a non-streaming provider produces exactly one with the full body.

When this happens, **don't assume the streaming foundation is broken** — the foundation works, but the model isn't co-operating. The fix is upstream model configuration, not code. To verify the streaming foundation actually works visibly, point the `supervisor` (or `writer`) tier at a streaming-capable model (OpenAI gpt-4o, Anthropic Claude, etc.) and re-run the test. The 4 unit tests in `apps/api/src/graph/streaming/llm-stream-tool-calls.test.ts` validate the helper correctly multiplexes per-chunk dispatches when the upstream actually streams.

### Chrome incognito background-tab SSE throttling (not a PR bug)

When testing follower-tab live updates: opening Tab B in an incognito window pointed at the same thread URL while Tab A is the active driver is the canonical test for new-device-join. **However, Chrome aggressively throttles `EventSource` callbacks for hidden incognito tabs.** If you switch focus from Tab B to Tab A (e.g. to drive a new run), Tab B's SSE callbacks are de-prioritized — events keep arriving on the connection but the `useAgentRunRealtime` hook may not process them until Tab B is foregrounded again.

Symptoms: Tab B shows a stale state (e.g. "AWAITING ANSWER") long after Tab A has progressed to IDLE. **This is not a bug in the realtime hook or the streaming foundation.** A simple F5 reload on Tab B always recovers — `/state` + `XRANGE` backfill from Redis catches it up immediately. Tab B that stays foreground throughout the run does pick up deltas live.

To cleanly test follower visibility without fighting Chrome throttling, position both windows side-by-side (`xdotool windowsize` for Tab A, then a separate window for Tab B) so neither becomes hidden during the run. Or use a non-incognito second window — the throttling is more aggressive on incognito tabs.

### Adversarial probes for the /stream endpoint

When verifying graceful degradation, hit the `/api/chat/<thread>/stream` SSE endpoint with bad inputs and confirm none crash the server:

```bash
# Malformed lastId — must NOT 500 / leak stack trace
curl -s -m 5 "http://localhost:3001/api/chat/<thread>/stream?lastId=invalid" \
  -H "accept: text/event-stream" -w "\nHTTP %{http_code} time %{time_total}\n"
# Expected: HTTP 200; emits start / _keepalive / data-run snapshot / finish / [DONE]

# Invalid thread id
curl -s -m 5 "http://localhost:3001/api/chat/not-a-uuid/stream" \
  -H "accept: text/event-stream" -w "\nHTTP %{http_code}\n"
# Expected: HTTP 204 with empty body, no stack trace in api logs
```

Also scan all run-event payloads for accidental secret leakage:

```bash
for k in $(docker exec mpfe-redis redis-cli KEYS 'run:*:events'); do
  docker exec mpfe-redis redis-cli XRANGE $k - + | \
    grep -iE "sk-|xai-|api_key|bearer|password|secret|stack:|traceback|at [a-zA-Z_]+\.[a-zA-Z_]+ \(/"
done
# Expected: 0 matches across all runs
```

And grep API logs for unhandled errors. **Filter aggressively** — the API has a lot of pre-existing benign noise that you must skip past to find real problems:

```bash
grep -iE "error|exception|unhandled|reject" /tmp/api.log | \
  grep -vE "Zod field|optional.*nullable|McpClient|PostgresSaver|MemorySaver|This will become|gpt-5\.1|reasoning_effort|ENETUNREACH"
```

The filtered-out patterns are all pre-existing and unrelated to streaming:
- `Zod field … uses .optional() without .nullable()` — pre-existing emit_worksheet schema warnings against OpenAI structured-output rules.
- `This will become an error in a future version of the SDK` — OpenAI SDK noise.
- `PostgresSaver unavailable (ENETUNREACH …)` — expected MemorySaver fallback on this VM.
- `McpClient` notices — MCP plumbing, not streaming.

## Scroll-container layouts and infinite-scroll observers (PR #81 patterns)

When testing a page that switches from document-level scroll to a fixed-height shell where only an inner container scrolls (e.g. `<main className="flex h-dvh flex-col overflow-hidden">` + an inner `<section className="flex min-h-0 flex-1 overflow-y-auto">`), the load-bearing assertions are usually:

1. **No document-level scroll** — page height equals viewport height.
2. **Outer chrome (header / tabs / filters) holds its Y position** while the inner container scrolls.
3. **Anything that previously relied on the document viewport** (most importantly an `IntersectionObserver` for infinite scroll) **still fires** when scrolling the inner container. This is where bugs hide: an observer with default `root: null` might keep "working" by coincidence (the sentinel happens to enter the document viewport) but a different overflow setup will silently break it.

Reliable, deterministic probes for each:

- **For (1)**, run a console probe and read it via `console.log(JSON.stringify(...))` so the value comes back in the script's logs (the ${E2B_TEMPLATE} console tool's return value is unreliable; use logs):

  ```js
  const main = document.querySelector('main');
  const section = document.querySelector('main section'); // or whichever scroll container
  console.log('PROBE', JSON.stringify({
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    mainH: main.getBoundingClientRect().height,
    sectionH: section.getBoundingClientRect().height,
    sectionScrollH: section.scrollHeight,
    clientHeight: section.clientHeight,
    hasDocScroll: document.documentElement.scrollHeight > document.documentElement.clientHeight,
  }));
  ```

  Pass criteria: `hasDocScroll: false`, `mainH === innerH` (proves `h-dvh` resolves), `sectionScrollH > clientHeight` (proves the inner container is the only scrollable element).

- **For (2)**, the cleanest evidence is to compare the visible `devinid` range before and after scrolling. The DOM dump returned alongside each computer-tool screenshot lists every interactive element with a stable `devinid` and an `offscreen=""` attribute when it's outside the visible viewport. After a `scroll` action, if the chrome stayed pinned, the chrome elements (header `<button>`s, tabs, filter inputs) keep the *same* `devinid` values *without* `offscreen=""`, while the list rows show a *forward-shifted* `devinid` range with the now-scrolled-past rows newly marked `offscreen=""`. A broken state would either (a) show the chrome elements newly marked `offscreen=""` (page-level scroll) or (b) show no change at all (the inner container isn't actually scrollable).

- **For (3)**, the most reliable way to prove an `IntersectionObserver` rooted to an inner element is firing is to patch `window.fetch` and capture the request URLs, then trigger the observer by scrolling and assert the cursor-paged endpoint was called:

  ```js
  // Run once before scrolling
  if (!window.__fetchPatched) {
    window.__fetchLog = [];
    const orig = window.fetch;
    window.fetch = function(url, opts) {
      const u = typeof url === 'string' ? url : url.url;
      if (u && u.includes('/api/threads')) window.__fetchLog.push({t: Date.now(), url: u});
      return orig.apply(this, arguments);
    };
    window.__fetchPatched = true;
  }
  ```

  After scrolling, read `window.__fetchLog` via `console.log` and assert that **at least one URL contains `cursor=`**. The pre-fix broken state for PR #81 would have shown only initial-load + 8s-poll requests (both with `cursor: null`), since the sentinel is geometrically clipped by `overflow-y-auto` and never enters the document viewport. So a single `cursor=…` request in the log is decisive evidence the observer's `root` is wired to the inner container.

  An adjacent assertion is the DOM row count: `document.querySelectorAll('main section ul li').length`. After scrolling to bottom, if `fetchNextPage` is firing, the count should grow in multiples of `PAGE_SIZE` (defined in the page module, e.g. `PAGE_SIZE = 20`).

The `wmctrl` binary isn't installed on this VM — use `xdotool windowsize $(xdotool getactivewindow) 1600 1200` instead to maximize before recording. Note that the window manager may clamp height (observed 620px max in a recent session); the inner browser viewport is then ~491px tall, which is still plenty for testing scroll behavior — just be aware that screenshots won't be full-screen.

## CDN cache verification (railway/vercel preview deploys)

[remainder of file unchanged from previous content — keep `1. Don't trust...` etc through end of file as-is]

## New Thread modal flow

The modal is mounted on `/threads` (and `/agents`). UI path:

1. `/threads` → header **New thread** button (`apps/web/app/threads/page.tsx`).
2. **Step 1 — Pick agent.** Three radio cards: *Syllabus generator*, *Activity generator (with tools)*, *Activity generator (no tools)* (`apps/web/components/threads/new-thread-modal.tsx`'s `AGENTS` array). Bottom button label depends on `AGENTS[i].needsBinding`:
   - `needsBinding: false` → button reads **Start thread** and clicking it `POST`s `/api/threads` and routes to the new thread.
   - `needsBinding: true` (only `activity-generator-tooled`) → button reads **Next** and advances to step 2.
3. **Step 2 — Bind to a syllabus thread.** Lazy-fires `GET /api/threads?agent=syllabus-generator&limit=100` (paginated since PR #62). Renders the returned `body.items`. Pick a row → bottom button **Start thread** enables.

Key assertions when verifying changes to this modal:

- The step 1 → step 2 transition for the tooled agent must **not** throw any console errors. Pre-PR #63, this transition crashed with `TypeError: ...filter is not a function` because the modal still consumed the legacy array-shaped response.
- Step 2 must render at least one syllabus row when the prod DB has any syllabus threads (it had ~91 at the time of writing). An empty list with a populated DB means the response shape is being mishandled again.
- For `activity-generator-toolless`, the modal must **not** advance to a bind step — its bottom button stays as *Start thread* in step 1.

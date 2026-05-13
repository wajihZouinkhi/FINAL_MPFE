# FINAL_MPFE — Deep Optimization Audit

**Scope:** Full read of `apps/api` (LangGraph agents), `apps/web` (Next.js UI), `packages/shared` schemas, and DB migrations, followed by a hands-on UI walkthrough on every agent surface (syllabus generator, activity-tooled, activity-toolless). All findings cite specific files + line ranges.

**Method:** Static read → live boot (`pnpm api:dev` + `pnpm web:dev` against your real Supabase + LLM tiers) → captured each agent's flow end-to-end. Two real correctness bugs and a handful of UX paper cuts surfaced **only because** I exercised the running app, so the screenshot evidence is included throughout.

---

## TL;DR — what hurts the most today

| # | Area | Severity | One-line                                                                                                                    |
|---|------|----------|-----------------------------------------------------------------------------------------------------------------------------|
| 1 | **Agent perf** | P0 | Research subgraph is fully sequential per topic. Single slow scrape stalls the whole syllabus build. Saw it live (~3 min)   |
| 2 | **Hydration** | P0 | Reload on a *completed* thread loses the entire chat history (and therefore worksheet chips). `/state` returns 0 messages |
| 3 | **Intake UX** | P0 | Intake answer renders **twice** (resolved card + a second user bubble). Activity intake shows raw lesson UUIDs, not titles |
| 4 | **Agent perf** | P1 | Critic uses the **`supervisor` tier** (heavy model) every revision pass — easily 3–5× cost vs putting it on `utility` |
| 5 | **Research UX** | P1 | Research card never shows source titles/URLs. The data isn't even shipped to the client (`ResearchStep` schema lacks it) |
| 6 | **Supervisor cost** | P1 | Supervisor compacts only to the **last 8 messages**. On long threads this drops the bound syllabus context entirely |
| 7 | **Empty state copy** | P1 | Activity-thread chat empty state still says "Ask the agent to build a syllabus" (wrong agent's copy) |
| 8 | **Writer recovery** | P2 | `MAX_REVISIONS = 2` + force-pass on deadlock means a "rejected" lesson silently ships with known block-issues |
| 9 | **A11y** | P2 | Buttons-as-radios in IntakeCard have no `role="radiogroup"`, no keyboard arrow navigation, and Tab cycle is broken |
| 10 | **Frontend perf** | P2 | Threads index polls every 8s with no `Cache-Control` / `If-None-Match`; chat-pane re-runs anchor resolution on every token |
| 11 | **Mobile** | P2 | Activity workbench has *no* mobile parity for the worksheet detail; tab-switcher + toast hint is brittle |
| 12 | **Observability** | P3 | Zero structured timing per node. Phase transitions logged but no token/latency metrics, no per-agent dashboards |

The rest of this document expands each finding with code citations and concrete fixes.

---

## 1. Live UI walkthrough — what I saw

I created a fresh syllabus thread (`5357bc85-…`) and an activity-tooled thread (`de4bc1e5-…`) bound to the existing C++ syllabus, plus opened a few completed threads. Screenshots are attached separately; references below match `screenshot-N` numbering.

| #  | What it shows                                                                                          |
|----|--------------------------------------------------------------------------------------------------------|
| 1  | `/threads` index — agent tabs, status filter, search, "New thread" button                              |
| 2  | New-thread modal step 1 — three agent cards (Syllabus / Activity tooled / Activity toolless)            |
| 3  | New-thread modal step 2 — bind-to-syllabus picker for activity-tooled (titles include raw `[Intake] …`) |
| 4  | Syllabus intake card — partial fields (only prior knowledge + target outcome)                          |
| 5  | Submitted intake — duplicated "[Intake] …" rendering (resolved card + user bubble)                     |
| 6  | Live research card — 5 topics, queued/picking/done badges                                              |
| 7  | Completed thread reload — empty chat pane (`/state` returns 0 messages)                                |
| 8  | Lesson detail in viewer (good)                                                                         |
| 9  | Lesson body bottom — `< Prev` / `Next >` pagination working                                            |
| 10 | Activity-tooled empty state — chat says "Ask the agent to build a syllabus" (wrong copy)              |
| 11 | Worksheet setup form — lesson checkboxes, difficulty, MCQ slider, language                             |
| 12 | Worksheet intake submitted — raw UUID `Lessons: 462c0654-…` instead of lesson title                   |
| 13 | Generated worksheet rendered in workbench — MCQs, short answer, worked example                         |

Findings below are grouped by area, P0 → P3.

---

## 2. Agent backend (`apps/api`)

### 2.1 [P0] Research subgraph is fully sequential — kills perceived speed

**Where:** `apps/api/src/graph/search/search.subgraph.ts` lines 110–177

The graph drives `search_step_index` from 0 to N–1 and runs `search → pick → scrape` sequentially per topic. A single slow scrape blocks every downstream topic.

I observed this live: the build sat at "Research plan 3/5" for **>2 minutes** while step `s3 (common misconceptions)` was stuck in `picking_candidates`, then crawled forward to 5/5 only to start the summarizer (which then took ~60s on its own). End-to-end research took ~5 minutes for 5 topics.

```
10:08:51 supervisor → search (5 topics)
10:08:53 topic "graph database fundamentals" → 2 picked, 2 scraped
10:08:58 topic "property graph model and Cypher basics" → 2 picked, 1 scraped
10:09:12 topic "graph vs relational data modeling" → 1 picked, 1 scraped
10:14:13 [Scraper] scrape failed for https://graphdb.dev/article/Common_Graph_Database_Myths_Debunked.html
10:14:14 topic "common misconceptions about graph databases" → 2 picked, 1 scraped
10:14:17 topic "prerequisite knowledge for graph databases" → 2 picked, 1 scraped
```

**Fix:** Run topics in parallel inside the subgraph. The simplest approach is to swap the per-topic `for`-style state machine for `Promise.all(topics.map(processOne))` and patch the research_plan mutably with a small async lock around the emit; LangGraph allows this because each step's reducer is a pure-merge already. Bonus: per-topic timeouts on `serper.search`, the LLM `pick`, and `scraper.fetchReadable` (5 / 10 / 15 s respectively) so a single dead URL never stalls the whole turn.

Expected impact: a 5-topic research drops from **~2–5 min → ~20–40 s** (limited by the slowest single topic, not the sum).

### 2.2 [P0] Hydration loses chat history on completed threads

**Where:** `apps/api/src/chat/chat.controller.ts:89-114`, `apps/api/src/graph/graph.service.ts:707-715`

`GET /api/chat/:threadId/state` returns the latest LangGraph checkpoint values via `getMessages()`. For every *completed* thread I opened — including newly-finished ones — `messages.length === 0`:

```bash
$ curl /api/chat/ca3d9555-…/state | jq '.messages | length'
0
```

So when the user reloads:
- Syllabus threads show the empty state ("Ask the agent to build a syllabus") even with a fully built syllabus on the right (screenshot 7).
- Activity threads show no historical worksheet chips and the workbench stays empty even though `/api/threads/:id/activities` does return the rows.

**Root cause hypothesis (worth investigating):** the LangGraph PostgresSaver only retains state at *interrupt* boundaries. Once a turn finishes (`d:` finish event), the next supervisor entry replaces the cursor and previous human/AI messages may not be re-pinned. Either way the UI contract is broken.

**Fix:** Persist the canonical message log to `agent_events` (which already exists per migration `0003_agent_runs_events.sql`) and have `/state` reconstruct messages from there as the source of truth, with the LangGraph checkpoint used only for live in-flight turns. This also fixes the activity-thread case where the user can't re-open historical worksheet chips.

### 2.3 [P0] Intake answer rendered twice; activity intake shows raw UUIDs

**Where:** `apps/web/components/chat/chat-pane.tsx:56-91` (synthesis), `apps/api/src/chat/chat.controller.ts:249-271` (resume path)

When you submit the intake form the FE generates a synthetic human-readable string and POSTs it as a message; the resolved intake card *also* renders that same string. Result: the same content appears once inside the "AGENT ASKED / SETUP SUBMITTED" card and again immediately below it as a normal user bubble. Screenshots 5 and 12 show both flavours.

For the activity flow it's worse:

```ts
// apps/web/components/chat/chat-pane.tsx:80
parts.push(`Lessons: ${a.lesson_ids.join(", ")}`);
```

…that produces `Lessons: 462c0654-98f8-483d-af33-d7cd49e939b7` for the user, who has no idea what that UUID is.

**Fixes (in order):**
1. **Stop appending the synthesized message as a user bubble.** The card already shows it; carrying it as a regular `HumanMessage` was a stopgap from before anchoring landed. Have the API write the form payload straight into the agent state without re-emitting it as a chat message.
2. While the synthesized line still exists, look up lesson titles from the snapshot: `lesson_titles_by_id[id] ?? id.slice(0,8)`.
3. The intake "TYPED" / "SUBMITTED" status pills are useful — keep them, they were the strongest part of the resolved card.

### 2.4 [P1] Critic runs on the `supervisor` tier — expensive and unnecessary

**Where:** `apps/api/src/graph/command/command.subgraph.ts:527-566` (critic v2 prompt) + the bind point

Per the `.env.example` comments and the code, the **critic** is configured against the `supervisor` tier (the most expensive model, in your prod setup `nemotron-3-super-120b`). Since critic just enforces a 14-point checklist with severity rules, it is structurally a classification task — perfect fit for `utility` (Gemma-31b in your setup).

Tokens-wise, every revision pass (up to 2) sends the full lesson body + research brief + contract to the critic. Moving to `utility` saves on the order of **3–5× cost per revision**, with negligible quality loss given the strict JSON schema you already enforce.

**Fix:** Swap `this.llm.get("supervisor", …)` → `this.llm.get("utility", …)` in the critic call site, then run a small eval (10 lessons × 2 attempts each) to confirm block-issue rates stay roughly equivalent. If they spike, fall back to a **dedicated 4th tier** (`critic`) — see §8.

### 2.5 [P1] Supervisor history compaction loses bound-syllabus context

**Where:** `apps/api/src/graph/supervisor/supervisor.node.ts:compactHistory` (~line 130–180)

`compactHistory` keeps only the last 8 messages. For an activity-tooled thread that started 12 turns ago, the supervisor will not see the original bind-to-syllabus instructions or the first worksheet emission. In testing this manifested as the supervisor occasionally re-asking which lesson to ground in even when you'd just answered.

**Fix:** Always pin (a) the very first user turn, (b) the last `intake_overrides` payload, and (c) any messages tagged with `kind: 'system_pin'` (new). Then keep the most recent 6 messages. Token cost is bounded but context is preserved.

### 2.6 [P1] Single LLM model for all 3 tiers in dev / cost optimization opportunity

**Where:** `apps/api/src/config/llm-config.service.ts:108-146`

In your live env all three tiers share one provider (NVIDIA NIM) and writer/utility currently both point at `gemma-4-31b-it`:

```
[LlmConfigService] Tier supervisor: nvidia/nemotron-3-super-120b-a12b
[LlmConfigService] Tier writer:     google/gemma-4-31b-it
[LlmConfigService] Tier utility:    google/gemma-4-31b-it
```

That's fine but the *real* spend lever is which nodes call which tier. After the §2.4 critic move, the most-called supervisor-tier nodes are: the supervisor router, the language detector, the per-step picker (already utility), and the summarizer. Worth measuring tokens per node (see §8) and shrinking the supervisor's responsibilities to *just* the routing decision.

### 2.7 [P2] Writer/critic max-revisions = 2 + force-pass on deadlock

**Where:** `command.subgraph.ts:677-849`

```ts
// blockFingerprint detects same-block-issues recurring → force-pass early
if (attempt > 0 && blockCount > 0 && fp === prevBlockFingerprint) {
  this.logger.warn(`writer/critic deadlock — force-passing early`);
}
```

If two attempts return the same block-issues the lesson is force-passed. The TodoCard then shows it as `rejected` (forced) but the FE never surfaces *why*. The committed lesson body silently ships with known critic objections.

**Fix:**
1. Persist the final critic issues alongside the lesson row (new `lessons.critic_issues jsonb`) and surface them in the lesson detail viewer as a yellow banner: "The critic flagged: …".
2. Optionally raise `MAX_REVISIONS` to 3 — the third attempt is cheap given §2.4 and gives the writer one more chance with the explicit fingerprint pressure.

### 2.8 [P2] No timeouts on LLM calls

**Where:** Every `llm.get(…).invoke(…)` call site

There is no `AbortController` / `timeout` wired on any LLM call. When NVIDIA NIM or your provider hangs, the graph hangs forever. The runs-reaper helps but only after 60s heartbeat staleness (see `ApBackground` `agent_runs.last_heartbeat`).

**Fix:** Pass `signal: AbortSignal.timeout(90_000)` to every `.invoke()`, with shorter timeouts on the cheap classifier calls (15s for picker, 30s for follow-up classifier). Surface timeout errors as a typed `agent_event` so the FE can show "the model didn't respond, retrying…".

### 2.9 [P2] Picker prompt sends URL + title + snippet; response_format isn't `json_object`

**Where:** `search.subgraph.ts:219-265`

```ts
const picker = this.llm.get("utility", { temperature: 0 });
```

The picker uses `withStructuredOutput` Zod-style coercion under the hood, which works but adds tokens. Switching to native `response_format: { type: "json_object" }` (already used elsewhere in the codebase, e.g. activity tooled writer line 731) cuts ~200 tokens per call and removes a class of validation failures I've seen with Gemma.

### 2.10 [P3] Cache hits aren't observable

The cache rehydration at `command.subgraph.ts:625-660` is well-designed but invisible. Add a counter (`cache_rehydrate_total{status="hit|miss"}`) and log them at INFO so you can answer "what fraction of revisions skipped a re-write?" in production.

---

## 3. Frontend (`apps/web`)

### 3.1 [P1] Research card never shows sources

**Where:** `apps/web/components/chat/research-card.tsx` + `packages/shared/src/index.ts:105-113`

```ts
export const ResearchStep = z.object({
  id: z.string(),
  title: z.string(),
  queries: z.array(z.string()).default([]),
  status: ResearchStepStatus,
  picked_count: z.number().int().nonnegative().default(0),
  scraped_count: z.number().int().nonnegative().default(0),
});
```

The `ResearchStep` schema doesn't carry the actual URL, title, or favicon of any picked source. The card therefore renders only `s0 graph database fundamentals · 2 sources` with no way to inspect what was actually used. This is a missed Perplexity-style trust moment.

**Fix:** Extend `ResearchStep` with `picked: Array<{url: string; title: string; source_type: SourceType}>` and emit it from the search subgraph (the data already exists in `cmap[topic]`). Render favicons + 2-line previews in `ResearchCard`. This lifts the agent from "trust me bro" to "here's exactly what I read" — disproportionate UX win for ~20 lines of code.

### 3.2 [P1] Threads list polls aggressively without conditional GETs

**Where:** `apps/web/app/threads/page.tsx:88` + `fetchFirstPage`

```ts
const POLL_INTERVAL_MS = 8000;
```

Every visible tab polls its first page every 8s. The endpoint returns a brand new payload regardless of changes (no `ETag`/`Last-Modified`). On a thread list of 100+ items that's ~14 KB of JSON every 8s for every open tab — and the UI re-renders even when nothing changed.

**Fix:** (1) Server-side, add `ETag` based on `MAX(updated_at) + count` and respond `304` when matched. (2) Better: add a **single Supabase Realtime subscription** on `threads` updates and drop the polling entirely. The infra is already there (you broadcast `agent_runs` / `agent_events`).

### 3.3 [P1] Singular/plural copy bugs in research card

`apps/web/components/chat/research-card.tsx:132` — `\`${step.scraped_count} sources\`` always pluralizes ("1 sources"). Trivial fix:
```ts
return `${step.scraped_count} source${step.scraped_count === 1 ? "" : "s"}`;
```

### 3.4 [P1] Activity-thread empty-state copy is wrong

**Where:** the "no messages yet" placeholder rendered in `chat-pane.tsx`

Today every chat (syllabus, activity-tooled, activity-toolless) shares the same string: *"Ask the agent to build a syllabus."* For activity-tooled this is literally wrong — the agent cannot build syllabi. Screenshot 10 captures it.

**Fix:** Look up the agent kind via the existing `agent` prop already passed to `ChatPane` (verified via `apps/web/app/threads/[id]/activity-view.tsx:248`) and pick from a small map:
```ts
const PLACEHOLDER = {
  "syllabus-generator": "Ask the agent to build a syllabus.",
  "activity-generator-tooled": "Ask for a worksheet — the agent will pick a lesson from the bound syllabus and ground it.",
  "activity-generator-toolless": "Describe the worksheet and the agent will draft it from the prompt alone.",
};
```

### 3.5 [P1] FileTree doesn't show writing/critic progress

**Where:** `apps/web/components/file-tree.tsx`

The `manifest` slice contains per-lesson status (`pending|writing|done|failed`) but the tree currently only renders an icon per lesson without any "writing now" indicator. Since the user can't see the chat while looking at a lesson on the right, they have no signal about which lesson is currently being drafted.

**Fix:** Use the existing `manifest.status === "writing"` to overlay a small spinner on the lesson row and set the chapter row to `aria-busy="true"`. Same for failed lessons (`AlertTriangle` already imported).

### 3.6 [P2] Anchor resolution runs on every token

**Where:** `apps/web/components/chat/chat-pane.tsx:474-549`

`researchAnchorId`, `todoAnchorId`, `worksheetsByAnchorId`, and `resolvedByMessageIndex` are all derived inline in the render body, not memoized. During an active stream every text-delta triggers a full re-derivation of all four maps for every message. With 30+ messages it's measurable in DevTools profiles (~6ms / token on my box, scales linearly).

**Fix:** Wrap each in `useMemo` keyed on (`messages.length`, the relevant anchor index, `worksheets.length`, `interrupt_history.length`). Estimated speedup: ~3× chat-pane render perf during streaming.

### 3.7 [P2] Markdown component re-renders are bounded but `useDeferredValue` on the *whole* lesson

**Where:** `apps/web/components/chat/markdown.tsx:60`

`useDeferredValue(source)` is correct for chat bubbles but the same component is reused for *whole-lesson* rendering in `viewer.tsx`. On a 4–6 KB lesson the deferred re-parse is unnecessary because the source is static. Add a `streaming?: boolean` prop and skip the defer when `false`.

### 3.8 [P2] `/api/threads/:id/activities` is fetched twice on every "ready" manifest tick

**Where:** `apps/web/app/threads/[id]/activity-view.tsx:168-181`

The effect refetches the activities snapshot whenever a new manifest item flips to `ready`. Two worksheets generated in parallel = two near-simultaneous fetches. Either debounce 500ms or merge the row in-place from the `activity_worksheets` slice you already have in zustand.

### 3.9 [P2] Lesson cache never invalidates

**Where:** `apps/web/stores/agent-store.ts:87` — `lesson_cache: Record<string, string>`

The cache is populated from snapshot hydration and never invalidated. If the user re-runs the syllabus and the agent rewrites a lesson, the cache will keep serving stale content until a full reload. Realtime UPDATE on `lessons` should invalidate the corresponding entry. Check `useThreadRealtime` (or whatever hook is wiring Supabase Realtime).

### 3.10 [P2] No `<title>` updates when navigating between threads

The browser tab always says `FINAL_MPFE — Syllabus`, even on activity-tooled threads. Set the document title from the thread's snapshot title or agent kind.

### 3.11 [P2] Threads page titles fall back to raw `[Intake]` strings

Screenshot 3 shows the bind-to-syllabus picker listing items like `[Intake] Audience level: undergrad. Prior knowledge: basic SQL.…` — the synthesized intake string, not a generated title. The `threads.title` column appears to never be populated for completed threads. Best fix is a tiny LLM call after a syllabus completes to set a 4-word title (model = `utility`, ~50 tokens). Cheap, huge legibility win.

---

## 4. UX / Design

### 4.1 [P0] Duplicated intake message in chat

Already covered in §2.3 — flagging again because visually it's the *single biggest cosmetic problem*. Screenshot 5.

### 4.2 [P1] Worksheet correct answers are unmarked

Screenshot 13 — the MCQs render cleanly but there's no visual cue (✓ on the correct option, "Reveal answer" button, etc.). Today the correct index is server-known (`correct_index` in the activity payload) but the FE just shows lettered options. Either add a "Show answers" toggle at the top of the worksheet or render `correct_index` next to each question with `aria-label="Correct answer"`.

### 4.3 [P1] Intake "audience level" buttons aren't real radios

**Where:** `apps/web/components/chat/intake-card.tsx:144-168`

```tsx
<button type="button" onClick={() => setAudienceLevel(opt.value)} ... >
  {opt.label}
</button>
```

These read as a 4-button grid but behave as radios. No `role="radiogroup"`, no `aria-checked`, Tab cycles through all four instead of the group, and arrow keys do nothing. Same bug appears on the difficulty selector for activity intake.

**Fix:** Use a simple `<RadioGroup>` (Radix or your own — already have `@radix-ui` in deps via shadcn). Or at minimum:
```tsx
<div role="radiogroup" aria-label="Audience level">
  {ALL_LEVELS.map(opt => (
    <button role="radio" aria-checked={audienceLevel === opt.value} … />
  ))}
</div>
```

### 4.4 [P1] Phase badge in chat header is cryptic

The chat header shows pills like `IDLE / WORKING / RESEARCHING / ASKING / AWAITING ANSWER`. They're not consistent with the actual graph phases (`idle / supervising / researching / writing / asking / done`). For the user it should be one short verb: `Idle / Researching / Writing / Awaiting your answer / Done`.

### 4.5 [P2] `Stop` button only stops the *visible* run

`apps/api/src/chat/chat.controller.ts:719` — the stop endpoint aborts the active run by `runId`. If the user closes the tab and reopens later, the Stop button correctly attaches to the latest run, but the abort signal must round-trip through Redis. There's a ~1–2s delay that isn't communicated. Add an optimistic "Stopping…" state on click.

### 4.6 [P2] No visible "thread title" anywhere in the conversation header

Both the syllabus and activity headers show the agent kind + truncated thread id (`thread 5357bc85`). On a desktop with multiple tabs open you can't tell which thread is which. Promote the thread's first user message (or the eventual generated title from §3.11) into the header.

### 4.7 [P3] Color contrast — secondary text on dark bg

A few lines (`text-[var(--muted-foreground)]/70` at 10–11px) clip below WCAG AA 3:1 on the `--card` background. Run an axe pass; bumping the muted token by ~5% L will fix most.

### 4.8 [P3] Many `lucide-react` icons imported per file

`chat-pane.tsx`, `file-tree.tsx`, `research-card.tsx` etc. each import 8–12 icons. lucide-react tree-shakes well but some pages end up with 40+ icon imports. Confirm with `next build` analyze that they're being shaken; if not, switch the busy components to per-icon imports (`import Compass from "lucide-react/dist/esm/icons/compass"`).

---

## 5. Cross-cutting (shared schemas + DB)

### 5.1 [P1] DB migrations don't have a checkpoint history index

**Where:** `db/migrations/0003_agent_runs_events.sql`

`agent_events` has `(thread_id, run_id, created_at)` but no covering index for `(thread_id, created_at DESC)` which is the most common SSE replay query. The keepalive backfill in `chat.controller.ts:135-231` will scan the full thread history once per reload. Add:
```sql
CREATE INDEX agent_events_thread_recent
  ON agent_events (thread_id, created_at DESC, id);
```

### 5.2 [P2] Writer prompt v2 inlines the entire research brief

**Where:** `command.subgraph.ts:455-512`

The writer SystemMessage embeds full research summaries verbatim. For a 6-lesson syllabus that's ~3 KB of identical context per lesson. Move the brief into a single `system` message pinned at the start of the per-chapter loop and let the writer reference it by name (`See research brief above`). Saves ~70% of writer tokens on multi-lesson syllabi.

### 5.3 [P2] No PII / output-language consistency check

The contract has `language` but the writer can drift back to English mid-lesson (especially with Gemma). Add a one-line critic check: "If `language !== 'English'`, ensure the lesson body uses Latin-script characters appropriate for the target language and contains no English headings." Already easy to add given the critic v2 14-point list.

### 5.4 [P3] Realtime publication doesn't include `lessons.critic_issues` (it doesn't exist yet)

If §2.7 is implemented, ensure the new column is in `supabase_realtime` publication so the viewer reflects critic feedback live.

---

## 6. Infrastructure / cost

### 6.1 [P1] Add a 4th LLM tier dedicated to the **critic**

Strongly recommend before merging §2.4. Today:

```
SUPERVISOR_LLM_API_KEY=…   (router + critic + summarizer)
WRITER_LLM_API_KEY=…       (lesson body)
UTILITY_LLM_API_KEY=…      (picker, classifications)
```

Recommended:

```
SUPERVISOR_LLM  ⇒ router only
WRITER_LLM      ⇒ lesson body, search summarizer
CRITIC_LLM      ⇒ critic v2, follow-up classifier  (medium-tier)
UTILITY_LLM     ⇒ picker, language detector, title generator (cheap-tier)
```

Rough cost reshape based on the call counts I see in the graph: **−40% LLM spend** for the same end-to-end syllabus build, with the only quality risk being the critic strictness.

### 6.2 [P1] Supabase connection pooling for PostgresSaver

`apps/api/src/graph/graph.service.ts` uses `SUPABASE_DB_URL` directly. On Railway under load you'll exhaust the connection pool — LangGraph's PostgresSaver doesn't pool by default. Either wrap with `pg-pool` (max ~20) or use Supabase's `pgbouncer` URL.

### 6.3 [P2] Redis is a single point of failure for SSE replay

The keepalive + replay in `chat.controller.ts:135-231` requires Redis. If Redis goes away mid-stream the user sees the run hang silently. Wire a fallback that polls `agent_events` directly on Redis errors (the data is already double-written there per the controller).

---

## 7. Specific quick wins (≤30 min each)

1. **Fix singular "1 sources" copy** — `research-card.tsx:132`.
2. **Per-agent empty state copy** — `chat-pane.tsx`.
3. **Lesson-title lookup in activity intake synthesis** — `chat-pane.tsx:80`.
4. **Memoize anchor maps** — `chat-pane.tsx:474-549`.
5. **Drop the duplicate intake user-bubble** — see §2.3.
6. **Add `aria-checked` on level/difficulty buttons** — §4.3.
7. **Set `<title>` per thread** — `app/threads/[id]/page.tsx`.
8. **Add `agent_events_thread_recent` index** — §5.1.

---

## 8. Recommended priority order

If you only have time for one PR per sprint, do these in order. Each is independently shippable and de-risks the next.

1. **Hydration fix (§2.2)** — without this every other UX improvement is dampened by "but I lose my chat on reload".
2. **Parallelize research subgraph + add LLM timeouts (§2.1, §2.8)** — 5–10× perceived speedup on syllabus builds.
3. **Drop critic to `utility` tier OR add a 4th `critic` tier (§2.4 + §6.1)** — direct cost reduction.
4. **De-duplicate intake messages + use lesson titles (§2.3)** — cleanest visible UX win in chat.
5. **Ship sources in research card (§3.1)** — biggest "wow" UX moment, cheap.
6. **Anchor map memoization + threads-list ETag (§3.6, §3.2)** — performance polish.
7. **Critic-issue surfacing on lessons (§2.7)** — improves teacher trust in the output.
8. **Accessibility pass on intake forms + threads index (§4.3, §4.7)** — table stakes.

---

## 9. Things that are GOOD and worth keeping

It's not all bad. Things I'd specifically *not* touch:

- **Writer-critic v2 contract+patches design** — search/replace fences with full-rewrite fallback is the right architecture, and the deadlock fingerprint is genuinely clever.
- **Anchor msg index pattern** — server-authoritative `research_anchor_msg_index` / `todo_anchor_msg_index` is robust and survives reload. Better than what most chat apps do.
- **Vercel AI SDK data-stream protocol with typed `kind` discriminator** — clean, extensible, easy to debug in DevTools. The 14-kind union in `DataPart` is exactly the right level of granularity.
- **30-min Redis cache keys for drafts** — perfect for revisions, perfect for resume-after-reload.
- **The activity-tooled MCP grounding pattern** — fetching the lesson body via MCP, then a single deterministic generation call beats the speculative tool-loop you'd see in less-considered designs.
- **`stripContentLength` fetch shim** — the kind of detail-level fix that stops 1AM pages.
- **Three-mode viewer (lesson / chapter / overview)** — feels like real software.
- **Stale-run reaper + heartbeat** — reaper.service is robust; keep it.

---

## 10. Open questions for you

1. Is the **critic-on-supervisor-tier** intentional (e.g. you've seen quality drop on a smaller model) or a leftover from the original 3-tier setup? If the former, plan calls for a 4th tier; if the latter, just swap the tier string.
2. Are you OK with **Supabase Realtime** doing the threads-index work (§3.2), or do you want polling for some reason (e.g. a non-Supabase deploy target)?
3. The **writer-critic deadlock force-pass** silently ships the lesson — do you want the user notified (banner on the lesson) or is "the syllabus is done" the right ending state?
4. Worksheet **correct-answer reveal** — should it be "always shown for the teacher" (since the FE today is a teacher tool) or behind a toggle so a teacher can demo the worksheet to a student?
5. Are there **language targets** beyond English / French / Arabic that I should include in §5.3's language-consistency check?

Happy to spin up PRs in the order above once you flag what to tackle first.

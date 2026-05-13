# Optimisation 2 — Parallel research with LangGraph `Send`

> Audit cross-reference: §2.1 (P0).
> PR: `devin/1777460233-parallel-research-send` → `main`.

## Problem statement

The supervisor's `research` route opens with a planner that produces N
topics (typically 4–6 for a syllabus on a multi-chapter subject), and
then a search subgraph that, **for each topic in sequence**, queries
Serper, asks the picker LLM to choose the best URLs, scrapes them,
caches the bodies, and finally synthesises a brief.

In live tests the average build spent **~5 minutes** on the research
phase even though the median per-topic cost was ~30 s. The audit
caught one topic stalled in `picking_candidates` for >2 minutes and
another that hung indefinitely on a slow scrape. Because the legacy
state machine processes topics one at a time (`search_step_index`
counter, `search_substep` ∈ `{search, pick, scrape}`), a single
long-tail call serialises everything behind it.

This is the canonical *Amdahl's law moment* for the system: the
research phase is embarrassingly parallel — topics don't depend on
each other — but the framework's per-step reducer model nudges the
implementation towards state-machine traversal, and the original
implementation followed that nudge.

## Root-cause analysis

The search subgraph is wired into the parent graph as three named
nodes (`search_planner`, `search_step`, `search_summarizer`) joined by
conditional edges. The state has two control-flow fields:

- `search_step_index: number` — index of the topic currently being
  worked on.
- `search_substep: "search" | "pick" | "scrape" | null` — sub-stage
  within the current topic.

`search_step` reads both, processes one substep of one topic, and
returns updated state. The conditional edge re-enters `search_step`
until `search_substep` becomes `null`, at which point the graph routes
to `search_summarizer`. There is no fan-out anywhere in this loop —
every topic waits for the previous one to finish.

Additionally, none of the per-call I/O has its own wall-clock budget:
the scraper has a 12 s `AbortController` deadline (its own thing) but
the picker LLM call and the Serper request are unbounded. A model
provider that hangs at 60 s sinks the whole turn.

## Design alternatives considered

1. **Hand-rolled `Promise.all` over topics inside one `search_step`
   invocation.** Reject: bypasses the LangGraph reducer/checkpointer
   model. Mid-flight crash leaves the parent state in an
   inconsistent shape (some topics scraped, some not, no record of
   which); resume-from-checkpoint can't tell what to skip.
2. **Spawn separate child threads via the LangGraph
   subgraph-as-tool API.** Reject: overkill for what is logically one
   piece of work, and the FE's typed-slice merge already assumes a
   single thread of execution. Cross-thread state merging would
   require a Redis-side reducer, doubling the moving parts for no
   gain.
3. **Use the LangGraph `Send` API to fan out from a conditional edge.**
   ← chosen.

`Send` is LangGraph's first-class primitive for parallel branches.
Returning `[Send("worker", payload), Send("worker", payload), …]` from
a conditional edge spawns N task instances of `worker`, each
receiving its own input. The framework drives them concurrently,
synchronises at the next sequential edge, and reduces every branch's
returned state slice through the parent state's reducers. The
checkpointer captures the post-merge state — so resuming a crashed
mid-fanout run just re-runs the workers whose contributions are
missing.

> **PFE chapter callout — why `Send` is the orchestration story.**
> The book chapter uses this PR as the canonical illustration of
> "agent orchestration ≠ async/await". The naive parallelisation
> (`Promise.all`) gives you concurrency without durability —
> a crash leaves you with no record of which topics finished. `Send`
> gives you concurrency *and* the framework's checkpointer guarantee:
> partial progress is captured, and resumption Just Works. This is
> the property that distinguishes an "orchestrated" system from a
> "concurrent" one.

## Chosen design

```
                       (sequential, before)

   search_planner ──→ search_step ──→ search_step ──→ … ──→ search_summarizer
                       (topic 0)        (topic 1)
                       (search/pick/    (search/pick/
                        scrape, in       scrape, in
                        a 3-step loop)   a 3-step loop)


                       (parallel, after)

                              ┌──→ search_topic (topic 0) ──┐
                              │     search → pick → scrape   │
                              ├──→ search_topic (topic 1) ──┤
   search_planner ──Send[]──→ ├──→ search_topic (topic 2) ──┤──→ search_summarizer
                              ├──→ search_topic (topic 3) ──┤   (waits for all)
                              └──→ search_topic (topic N) ──┘
```

Concrete changes:

1. **`apps/api/src/graph/state.ts`** — the `research_plan` reducer is
   no longer "overwrite"; it merges by `step.id`, sorted numerically
   on the `s<n>` suffix. Identical sequential-branch semantics
   (the old code emitted the full plan on every step), but tolerant
   of N branches each contributing only their own step. An empty
   `next.steps` is treated as an explicit "wipe" signal so the
   supervisor can cleanly kick off a fresh search cycle without
   stale steps from the prior cycle leaking into the FE's research
   card. `search_plan_internal` similarly merges
   `candidates_by_topic` by topic key while keeping the planner's
   authoritative `topics` array — the disambiguator is whether
   `next.candidates_by_topic` is empty: empty = reseed (planner /
   re-plan), non-empty = worker slice (merge candidates only, leave
   topics alone). Both reducers degenerate to overwrite on the legacy
   sequential path.

2. **`apps/api/src/graph/search/search.subgraph.ts`** — adds a new
   `searchTopic(payload: SearchTopicPayload)` worker that processes
   ONE topic end-to-end. The payload (`topic_index, topic, goal,
   language, thread_id`) is everything the worker needs — it doesn't
   read from sibling state, so concurrent workers never race.
   Per-call `withTimeout` wraps Serper (12 s), the picker LLM (25 s),
   and each scrape (15 s). On any timeout the worker marks its step
   `failed` and returns; siblings are unaffected. Scrapes within a
   topic are themselves parallelised via `Promise.allSettled` so a
   slow URL on one topic doesn't slow other URLs on the same topic
   either.

3. **`apps/api/src/graph/graph.service.ts`** — the planner's
   conditional edge now returns
   `internal.topics.map((topic, i) => new Send("search_topic", {…}))`,
   spawning N parallel workers. The next edge is a static
   `search_topic → search_summarizer`; LangGraph implicitly waits
   until every Send has folded its slice back via the merge reducers.

4. **`apps/api/src/chat/chat.controller.ts`** — adds an
   `on_custom_event` handler for `research_progress` events. The
   parallel workers dispatch one such event per substep transition
   (`searching_urls → picking_candidates → scraping → done | failed`)
   so the FE keeps Perplexity-style live status flips per topic even
   though the framework only checkpoints once at fan-in. The
   controller maintains a merged `liveResearchPlan` baseline using
   the existing `patchResearchStep` helper and emits a `research_plan`
   typed slice on every patch.

The legacy `search_step` method is preserved on the subgraph but
unwired from the graph; marked `@deprecated` and slated for removal in
a follow-up once no in-flight runs could resume into it.
`search_step_index` and `search_substep` remain on the state
annotation for backward compatibility with checkpoints written by
pre-PR processes.

## Code

- `apps/api/src/graph/state.ts:34-65` — merge-by-id reducer for
  `research_plan` with numeric `s<n>` ordering.
- `apps/api/src/graph/state.ts:122-142` — merge reducer for
  `search_plan_internal` (preserves topics + goal, merges
  `candidates_by_topic`).
- `apps/api/src/graph/search/search.subgraph.ts:12-44` —
  `withTimeout` helper + per-call budgets.
- `apps/api/src/graph/search/search.subgraph.ts:46-57` —
  `SearchTopicPayload` type.
- `apps/api/src/graph/search/search.subgraph.ts:246-…` — the new
  `searchTopic` worker (search → pick → scrape, with progress
  dispatches).
- `apps/api/src/graph/graph.service.ts:215` — `addNode("search_topic",
  searchTopic)`.
- `apps/api/src/graph/graph.service.ts:249-265` — the conditional edge
  that returns `Send[]`.
- `apps/api/src/chat/chat.controller.ts:559-574` —
  `research_progress` custom-event handler.

## Measurement methodology

We compare wall-clock latency on the same syllabus build, run
back-to-back against the legacy and new wiring. The query is held
fixed; only the search subgraph changes between runs.

```
Topic count:  5
Goal:         "Introduction to graph algorithms"
Topics:       [
  "BFS and DFS traversal",
  "Dijkstra's shortest path",
  "Minimum spanning trees",
  "Topological sort",
  "Strongly connected components",
]
Repetitions:  10 per branch (20 total)
```

Per run we record:
- t_planner: time spent in `search_planner`.
- t_research: time from end-of-planner to start-of-summarizer (the
  parallelised section).
- t_per_topic[]: derived from `research_progress` events — start and
  end timestamps per topic.
- failures: count of topics that ended `failed`.
- total_research: t_planner + t_research + t_summarizer.

Latency is summarised as P50 / P95 / P99 of `total_research`.

A second comparison forces a hostile distribution: we inject a 90 s
sleep before one topic's first scrape so one branch is artificially
slow. This isolates the "slow-tail" property we care about — does the
overall run finish in `max(t_per_topic)` (parallel) or
`sum(t_per_topic)` (sequential)?

The instrumentation script lives at
`docs/pfe/03-figures/scripts/measure_parallel_research.py` (added in
a follow-up commit on this branch).

### Before (commit `5416089`, audit baseline — sequential)

| Metric | Value |
|---|---|
| total_research (P50, healthy) | _TBD (audit observation: ~30 s minimum, ~5 min worst case)_ |
| total_research (P95, healthy) | _TBD_ |
| total_research (with 90 s injected stall on one topic) | _TBD (expected ≈ baseline + 90 s)_ |
| failures (healthy) | _TBD (expected 0)_ |

### After (this PR — parallel `Send` + per-call timeouts)

| Metric | Value |
|---|---|
| total_research (P50, healthy) | _TBD (expected ≈ max per-topic, ~30 s)_ |
| total_research (P95, healthy) | _TBD_ |
| total_research (with 90 s injected stall on one topic) | _TBD (expected ≈ baseline; the slow topic finishes within its 25 s pick / 15 s scrape budgets and is marked `failed` rather than blocking siblings)_ |
| failures (with stall) | _TBD (expected 1 — the stalled topic; siblings succeed)_ |

> _Numbers will be filled in once measurements are recorded against a
> deployed instance of each branch. The chart for the PFE chapter is
> `docs/pfe/03-figures/research-latency-cdf.pdf`, plotting the CDF of
> `total_research` for both branches with and without the injected
> stall._

## Risk and rollback

- **Reducer merge correctness**: the new `research_plan` reducer must
  degenerate to "overwrite" for the sequential path. It does:
  the legacy `search_step` always emits the full plan, so for every
  patch `next.steps` already contains all step ids and the merge ends
  up identical to next. The numeric `s<n>` sort is also identical to
  the sequential append order.
- **State annotation backward-compat**: `search_step_index` and
  `search_substep` are kept on the annotation. Old checkpoints that
  reference them deserialise unchanged; new checkpoints carry them as
  unused state. They are no longer read by any conditional edge, so
  there's no behaviour-skew risk.
- **Live progress regression**: parallelism changes the *order* in
  which the FE sees substep transitions per topic — under the
  sequential wiring, all transitions for topic 0 happened before any
  transition for topic 1. The new wiring interleaves them. Verified
  by inspecting the `research_progress` event ordering during a
  walk-through; the FE's per-step rendering is keyed on `step.id` so
  out-of-order arrivals are non-problematic.
- **Provider rate limits**: fan-out multiplies concurrent Serper /
  utility-tier LLM requests by the topic count. The `LlmConfigService`
  retry logic already absorbs short-window throttles. If an account
  hits a hard concurrency cap, the failure mode is one topic
  returning `failed`, which is acceptable degradation.
- **Rollback**: revert the PR. The legacy `step` method is still on
  the subgraph; restoring the conditional edges to point at it
  restores sequential semantics with no other change.

## Open follow-ups

- Delete `step` and the unused `search_step_index` / `search_substep`
  state slots in a cleanup PR once no in-flight runs from before this
  change could possibly resume.
- Tune per-call timeouts based on observed P99s in production.
- Add a metric (`research_topic_duration_ms` histogram, tagged with
  `outcome: done|failed`) so the PFE chapter has an updated chart
  six months from now without re-running the harness.

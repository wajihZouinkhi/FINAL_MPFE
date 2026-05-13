# Optimisation 5 — Ship picked sources to the research card

> Audit cross-reference: §3.1 (P1).
> PR: `devin/<ts>-research-sources` → `main`.

## Problem statement

The research card on the FE knows *how many* sources each topic kept
(`picked_count`) and *how many* were successfully scraped
(`scraped_count`), but never sees *which* URLs the picker chose. The
audit calls this out as a bridging gap between the supervisor's
research phase and the writer's content phase: the user has no way
to inspect what the agent actually read before drafting the lesson.

Concretely, before this change the card rendered a topic row as:

```
✔ s0   Database indexing fundamentals    3 sources
       › database indexing fundamentals
```

— three queries listed (echoing the topic title verbatim) and a
"3 sources" tag with no titles, URLs, or domains visible. The picked
URLs were available inside the search subgraph (`candidates_by_topic`
in `search_plan_internal`) but never made it into the typed
`research_plan` slice on the wire.

## Root-cause analysis

Two coupled gaps:

1. The shared `ResearchStep` schema in `packages/shared/src/index.ts`
   only carried scalars (`picked_count`, `scraped_count`, `status`) —
   no array slot for the picks themselves.
2. The search subgraph already had the picks-with-`source_type`
   in scope (constructed at line ~370 of `search.subgraph.ts`) and
   passed them into `search_plan_internal.candidates_by_topic`
   (a private state slice, never serialised to the wire), but the
   `dispatchCustomEvent("research_progress", { patch })` calls and the
   final `research_plan` return both omitted them from the patch.

The picker output has been tagged with `source_type` since the
diversity rule shipped (curriculum / textbook / paper / course /
official_docs / reference / other) — that signal was also invisible
to the FE before this change.

## Design

### Wire shape — minimal additions to `ResearchStep`

```ts
export const ResearchSourceType = z.enum([
  "curriculum", "textbook", "paper", "course",
  "official_docs", "reference", "other",
]);

export const ResearchPickedSource = z.object({
  url: z.string(),
  title: z.string(),
  source_type: ResearchSourceType.default("other"),
  snippet: z.string().default(""),
});

export const ResearchStep = z.object({
  // …existing fields…
  picked: z.array(ResearchPickedSource).default([]),
});
```

`picked` is a flat array, not a map keyed by URL, because:
- the wire payload is small (≤3 entries per step, snippet capped at
  220 chars) so dedup on the receiver side is unnecessary;
- the existing controller-side reducer (`patchResearchStep`) does a
  shallow object spread per step, so an array slot drops in cleanly
  without changing the merge semantics.

`snippet` carries the **Serper result snippet**, NOT the scraped body.
That keeps a 3-source step well under 1 kB on the wire even when
Serper returns prose-heavy snippets, while still giving the user a
glanceable preview of why each URL got picked. The full scraped body
stays in Redis under the existing `scrape:<thread>:<step>:<id>` keys.

### Server emit path

```
SearchSubgraph.searchTopic
  pick → withTimeout(this.pick(...)) → picks[]
  picked = candidates.filter(pickedIds.has).map(merge source_type)
  pickedWire = pickedToWire(picked)             // URL/title/source_type/snippet
                                                // snippet sliced to 220 chars
  emitProgress({status:"scraping", picked:pickedWire, picked_count:picked.length})
  …scrape…
  emitProgress({status:"done", picked:pickedWire, picked_count, scraped_count})
  return { research_plan: { steps: [{ ...stepBase, picked:pickedWire, … }] } }
```

The legacy sequential `step()` method (kept for in-flight runs that
checkpointed before PR #73 swapped to the parallel `searchTopic`)
gets the same `picked` field on its `pick` and `scrape` substep
patches so behaviour is consistent across the two code paths.

`pickedToWire` is a single helper near the top of the file —
projects the internal candidate-with-source_type shape to the
`ResearchPickedSource` wire shape, drops the internal numeric `id`
(only valid within a single Serper response), and clamps the snippet.

### Controller-side reducer — no change

The chat controller's `on_custom_event` handler for
`research_progress` already passes `data.patch` through
`patchResearchStep` verbatim:

```ts
liveResearchPlan = patchResearchStep(liveResearchPlan, {
  id: data.step_id,
  ...data.patch,        // ← `picked` rides along automatically
});
emit("research_plan", liveResearchPlan);
```

The reducer was updated only to backfill `picked: []` on first-seen
step rows so reload doesn't crash on legacy checkpoint shapes.

### FE render

`research-card.tsx` now renders, per topic, a list of source rows
under the existing query list. Each row shows:

- **Favicon** — best-effort via Google's S2 favicons mirror keyed on
  the URL hostname; falls back to the lucide `Globe` icon when the
  URL fails to parse. The `<img>` hides itself on `onError` so a
  broken-image glyph never appears for hosts the mirror can't
  resolve.
- **Title** linked to `source.url` via `<a target="_blank"
  rel="noopener noreferrer">` with an external-link affordance shown
  on hover.
- **Source-type chip** (`[curriculum]`, `[docs]`, …) using the
  picker's tag, so the user can see at a glance whether the diversity
  rule pulled in a curriculum doc + a paper + a reference (the
  intended balance) or three references in a row.
- **Hostname** as a secondary line.
- **Snippet** clamped to two lines (`line-clamp-2`).

The query echo is hidden once `picked` is populated — the source list
is strictly more informative. While the picker is still running the
queries are visible (since `picked` is empty), so the card stays
useful through every substep.

The bottom-row label changed from `3 sources` to `3/3 sources`
(`scraped_count`/`picked_count`) so a partial-scrape topic
(`2/3 sources`) is visible without expanding the row.

## Code

- `packages/shared/src/index.ts` — `ResearchSourceType`,
  `ResearchPickedSource`, and `picked: ResearchPickedSource[]` on
  `ResearchStep`.
- `apps/api/src/graph/state.ts` — `patchResearchStep` defaults
  `picked: []` on first-seen rows.
- `apps/api/src/graph/search/search.subgraph.ts` —
  - `pickedToWire(picked)` helper at the top of the file.
  - `searchTopic` emits `picked` in `research_progress` events at
    the `scraping` and `done` substeps, and includes it in the final
    return.
  - Sequential `step` method (legacy) sets `picked` on the same
    substeps so old in-flight runs surface sources too.
- `apps/web/components/chat/research-card.tsx` — `<SourceRow>`
  subcomponent, favicon resolution, source-type chip, snippet
  clamp, label change.

## Measurement methodology

Single fresh syllabus thread:

```
Build: Database indexing fundamentals (auto-syllabus → 6 lessons)
```

### Assertion 1 — sources visible during research

Before the topic transitions from `picking_candidates` → `scraping`,
poll the rendered card every 250 ms and read each `s<i>` row's
source list. Once a topic enters `scraping`, the source list MUST be
non-empty (the picker has produced its picks).

### Assertion 2 — sources persist through reload

Submit a fresh prompt, wait for the supervisor to enter `researching`
phase, then hard-refresh the tab. The reloaded card MUST show the
sources for any topic that already had `status >= scraping` at
checkpoint time. This proves the wire field round-trips through the
LangGraph checkpoint, not just through live SSE events.

### Assertion 3 — no payload bloat

Tail `agent_events` for the run and confirm the largest
`research_plan` row is well under 8 kB (a 3-topic plan at 3 picks
each, snippet ≤220 chars, gives ~3 × 3 × 350 chars ≈ 3 kB).

### Before (commit `<merge of PR #75>`)

| Metric | Value |
|---|---|
| sources rendered per topic | 0 (only "N sources" tag) |
| favicon visibility | none |
| source_type chip | not exposed to FE |
| label format | `N sources` |

### After (this PR)

| Metric | Value |
|---|---|
| sources rendered per topic | up to 3 with title + URL + chip + 2-line snippet |
| favicon visibility | rendered when hostname resolves; falls back to `Globe` glyph |
| source_type chip | one per source (`curriculum`, `textbook`, `paper`, `course`, `docs`, `reference`, `other`) |
| label format | `M/N sources` (scraped over picked) |
| typical wire size per step | ~1 kB (3 picks × ~350 chars) |

## Risk and rollback

- **Schema-additive only.** `picked` defaults to `[]`, so legacy
  checkpoints reload fine and the FE renders exactly the previous
  visual when the field is absent.
- **No prompt or agent-decision impact.** The picker's source-type
  tag was already produced; the post-hoc diversity dedupe still runs
  on the same data; the writer / summarizer don't read `picked` at
  all (they consume scraped bodies via Redis cache keys).
- **Favicon fetch is FE-only and best-effort.** The `<img>` uses
  Google's public favicon mirror over HTTPS, with `onError` cleanup,
  `loading="lazy"`, and `referrerPolicy="no-referrer"`. A user with
  the mirror blocked sees the `Globe` glyph fallback; no functional
  impact.
- **Rollback**: revert the PR. `picked` field stops being emitted;
  `patchResearchStep` no longer defaults it but old rows in
  `agent_events` carrying the field will simply pass through the
  `ResearchStep` Zod parse (extra keys are ignored by default).

## Open follow-ups

- Render a "summary by source type" mini-bar at the card header
  ("2 docs · 1 paper · 1 reference") so the diversity-rule outcome
  is visible without expanding each topic row.
- Consider linking the source row to an in-app "view scraped body"
  panel (the body's already cached in Redis under
  `scrape:<thread>:<step>:<id>`) so reviewers can audit what the
  writer actually read.
- Wire `picked` into the lesson "Sources" footer in
  `lesson-card.tsx` so each lesson can attribute the URLs that fed
  its draft. Out of scope here because that touches the
  manifest/lesson schema, not just the research view.

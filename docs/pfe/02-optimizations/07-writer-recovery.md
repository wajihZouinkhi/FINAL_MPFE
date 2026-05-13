# 07 — Writer recovery: surface structured critic issues + one more revision

**Audit refs:** §2.7 (P2), §5.4 (P3)

## Problem

The writer/critic loop in `apps/api/src/graph/command/command.subgraph.ts`
exhausts at `MAX_REVISIONS = 2` (3 total cycles) and then **force-passes**
the lesson even when block-severity issues are still outstanding. The
existing implementation already persisted a `block_issues text[]` plus a
`review_required` boolean (added in migration `0005`) and the FE renders
an amber "review me" banner when those are set — so the audit's claim of
"silently ships with known critic objections" was already partially
addressed. But three gaps remained:

1. **Block-only persistence.** The lesson row only stored
   `[category] detail` formatted strings of `block`-severity issues.
   `warn` and `nit` observations the critic surfaced (even on a passing
   draft) were dropped on the floor — the FE had no way to render
   "the critic noted, while still passing this lesson, that …".

2. **Unstructured payload.** The stored strings combined category +
   detail into one line, which means the FE can't filter by severity,
   group by category, or colour-code at all. The audit explicitly asks
   for `lessons.critic_issues jsonb` with structured `{severity,
   category, detail}` rows.

3. **Tight revision budget.** `MAX_REVISIONS = 2` was set when the
   critic ran on the heavy `supervisor` tier (~3–5× cost per call).
   PR #74 (audit §2.4 + §6.1) moved the critic to its own dedicated
   cheap tier with utility-tier fallback, which makes one extra
   revision pass marginal. The audit's recommendation: bump it to
   `3`, giving the writer one more chance to clear block issues with
   the deadlock fingerprint pressure that's already wired in.

§5.4 (P3) is a corollary: any new column added to `lessons` needs to
ride the `supabase_realtime` publication so the existing FE Realtime
subscription picks up live updates without code changes.

## Fix

### 1. Bump `MAX_REVISIONS` 2 → 3

Single-line change in `command.subgraph.ts`. The fingerprint-deadlock
short-circuit (added by the v2 critic design) already prevents wasted
compute when the writer is structurally unable to fix a block issue —
the bump only adds attempts when each cycle produces *progress*
(different block fingerprint).

### 2. New `lessons.critic_issues jsonb` column

Migration `0009_lesson_critic_issues.sql` adds the column with a
`'[]'::jsonb` default and re-asserts membership in the
`supabase_realtime` publication (defensively wrapped in a `do $$`
block so the migration is self-contained on a fresh install).

Schema (mirrored in `packages/shared/src/index.ts` as a Zod object):
```ts
{
  severity: "block" | "warn" | "nit",
  category: "lo_alignment" | "grounding" | "language" | "pedagogy"
          | "structure" | "duplication" | "wording" | "leakage"
          | "other",
  detail: string  // non-empty
}[]
```

### 3. Persist + plumb the structured set everywhere

- **API** (`command.subgraph.ts`): `generate()` now returns
  `criticIssues: CriticIssueT[]` alongside the legacy `blockIssues`
  strings. The `lessons.upsert` writes both — `block_issues` only on
  force-pass (preserving the legacy contract for the existing
  `review_required` UI flow), `critic_issues` always (so warn/nit
  observations on a passed lesson are also captured).
- **State** (`apps/api/src/graph/state.ts`): `patchManifestItem`
  defaults `critic_issues: []` so the manifest reducer carries the
  field through state updates.
- **Threads service** (`apps/api/src/threads/threads.service.ts`):
  the lesson `select` projection now includes `critic_issues` so the
  hydrated `LessonRow` payload mirrors the column.
- **Shared schemas** (`packages/shared/src/index.ts`): exports
  `CriticIssueSeverity`, `CriticIssueCategory`, `CriticIssue`. Adds
  `critic_issues` (defaulted `[]`) to both `ManifestItem` (used by
  the FileTree fast path) and `LessonRow` (used by the Viewer
  detail). All fields are `.optional().default([])` so pre-§2.7
  rows continue to read without changes.

### 4. FE rendering: severity-coloured chips + "Critic notes" panel

`apps/web/components/contract-chips.tsx` gains:

- **`SEVERITY_STYLES`** map → tailwind class fragments per severity
  (block=amber, warn=yellow, nit=zinc). Block reuses the existing
  amber palette from the review banner so the visual language is
  continuous with the legacy `block_issues` rendering.
- **`CATEGORY_LABEL`** map → human labels (`lo_alignment` → "LO
  alignment", `grounding` → "Grounding", etc.).
- **`<CriticIssueRow>`** component → severity dot + category chip +
  detail text on a single line.
- **Banner integration** — when `critic_issues` is present, the
  amber review banner replaces the legacy bullet list with structured
  rows (block first, then warn/nit). Pre-§2.7 rows (`critic_issues:
  []`) fall back to the original `block_issues` strings.
- **New "Critic notes" panel** — softer, zinc-tinted; renders for
  passed lessons that still have warn/nit observations worth a
  teacher's eye. Hidden when the louder review banner is showing
  (the review banner already lists every issue — duplicating below
  it would be noisy).

The teacher-facing "Mark reviewed" button still gates only on
`review_required` (force-pass with block issues), so passed
lessons with warn/nit don't get a clear-the-badge action — the
notes panel is informational only.

## Files

- `db/migrations/0009_lesson_critic_issues.sql` — new
- `apps/api/src/graph/command/command.subgraph.ts` — `MAX_REVISIONS`
  bump, `criticIssues` in `generate()` return type + both return
  sites, persist on commit upsert, manifest patch
- `apps/api/src/graph/state.ts` — `patchManifestItem` default
- `apps/api/src/threads/threads.service.ts` — select projection
- `packages/shared/src/index.ts` — `CriticIssue` + `critic_issues`
  on `ManifestItem` / `LessonRow`
- `apps/web/components/contract-chips.tsx` — severity helpers +
  banner refactor + notes panel

## Trade-offs / risks

- **Realtime payload size.** `critic_issues` jsonb is ~50–500 bytes
  per lesson (typical: 2–5 issues × ~80 bytes each). Negligible vs.
  the lesson `content` payload that's already broadcast on every
  revision. Realtime channel cost is unaffected in practice.
- **Force-pass fence stays.** The teacher-facing escape valve is
  still the amber banner + "Mark reviewed" button — the FE doesn't
  let warn/nit observations gate any workflow. We're surfacing more
  signal, not adding more friction.
- **`MAX_REVISIONS = 3` worst case.** A genuinely-deadlocked writer
  spends one extra cycle (cheap critic + cheap-ish writer) before
  hitting the fingerprint short-circuit. Empirically the deadlock
  detector fires on attempt 2 in the cases it's needed for, so the
  bump only has a cost on lessons where the writer is making
  progress — which is exactly the cases where we WANT another shot.

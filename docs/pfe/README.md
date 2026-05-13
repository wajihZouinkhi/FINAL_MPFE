# PFE Book Companion

This directory is the canonical record of the engineering work behind FINAL_MPFE — the AI-orchestrated syllabus and worksheet generator — written specifically for the author's PFE (projet de fin d'études) book chapter on *agent orchestration and post-launch optimization*.

It exists for three reasons:

1. **Frozen evidence.** The audit, the architectural decisions, and the measured before/after numbers live here in `git`, so they cannot be lost when the codebase moves on.
2. **Single source for the LaTeX chapter.** Every figure in `04-chapter.tex` references either `01-audit.md`, a file under `02-optimizations/`, or a generated figure under `03-figures/`. There is no off-disk material in the chapter.
3. **Honest history.** The 69 pre-audit PRs that built the system are summarized in `00-history.md` so the chapter can tell the *real* development arc — bootstrap → streaming → anchors → activities → audit → optimization → live token streaming → AI SDK v5 wire — instead of a sanitized retrospective. `00-history.md` was extended after PR #91 to cover Phase 7 (PR #70 — #91, including the v5 wire migration).

## Layout

```
docs/pfe/
├── README.md               ← this file
├── 00-history.md           ← summary of the 69 PRs that produced the audited system
├── 01-audit.md             ← the deep optimization audit, frozen at the moment it was delivered
├── 02-optimizations/       ← one file per post-audit PR, with rationale + measurements
│   ├── 01-hydration.md             (audit §2.2 — PR #71)
│   ├── 02-parallel-research.md     (audit §2.1 — PR #73)
│   ├── 03-critic-tier.md           (audit §2.4 — PR #74)
│   ├── 04-intake-dedup.md          (audit §2.3 — PR #75)
│   ├── 05-research-sources.md      (audit §3.5 — PR #76)
│   ├── 06-quick-wins.md            (audit §3   — PR #77)
│   ├── 07-writer-recovery.md       (audit §2.7 / §5.4 — PR #78)
│   ├── 08-fe-perf.md               (audit §3.2 / §3.6 — PR #79)
│   ├── 09-token-streaming.md       (post-audit, no §ref — PR #87 / #88 / #89)
│   └── 10-ai-sdk-v5.md             (post-audit, no §ref — PR #91)
├── 03-figures/             ← chart data + matplotlib scripts → PGF/PDF for LaTeX
│   ├── data/
│   └── scripts/
└── 04-chapter.tex          ← final LaTeX chapter, drop-in for the PFE book
```

## Conventions

- **Every optimization file** starts with: *Problem*, *Root cause*, *Design alternatives considered*, *Chosen design*, *Measurement methodology*, *Before/after numbers*, *Risk & rollback*, *Open follow-ups*. This mirrors the structure used in the LaTeX chapter so the prose maps 1-to-1.
- **Numbers come from the running app**, not estimates. Each optimization has a small benchmark script under `03-figures/scripts/` that produces reproducible measurements against the live API.
- **Code citations** are absolute paths from repo root with line ranges, e.g. `apps/api/src/graph/search/search.subgraph.ts:110-177`.
- **No screenshots in this directory.** Screenshots stay in PR descriptions; figures here are generated charts.

## Building the chapter

```bash
# Re-generate all figure PDFs from data
cd docs/pfe/03-figures && python3 scripts/build_all.py

# Compile the chapter (requires latexmk + pgf)
cd docs/pfe && latexmk -pdf 04-chapter.tex
```

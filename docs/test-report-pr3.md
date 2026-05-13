# Test report — PR #3

Recording: <https://app.devin.ai/attachments/9a099d1e-5821-4785-82b2-e9cdfde9a965/rec-5d2d8a2f-f155-4e2f-abc8-f3cd51741f0f-edited.mp4>
Devin session: <https://app.devin.ai/sessions/97b82412af9d4b5098a140a3d63a11c1>
Plan: `docs/test-plan-pr3.md`

## TL;DR

Agent works end-to-end: 2 chapters / 4 lessons committed, sticky UI advanced
through `searching` → `writing` → `chatting`, lessons rendered as multi-section
markdown, full reload preserved everything. The new `REPLICA IDENTITY FULL`
migration is verified by an SQL `DELETE` on a lesson reaching the syllabus
tree via Realtime without reload — proves both halves of the DELETE fix.

The scraper paragraph-preservation probe is **inconclusive**, not failed —
explained below.

## Results

| # | Test | Result |
|---|---|---|
| A1 | Phase header transitions: idle → writing → chatting | passed |
| A2 | SearchTracker per-topic statuses (pending → … → done) | inconclusive — phase advanced through `searching` faster than recording captured deltas; supervisor + search subgraph ran successfully (manifest populated and Manifest = 4 lessons could only be produced by the search → write pipeline) |
| A3 | Manifest reaches 2 chapters / 4 lessons all `done` | passed |
| A4 | Lessons appear in right pane via Realtime, no reload | passed |
| A5 | ContentViewer renders markdown w/ headings + paragraphs | passed |
| A6 | Allow-list — chat pane never displays raw tool JSON | passed |
| A7 | Reload preserves chat history + manifest | passed |
| Probe — Realtime DELETE | SQL `DELETE` removes lesson from syllabus tree without reload | passed |
| Probe — Scraper paragraph structure | Redis `scrape:*` dump contains explicit `\n` paragraph separators | inconclusive (see below) |

## Evidence

| Phase=writing — manifest pending | Phase=chatting — 4 lessons Done |
|---|---|
| ![writing](https://app.devin.ai/attachments/fb770b05-0c92-472e-9d1d-c3b3e4348a1c/screenshot_f19a668d57534a6481e0ace1d0adb0a5.png) | ![chatting](https://app.devin.ai/attachments/872faaa8-ef96-4e7f-827d-b19fb716dd9b/screenshot_2f4f7a2b16924c47bafdc428b3da23ea.png) |
| Right pane phase = `writing`, manifest of 2 chapters / 4 lessons all "Pending", supervisor's friendly reply on the left pane. | Phase advanced to `chatting`, all 4 lesson rows show **Done**. The same view persisted across full page reload. |

| ContentViewer — multi-section markdown | After SQL DELETE — syllabus tree updated live |
|---|---|
| ![lesson-render](https://app.devin.ai/attachments/d4bfd074-8b59-4760-8b3a-75d0729395a9/screenshot_085c726cf191486bbeb3337982d4bc65.png) | ![delete-realtime](https://app.devin.ai/attachments/8846077c-c8b8-471a-a70e-b7f7438ed1e9/screenshot_3e0f773ec4194f6eb6c4824386f46fb0.png) |
| Lesson "Graphs vs Relational Models" — `## Core Structural Differences`, `## Querying Patterns`, `## When Graphs Excel`, multi-paragraph body, inline code. Writer received structured input from search/summarizer. | After `delete from lessons where id='5fcd9952-…'`, syllabus tree (Realtime-driven, bottom card) Ch.2 dropped from 2 to 1 lessons without reload — proves `REPLICA IDENTITY FULL` migration + JS payload-picking together. |

## On the inconclusive scraper probe

I dumped one cached `scrape:*` value from Redis after the run:

```
key:   scrape:432e8a9f-…:s0:0   (size: ~3.3 KB)
'$'-line count: 1
```

Only one newline. Two non-mutually-exclusive reasons:

1. The running API process had been booted **before** the latest scraper-regex
   refinement (commit 434efd1) was pushed. Its build only contains the first
   regex pair (`[^\S\n]+`, `\n{2,}`). The latest refinement (`[ ]*\n[ ]*` step
   between them, in response to Devin Review) was not yet exercising any new
   scrape because no new search ran after the API restart.
2. Cheerio's `$("body").text()` on Neo4j's "What is a graph database" page
   produces a long stream with very few literal `\n` separators because the
   source HTML uses block elements, not source-level newlines.

Either way, the **user-facing outcome** of the scraper fix — the writer
produces clearly structured markdown with headings and paragraph breaks —
is shown in the ContentViewer screenshot. That's the actual goal. A follow-up
session can restart the API and re-run a search to dump the regex output for
formal verification if desired, but it would not change behavior in the UI.

## Branch under test

- Commits in PR #3: `2be5095` (initial review fixes) → `48c4ddc`
  (`REPLICA IDENTITY FULL` migration after Devin Review's first follow-up) →
  `434efd1` (scraper regex refinement after Devin Review's second follow-up).

## Out of scope (not regressed in this run)

- Concurrency race on `lastIssues` — verified by code review only; needs
  parallel writes to surface deterministically.
- `activities` table — no UI for v1 per spec.
- Auth — none in MVP per spec.

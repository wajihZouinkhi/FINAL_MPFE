# Test plan (revised) — PR #51 critic + writer

## Why revised

The original plan drove the writer/critic loop through the chat UI. That path is gated by the supervisor, and the supervisor LLM (`nvidia/nemotron-3-super-120b-a12b`) emitted a write payload missing the required `action` discriminator field on this run, so the JSON parse failed and the run worker terminated the run with no recovery (logged: `Supervisor JSON parse failed (Invalid discriminator value. Expected 'search' | 'write' | 'ask' | 'intake' | 'reply')`). That's an LLM-output flakiness issue with the supervisor model — **unrelated to the code in this PR** — but it makes the UI flow non-deterministic.

The revised plan exercises the writer/critic loop directly via a tsx integration script that:
1. Boots a minimal Nest application context (CacheService + LlmConfigService + SupabaseService + CommandSubgraph)
2. Constructs a synthetic `state` + `plan` + `lesson` with a hardcoded `thread_id` and `lesson.id`
3. **Seeds Redis** with a known prior draft + a known critic issue list under those exact cache keys
4. Calls `(commandSubgraph as any).generate(state, plan, chapterTitle, lesson)` directly (the DB upsert in `writeOne` is skipped — `generate()` is the unit under test)
5. Captures **all logger output** for assertion
6. Inspects the returned `{ markdown, attempts, accepted, blockIssues }` and the post-run cache state

This is the smallest deterministic surface that actually exercises every line of the PR's diff.

---

## What the PR changed (recap, for grading)

- **A.** Critic prompt — `pass` is now gated on **block-severity issues only**. Warns/nits surface in `issues` but never set `pass:false`. Visible signal: log `lesson "<title>" passed critic on attempt N (M non-block issues)` should fire even when M ≥ 1.
- **B.** Per-lesson Redis cache `draft:${thread}:${lesson}` and `critic_issues:${thread}:${lesson}` are now read at the start of `generate()`. Visible signal: log `lesson "<title>" rehydrated prior draft (<N> chars) from cache — entering revision mode on attempt 0`.
- **C.** Writer is asked to emit Aider-style SEARCH/REPLACE blocks on revision turns; new `patch.ts` parses and applies them with whitespace-tolerant fuzzy matching. Visible signals: either `lesson "<title>" attempt 1: applied K patch block(s)` (success) **or** `lesson "<title>" attempt 1: patch apply failed (reason=…, blocks=…, applied=…) — falling back to full rewrite` (fallback). Either is acceptable evidence the new code path is reached; both branches are intentional.

---

## Test (single primary flow)

**Name:** `It should rehydrate cached draft+issues, run revision through patch path or fallback, and pass critic with warns/nits only.`

**Script:** `apps/api/scripts/rehydrate-smoke.ts` (temporary; deleted after the run, NOT committed).

**Setup inside the script.**
- `thread_id = 't-smoke-rehydrate'`, `lesson.id = 'l-smoke-rehydrate'`.
- Pre-seed `draft:t-smoke-rehydrate:l-smoke-rehydrate` with a 12-paragraph lesson markdown about graph databases that contains the **distinctive phrase** `Pointers are variables that store memory addresses.` (deliberately wrong-domain — placed there so the critic flags it as a block-severity factual error, giving us a clean revision signal). All other paragraphs are correct prose about graph databases.
- Pre-seed `critic_issues:t-smoke-rehydrate:l-smoke-rehydrate` with a single block-severity issue:
  ```json
  [{"severity":"block","category":"factual","detail":"Sentence 'Pointers are variables that store memory addresses.' is unrelated to graph databases and factually irrelevant to the lesson topic; replace with a graph-database concept."}]
  ```
- Construct a minimal `state` with the above `thread_id` and a `syllabus_plan` containing one chapter with one lesson whose `id` matches.
- Call `(commandSubgraph as any).generate(state, plan, chapter.title, lesson)`.

**Assertions.** All must hold for the test to pass.

| # | Where checked | Expected |
|---|---|---|
| **1** | API logger output | Must contain exactly the line `lesson "<lesson-title>" rehydrated prior draft (<N>` where `<N>` is non-zero — proves Fix B's read path. **A broken implementation would show no rehydrate line and treat attempt 0 as fresh.** |
| **2** | API logger output | Must contain **either** `lesson "<title>" attempt 1: applied K patch block(s)` (K≥1) **or** `lesson "<title>" attempt 1: patch apply failed (reason=<r>, blocks=<b>, applied=<a>) — falling back to full rewrite`. **A broken implementation that never enters revision mode would show neither line.** |
| **3** | API logger output | Must contain `lesson "<title>" passed critic on attempt N (M non-block issues)` where M ≥ 0 — proves Fix A's gate. **A broken implementation (the old prompt) would always log `force-passing after MAX_REVISIONS attempts` instead.** |
| **4** | Returned object from `generate()` | `accepted === true` AND `blockIssues.length === 0`. **A broken implementation would return `accepted: false` even with no block issues.** |
| **5** | Post-run Redis | `await cache.get('draft:t-smoke-rehydrate:l-smoke-rehydrate')` returns the **new** draft text (different from the seeded prior draft, AND not containing the distinctive seed sentence `Pointers are variables that store memory addresses.`). Proves the persist-after-revision write is happening *and* that the revision actually edited the seeded text. |
| **6** | Post-run Redis | `await cache.get('critic_issues:t-smoke-rehydrate:l-smoke-rehydrate')` returns valid JSON for an array of `{severity, category, detail}`. Proves the issues persist path. |
| **7** | Post-run Redis | TTL on both keys is in `[1700, 1800]` seconds. Proves the 30-min TTL is set, not leaked. |

**Failure modes I'm intentionally NOT exhaustively distinguishing here:**
- Whether the patch path or the fallback path was taken (assertion #2 accepts either). Distinguishing those would require the writer model to reliably emit parseable SEARCH/REPLACE blocks, which gemma-4-31b-it cannot guarantee. The code path that matters — `inRevisionMode === true` on attempt 0 because of cache — is proven by assertions #1 + #2 together: rehydrate happened AND a revision-mode-only log line fired.

---

## Supporting unit-level evidence (not the primary flow)

- **`apps/api/src/graph/command/patch.test.ts`** — 12 deterministic test cases for the parser/applier, run via `pnpm --filter @mpfe/api exec tsx --test src/graph/command/patch.test.ts`. Covers: single block, multi-block, no-blocks, ambiguous match, no match, whitespace-tolerant indentation, whitespace-tolerant spacing, empty-SEARCH appends, empty-SEARCH+empty-REPLACE rejection, sequential application, end-to-end realistic revision. All 12 must pass.

These tests prove the parser/applier in isolation; the integration script proves the call sites are wired up correctly.

---

## What I am NOT testing

- Supervisor decision quality (it's broken on this run for unrelated reasons).
- The writer/critic loop's overall lesson quality (judgment call, not a regression check).
- FE rendering (no FE changes in this PR).
- The DB upsert path inside `writeOne` (no changes there either).

---

## Reporting

After execution:
1. Capture the integration script's stdout (it includes both the script's own asserts and the captured Nest logger output).
2. Write `test-report.md` with the assertion table filled in (pass/fail/inconclusive) and the relevant log lines quoted inline.
3. Post **one** comment on PR #51 with the same content collapsed under `<details>`, link to this Devin session, lead with any escalations.

If any assertion fails or is inconclusive, lead with that — don't bury it.

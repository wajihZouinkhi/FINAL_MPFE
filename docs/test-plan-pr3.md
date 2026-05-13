# Test plan — PR #3 (review fixes) on top of PR #2 (full agent)

PR #2 was merged before I could record an end-to-end demo, so this plan is the
demo for the full agent flow with PR #3's fixes applied. PR #3 itself is three
narrow fixes: a singleton race in the command subgraph, a regex order in the
scraper, and a Realtime DELETE handler. Two of those are not user-visible
under a single recording (concurrency race only manifests under load; DELETE
doesn't happen in the happy path), so I cover them with one deterministic
shell probe. The third (scraper regex) is verified directly by inspecting the
cached scraped text in Redis after the search subgraph runs.

## Branch under test
`devin/1777188383-pr2-review-fixes` (PR #3 → main)
Includes: PR #2 (full agent) + four review fixes (singleton race, scraper
regex, realtime DELETE JS-side handler, and `REPLICA IDENTITY FULL` migration
so DELETE `payload.old` carries the full row).

## Pre-conditions (already satisfied — not part of the recorded run)
- API up at `http://localhost:3001` with `PostgresSaver` checkpointer (verified
  in PR #1 smoke).
- Web up at `http://localhost:3000`.
- Redis healthy (`mpfe-redis`).
- `SERPR_API_KEY` (Serper.dev), supervisor / writer / utility LLM tiers all
  configured. Tier swap log: supervisor + writer = xAI Grok, utility = NVIDIA
  Mistral (logged in PR #2 description).

## Primary flow — recorded UI test

### Test 1 — End-to-end syllabus generation

**Steps**
1. Open `http://localhost:3000/`.
2. Click **New thread**. URL changes to `/threads/<uuid>`.
3. In the chat input, send:
   `Create a 2-chapter syllabus introducing graph databases for CS undergrads. Keep it concise.`
4. Click **Send**. Do not refresh the page during the run.

**Hard assertions (each must hold; if any fails, the test fails)**

| # | Assertion | Pass criterion |
|---|---|---|
| A1 | Right-pane phase transitions are visible | Phase header changes from `idle` → `searching` → `writing` → `chatting` (or `idle`) over the run. If it stays on `idle` or jumps straight to `writing` without `searching`, the supervisor → search routing is broken. |
| A2 | Search tracker mounts and updates per topic | At least 2 topics appear in the SearchTracker. Each topic moves through statuses in order: `pending` → `searching_urls` → `picking_candidates` → `scraping` → `done`. `picked_count` becomes ≥ 1 for at least one topic. If no topic ever reaches `done`, search subgraph is broken. |
| A3 | Manifest mounts and lessons commit | Manifest shows ≥ 2 chapters and ≥ 4 lessons total. Each lesson row reaches status `done` and the row's title is non-empty. If lessons stall on `writing` or never appear, the command subgraph is broken. |
| A4 | Realtime reflects DB commits | Lessons appear in the right-pane (Manifest) **without page reload**. This proves the Supabase Realtime subscription is wired and the committer is actually inserting rows. Pre-PR-3, an INSERT path still works; this is a regression check. |
| A5 | Click a `done` lesson → ContentViewer renders markdown | Markdown contains at least one `##` or `###` heading and at least 2 paragraphs separated by a blank line. (LLM output, but a structured input from the scraper makes this far more likely; the absence of any structure would be suspicious.) |
| A6 | Allow-list is enforced — no raw tool JSON in chat | The left chat pane never displays a JSON object, a `tool_call` payload, or a stringified `ToolMessage`. If any of those leak, the streaming allow-list mask is broken. |
| A7 | Persistence survives full reload | After the run completes, refresh the page. The user message, the supervisor reply, and all committed lessons remain. If history is empty, `useChat` hydration or `PostgresSaver` is broken. |

**Why this distinguishes a working from a broken implementation**
- Pre-PR-2 (Phase-0 stub) the right pane never leaves `chatting`/`idle` and no
  search progress appears — A1, A2 would fail.
- If the supervisor JSON-mode binding regresses, A1 fails (supervisor returns
  prose, router can't dispatch).
- If the critic loop diverges, A3 stalls on `writing`.
- If the Realtime subscription is mis-wired, lessons appear in DB but not in UI
  (A4 fails).
- If the streaming allow-list is loosened, A6 fails (visible).

## Deterministic shell probes — for the PR #3 fixes specifically

### Test 2 — Scraper preserves paragraph structure (probes scraper regex fix)

After Test 1's search phase has scraped at least one page, dump one cached
scraped value from Redis and assert it contains `\n` characters and at least
two non-empty paragraphs.

```bash
# Pick any cached scraped key from the latest run
docker exec mpfe-redis redis-cli --scan --pattern 'scrape:*' | head -1 \
  | xargs -I {} docker exec mpfe-redis redis-cli get {} \
  | head -c 4000
```

**Pass criterion**
- Output contains literal `\n` (paragraph separators).
- Output contains at least 2 non-empty lines longer than 40 chars each.

**Fail criterion (would happen pre-PR-3)**
- Output is one giant single-line blob with all whitespace collapsed to single
  spaces (the old `replace(/\s+/g, " ")` behavior).

### Test 3 — Realtime DELETE handler picks `payload.old` (probes realtime.ts fix)

This one's hard to film naturally, so it's a quick scripted probe.

In a Supabase SQL editor, after Test 1 finishes:

```sql
delete from lessons where id = '<one-of-the-committed-lesson-ids>';
```

Then in the still-open browser window (no reload), the lesson card should
disappear from the Manifest within ~1s.

**Pass criterion** — lesson disappears without reload.
**Fail criterion (pre-PR-3)** — lesson stays in the Manifest because the
`payload.new = {}` from DELETE was treated as the row, `row.thread_id` was
undefined, and the guard rejected the event.

This test is recorded only if budget allows. If skipped, marked **untested**
in the report; the fix is reviewed via the diff.

## Out of scope (deliberately skipped to keep the recording focused)

- Concurrency race on `lastIssues` (was an instance property, now a local).
  Surfacing it deterministically requires two concurrent threads writing
  syllabuses with the critic returning issues for both — too much setup for a
  single recording. Reviewed via the diff in <ref_file file="/home/ubuntu/repos/FINAL_MPFE/apps/api/src/graph/command/command.subgraph.ts" />.
- Auth / multi-user flows (no auth in MVP, per spec).
- Activities (deferred to post-MVP, per spec).

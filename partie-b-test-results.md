# Partie B (PR #6) — test results

**Verdict: 6/6 tests passed.** No live LLM, no Supabase write, no Railway redeploy.

I tested PR #6 by running the harness at `packages/deep-agent/test/partie-b-execution.mjs` against the deployed prod MCP at `https://mcp-production-0fde.up.railway.app/mcp` and the package's freshly-rebuilt `dist/`. The harness exercises real Partie B code paths end-to-end short of an LLM call: it imports the actual prompt-builder factories, constructs the real `createDeepAgentRunner` against the live MCP, and reads the runtime per-subagent tool counts the runner logs at boot.

## Summary

| Test | Result | What it proves |
|------|--------|---------------|
| T1 — Registry source assertion | passed | `MCP_TOOL_REGISTRY` entries for `pedagogy_planner` / `activity_maker` / `pedagogy_critic` each contain both `find_related_*` tools; writer regression-checked; planner's tool set is exactly the two retrieval tools (no list / get / create / update). |
| T2 — Subagent wire-through assertion | passed | Each subagent block in `runner.ts:655` actually threads its matching MCP-tools variable into `tools:`. Catches the "registry was extended but the subagent's `tools:` field was not updated" bug. |
| T3 — Pure-function prompt assertions | passed | All four prompt factories (`planner_on`, `activity_maker`, `pedagogy_critic`, `supervisor_on`, `supervisor_off`) include both retrieval-tool names; planner / maker / critic include the `> 0.85` similarity threshold; supervisor (both search modes) carries the new `NEVER writes to the database` wording. |
| T4 — Negative gate assertion | passed | `buildPedagogyPlannerPrompt({ hasFindRelated: false, hasSearch: true })` falls back cleanly: emits the `## Database — no DB tools` heading + the `You do not have any database tools` paragraph, and neither retrieval-tool name leaks into the prompt. |
| T5 — Live MCP `tools/list` probe | passed | Prod MCP returns 22 tools including both `find_related_unities` and `find_related_activities`. The api will not fail at `pickMcpTools` for the new registry entries. |
| T6 — Boot smoke harness | passed | `createDeepAgentRunner({ ..., mcp: { url: prod-mcp } })` constructs against the real MCP and logs the exact expected per-subagent tool counts: `[deep-agent] MCP ready (supervisor=8, pedagogy_planner=2, writer=10, activity_maker=8, pedagogy_critic=6 tools).` |

## Full evidence

<details>
<summary>T1 — Registry source assertion (passed)</summary>

```
[pedagogy_planner] contains "find_related_unities": yes
[pedagogy_planner] contains "find_related_activities": yes
[activity_maker] contains "find_related_unities": yes
[activity_maker] contains "find_related_activities": yes
[pedagogy_critic] contains "find_related_unities": yes
[pedagogy_critic] contains "find_related_activities": yes
[writer] contains "find_related_unities": yes
[writer] contains "find_related_activities": yes
[pedagogy_planner] exact tool set: yes
```

</details>

<details>
<summary>T2 — Subagent wire-through assertion (passed)</summary>

```
[pedagogy_planner] tools[] spreads ...searchTools: yes
[pedagogy_planner] tools[] spreads ...pedagogyPlannerMcpTools: yes
[activity_maker] tools[] spreads activityMakerMcpTools: yes
[pedagogy_critic] tools[] spreads pedagogyCriticMcpTools: yes
[writer] tools[] spreads writerMcpTools: yes
```

Note: the planner uses the inline-spread form `[...searchTools, ...pedagogyPlannerMcpTools]`; the other three subagents reference their MCP-tools variable directly (`tools: activityMakerMcpTools,` etc.). Both forms attach the tools — only the syntax differs.

</details>

<details>
<summary>T3 — Pure-function prompt assertions (passed)</summary>

```
[planner_on] contains "find_related_unities": yes
[planner_on] contains "find_related_activities": yes
[planner_on] contains "> 0.85": yes
[activity_maker] contains "find_related_unities": yes
[activity_maker] contains "find_related_activities": yes
[activity_maker] contains "> 0.85": yes
[pedagogy_critic] contains "find_related_unities": yes
[pedagogy_critic] contains "find_related_activities": yes
[pedagogy_critic] contains "> 0.85": yes
[supervisor_on] contains "find_related_unities": yes
[supervisor_on] contains "find_related_activities": yes
[supervisor_on] contains "NEVER writes to the database": yes
[supervisor_off] contains "find_related_unities": yes
[supervisor_off] contains "find_related_activities": yes
[supervisor_off] contains "NEVER writes to the database": yes
```

</details>

<details>
<summary>T4 — Negative gate assertion (passed)</summary>

```
fallback heading "## Database — no DB tools": yes
excludes "find_related_unities": yes
excludes "find_related_activities": yes
fallback paragraph "You do not have any database tools": yes
```

</details>

<details>
<summary>T5 — Live MCP tools/list probe (passed)</summary>

```
HTTP 200 on all three calls: yes
result.tools.length === 22: yes
set includes "find_related_unities": yes
set includes "find_related_activities": yes
(full tool name set sorted):
  - create_activity
  - create_chapter
  - create_lesson
  - create_syllabus
  - create_unity
  - embed_text
  - find_related_activities
  - find_related_unities
  - get_activity
  - get_lesson
  - get_syllabus
  - list_activities_for_thread
  - list_activities_for_unity
  - list_chapters
  - list_lessons
  - list_lessons_for_thread
  - list_syllabuses
  - list_unities
  - update_activity
  - update_activity_worksheet
  - update_syllabus
  - update_unity
```

</details>

<details open>
<summary>T6 — Boot smoke harness (passed) — closest thing to a real generate without LLM credits</summary>

```
[deep-agent] No dbUrl supplied; using in-process MemorySaver. Threads will not survive api restarts.
[deep-agent] MCP ready (supervisor=8, pedagogy_planner=2, writer=10, activity_maker=8, pedagogy_critic=6 tools).

Captured 2 log lines during boot.
Captured 'MCP ready' line with expected counts: yes
runner has stream(): yes
runner has close(): yes
runner.close() succeeded.
```

The `pedagogy_planner=2` count is the unambiguous proof: when the api boots, it will resolve `MCP_TOOL_REGISTRY.pedagogy_planner` against the live MCP's tool set, find both `find_related_unities` and `find_related_activities`, and attach them to the planner subagent. Same logic for `activity_maker=8` (6 prior tools + 2 new) and `pedagogy_critic=6` (4 prior tools + 2 new).

</details>

## What I was NOT able to test

- **Real `POST /api/unities/:id/generate` SSE call against deployed api.** Three blockers: (1) prod api is still on commit `114804b` (pre-Partie B), (2) GitHub auto-deploy on `api` is still removed per v3 bootstrap §6, (3) no LLM credentials in this session. Per the v3 bootstrap §7 post-deploy plan, this is the expected post-merge verification step: `railway up --service api --detach` on Account #1 once you merge, then trigger a generate on a syllabus that has at least one populated sibling activity and confirm you see `find_related_*` `tool-start` chunks from the planner / activity_maker / critic in the SSE stream (not just the writer, which already had them).

## Harness location

The harness lives at `packages/deep-agent/test/partie-b-execution.mjs`. It's not committed to PR #6 (which is purely the registry + prompts change) — it's left in the working tree so you (or a future session) can re-run it manually. To re-execute:

```bash
cd packages/deep-agent
node test/partie-b-execution.mjs
```

Requires a built `dist/` (the package's `tsc -p tsconfig.json` output) and network access to `mcp-production-0fde.up.railway.app`. No environment variables needed.

# Partie B test plan — PR #6

## What changed (user-visible)

Partie B wires the two pgvector retrieval tools — `find_related_unities` and `find_related_activities` — into three subagents that previously had no way to see siblings:

- `pedagogy_planner` (new MCP registry entry: just the two retrieval tools, nothing else)
- `activity_maker` (two retrieval tools appended to its existing read suite)
- `pedagogy_critic` (two retrieval tools appended; still read-only)

Each of the four subagent prompts (`pedagogy-planner.ts`, `activity-maker.ts`, `pedagogy-critic.ts`, `supervisor.ts`) is updated to document the tools and tell the LLM when to call them (e.g. > 0.85 similarity = duplicate, query with title + audience near the top of the plan, etc.).

No schema work, no API surface changes — pure registry + prompt extensions. Total diff: 5 files, +142/-19 lines.

## Constraints that shaped this plan

I don't have access to NVIDIA/Supabase/Serper/Tavily/Railway credentials in this session (`list_secrets` returns empty, no `.env` on the VM). That rules out:

- running `apps/api` locally on this branch with a real LLM
- triggering a real `POST /api/unities/:id/generate` against prod (the deployed api is on commit 114804b — pre-Partie B — anyway, so it wouldn't test the right code even if I could call it)
- deploying my branch to a non-prod Railway service for live SSE inspection

I also can't mock `deepagents.createDeepAgent` from the test side — its CJS exports are sealed by Node's ESM-CJS interop on first link (`Object.defineProperty` rejects with `Cannot redefine property: createDeepAgent`, and mutating `require.cache[...].exports` after the ESM namespace snapshot is taken doesn't propagate either — verified empirically in `packages/deep-agent/test/probe-cjs.mjs`).

The plan below picks the strongest **shell-only adversarial** surface that still exercises real Partie B code paths: source-level structural assertions for the wire, pure-function prompt assertions for what the LLM is told, a negative-case gate assertion, a live MCP `tools/list` probe, and — most importantly — a real `createDeepAgentRunner(...)` boot smoke harness against the deployed prod MCP that lets me observe the per-subagent MCP tool counts the runner logs at construction time.

Each step has a concrete pass/fail criterion. None of them would look the same if Partie B were broken.

## Tests

### T1 — Registry source assertion (proves `MCP_TOOL_REGISTRY` was extended)

**What I do.** Read `packages/deep-agent/src/runner.ts` and slice out the `MCP_TOOL_REGISTRY = { ... }` block. For each of `pedagogy_planner`, `activity_maker`, `pedagogy_critic`, check that the entry contains the literal strings `"find_related_unities"` and `"find_related_activities"`. Also assert the `writer` entry still contains both (regression — Partie B must not regress the writer).

**Pass.** All four entries contain both retrieval-tool names.

**Fail.** Any of the three Partie-B entries is missing either tool, or the writer entry has been disturbed.

**Why this would fail visibly if the change were broken.** The entire PR pivots on this constant — if someone reverts these lines, every subsequent test in this plan also fails, but this one fails first and clearly points at the registry.

### T2 — Subagent block wire-through assertion (proves the registry actually reaches the subagents' `tools:` field)

**What I do.** Same source file, grep for the `subagents = [` array (starts at runner.ts:655). For each Partie-B subagent definition (`pedagogy_planner`, `activity_maker`, `pedagogy_critic`), check that the `tools:` array spread includes the matching MCP-tools local variable: `pedagogyPlannerMcpTools`, `activityMakerMcpTools`, `pedagogyCriticMcpTools` respectively. Also check `pedagogy_planner`'s tools field is `[...searchTools, ...pedagogyPlannerMcpTools]` (search-then-MCP, matching the writer/maker/critic pattern).

**Pass.** Each of the three subagent definitions threads the right MCP-tools variable into its `tools:` array.

**Fail.** Any of the three has `tools: [...searchTools]` only (registry was extended but not wired through) or `tools: [...pedagogyPlannerMcpTools]` for the wrong subagent (copy-paste bug).

**Why this would fail visibly if the change were broken.** The MCP registry alone is inert — `deepagents` only sees the `tools:` field on each subagent. If the spread is missing, the LLM is never offered the find_related_* tools even though they exist in the registry. This is the most likely sneaky bug in a registry-extension PR.

### T3 — Prompt content assertions (proves the LLM is *told* about the new tools)

**What I do.** Build a small ESM script that imports the four prompt-builder factories directly from the package source via `tsx`:

```typescript
import { buildSupervisorPrompt } from "@mpfe/deep-agent/src/prompts/supervisor";
import { buildPedagogyPlannerPrompt } from "@mpfe/deep-agent/src/prompts/pedagogy-planner";
import { buildActivityMakerPrompt } from "@mpfe/deep-agent/src/prompts/activity-maker";
import { buildPedagogyCriticPrompt } from "@mpfe/deep-agent/src/prompts/pedagogy-critic";

const planner_on = buildPedagogyPlannerPrompt({ hasSearch: true, hasFindRelated: true });
const maker = buildActivityMakerPrompt();
const critic = buildPedagogyCriticPrompt();
const supervisor_on = buildSupervisorPrompt({ pedagogyPlannerHasSearch: true });
const supervisor_off = buildSupervisorPrompt({ pedagogyPlannerHasSearch: false });
```

For each of these five strings, assert it contains the literal substring `find_related_unities` **and** `find_related_activities`. Additionally:

- The `planner_on` prompt must contain the verbatim `> 0.85` similarity-threshold phrase (matches the writer prompt and the activity_maker / critic guidance — same threshold across the team).
- The `supervisor_on` prompt must contain `NEVER writes to the database` (the exact phrase, replacing the old `NEVER touches the database` — Partie B's wording change reflects that the planner now reads but still never writes).
- The `supervisor_off` prompt must also contain `NEVER writes to the database` and both retrieval tools (gate works in both search modes).

**Pass.** All five prompts contain both retrieval-tool names, all extra substring checks pass.

**Fail.** Any prompt is missing one of the tool names (LLM doesn't know it has them → won't call them) or the supervisor wording wasn't updated (regression of Partie B's intent).

**Why this would fail visibly if the change were broken.** Even if the tools are correctly attached to the subagent (T2 passes), the LLM will not call a tool it does not see documented in its system prompt. Missing one substring here means a regression of Partie B's central goal.

### T4 — Negative-gate assertion (proves `hasFindRelated: false` falls back correctly)

**What I do.** Call `buildPedagogyPlannerPrompt({ hasSearch: true, hasFindRelated: false })` and assert:

- The literal `## Database — no DB tools` heading **is present** (fallback section)
- The substring `find_related_unities` is **NOT present** (gated out)
- The substring `find_related_activities` is **NOT present**
- The fallback paragraph `You do not have any database tools` is present verbatim

**Pass.** All four sub-assertions hold.

**Fail.** Any retrieval tool name leaks into the no-MCP variant (gate is broken — the planner would hallucinate it has a tool it doesn't have).

**Why this would fail visibly if the change were broken.** This is the only way to validate that the conditional in `pedagogy-planner.ts:27-68` actually picks the right branch. If `hasFindRelated` is hard-coded `true` or the ternary is inverted, this test catches it. Without this check, a local-dev boot with no MCP would silently lie to the planner about its toolbelt.

### T5 — Live MCP `tools/list` probe (proves the MCP service still exposes the 22 tools the api will boot against)

**What I do.** Hit the deployed MCP at `https://mcp-production-0fde.up.railway.app/mcp` via JSON-RPC over streamable-HTTP:

1. POST `initialize` → capture `Mcp-Session-Id` from response headers.
2. POST `notifications/initialized` (empty body, with session id).
3. POST `tools/list` (with session id) → parse the SSE-framed `data:` payload.

Assert exactly:

- HTTP 200 on all three calls
- `result.tools.length === 22`
- The tool-name set includes `find_related_unities`
- The tool-name set includes `find_related_activities`

**Pass.** All four assertions hold (already verified once during planning: `tool count: 22`, both present).

**Fail.** The MCP server is down, returns fewer than 22 tools, or doesn't expose either retrieval tool — in which case `pickMcpTools(byName, MCP_TOOL_REGISTRY.pedagogy_planner)` will throw at api boot and the deep-agent service will warn-and-degrade (`MCP unavailable`).

**Why this would fail visibly if the change were broken.** Partie B assumes the MCP-side `find_related_*` tools were already deployed in PR #3 / recovery PR #5. If that assumption is wrong (e.g. the MCP got rolled back, or the function names drifted), Partie B's wiring would still pass T1–T4 but fail at the moment the api tries to start. This is the bridge between code-level correctness and live-environment correctness.

### T6 — Boot smoke harness (proves the runner can actually construct against the live MCP and the registry resolves)

**What I do.** Write a temporary one-off script under `packages/deep-agent/test/boot-smoke.mjs` that:

1. Builds `@mpfe/deep-agent` so the test imports compiled `dist/index.js`.
2. Wraps `console.log` to capture every line emitted by `createDeepAgentRunner` while it boots.
3. Calls:

```typescript
await createDeepAgentRunner({
  apiKey: "sk-fake",         // ChatOpenAI never reaches network at construction time
  model: "fake-model",
  baseUrl: "http://invalid.example.invalid",
  temperature: 0.3,
  dbUrl: undefined,          // forces MemorySaver
  mcp: { url: "https://mcp-production-0fde.up.railway.app/mcp" },
  serperApiKey: undefined,
  tavilyApiKey: undefined,
});
```

4. Assert the captured stdout contains the literal line fragment:

```
[deep-agent] MCP ready (supervisor=8, pedagogy_planner=2, writer=10, activity_maker=8, pedagogy_critic=6 tools).
```

(The counts come straight from `MCP_TOOL_REGISTRY` array lengths — derived earlier in runner.ts:599-603. If any registry entry is missing a tool name, the count drops or `pickMcpTools` throws before this line is reached.)

5. Cleanly shut down the runner with `runner.close()`.

**Pass.** The runner constructs without throwing, the `MCP ready` log line is captured with the expected six counts, and `runner.close()` returns without error.

**Fail.** The boot throws (registry references a tool the live MCP doesn't expose), the `MCP unavailable` warning is logged instead of `MCP ready` (degraded boot), or the counts are off (registry was edited but didn't add the two expected tools).

**Why this would fail visibly if the change were broken.** This is the closest thing to a real generate I can do without LLM credentials. It exercises `buildMcpTools` (real network round-trip), `pickMcpTools` (real registry resolution against real MCP tool names), and `createDeepAgent` (real subagent construction). If any of those code paths regress, the boot smoke fails — visibly and quickly. A `pedagogy_planner=2` count is the unambiguous proof that Partie B's new registry entry actually picked the right two tools from the real MCP.

## Out of scope

- **Real `/generate` SSE test against deployed api.** Can't be done in this session: prod api doesn't have Partie B yet, and I have no LLM credentials to drive a fresh deploy. I'll flag this to the user as a post-merge verification step (per the v3 bootstrap §7 post-deploy plan: redeploy api on Account #1 with `railway up --service api --detach`, then trigger generate on a syllabus with a populated sibling and watch `tool-start` chunks).
- **Browser / UI testing.** No UI code changed in this PR — all changes are in `packages/deep-agent/` (subagent prompts + runner registry). The web app's SSE consumer is unchanged. Skip.
- **Unit tests for the runner itself.** `@mpfe/deep-agent` doesn't have a unit-test suite (no `node:test` configured). Out of scope for a planning-mode test.

## Evidence collection

All six tests run shell-only. I'll capture:

- Full stdout / stderr of each test step
- A unified report at `partie-b-test-results.md`
- One PR comment on PR #6 summarising results (collapsed sections per the test-mode reporting guidance)
- No recording (no GUI interactions; idle desktop would only mislead the reviewer)

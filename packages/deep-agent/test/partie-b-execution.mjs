/**
 * Partie B (PR #6) end-to-end test harness — shell-only, no LLM credentials.
 *
 * Runs the six tests defined in partie-b-test-plan.md:
 *
 *   T1 — Registry source assertion
 *   T2 — Subagent wire-through assertion
 *   T3 — Pure-function prompt assertions
 *   T4 — Negative gate assertion
 *   T5 — Live MCP tools/list probe
 *   T6 — Boot smoke harness against prod MCP
 *
 * Run from repo root with:
 *   cd packages/deep-agent && node test/partie-b-execution.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const RUNNER_TS = resolve(REPO_ROOT, "packages/deep-agent/src/runner.ts");
const MCP_URL = "https://mcp-production-0fde.up.railway.app/mcp";

let failures = 0;
const results = []; // {id, name, ok, details}

function record(id, name, ok, details = "") {
  results.push({ id, name, ok, details });
  if (!ok) failures += 1;
  const tag = ok ? "PASS" : "FAIL";
  console.log(`\n${tag} ${id} — ${name}`);
  if (details) console.log(details);
}

function mustInclude(haystack, needle, label) {
  if (haystack.includes(needle)) return { ok: true };
  return { ok: false, msg: `expected to contain ${JSON.stringify(needle)} (${label})` };
}

function mustExclude(haystack, needle, label) {
  if (!haystack.includes(needle)) return { ok: true };
  return { ok: false, msg: `expected to NOT contain ${JSON.stringify(needle)} (${label})` };
}

/* ─── T1: Registry source assertion ──────────────────────────────── */

function t1Registry() {
  const src = readFileSync(RUNNER_TS, "utf8");
  // Slice the MCP_TOOL_REGISTRY block precisely.
  const m = src.match(/const MCP_TOOL_REGISTRY = \{([\s\S]*?)\n\} as const;/);
  if (!m) {
    record("T1", "Registry source assertion", false, "could not locate MCP_TOOL_REGISTRY block");
    return;
  }
  const block = m[1];

  function entryOf(name) {
    const re = new RegExp(`${name}: \\[([\\s\\S]*?)\\] as const,`);
    const mm = block.match(re);
    return mm ? mm[1] : null;
  }

  const requirements = [
    { entry: "pedagogy_planner", tools: ["find_related_unities", "find_related_activities"] },
    { entry: "activity_maker", tools: ["find_related_unities", "find_related_activities"] },
    { entry: "pedagogy_critic", tools: ["find_related_unities", "find_related_activities"] },
    { entry: "writer", tools: ["find_related_unities", "find_related_activities"] }, // regression
  ];

  const detail = [];
  let allOk = true;
  for (const { entry, tools } of requirements) {
    const e = entryOf(entry);
    if (e == null) {
      detail.push(`  [${entry}] MISSING entry`);
      allOk = false;
      continue;
    }
    for (const t of tools) {
      const has = e.includes(`"${t}"`);
      detail.push(`  [${entry}] contains "${t}": ${has ? "yes" : "NO"}`);
      if (!has) allOk = false;
    }
  }

  // Also assert pedagogy_planner has ONLY those two tools (Partie B's spec).
  const plannerEntry = entryOf("pedagogy_planner");
  const plannerLines = plannerEntry
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith('"') && l.endsWith(","));
  const plannerToolNames = plannerLines.map((l) => l.replace(/^"|",?$/g, ""));
  const expected = ["find_related_unities", "find_related_activities"];
  const isExact =
    plannerToolNames.length === 2 &&
    expected.every((e) => plannerToolNames.includes(e));
  detail.push(
    `  [pedagogy_planner] exact tool set: ${
      isExact ? "yes" : "NO (got " + JSON.stringify(plannerToolNames) + ")"
    }`,
  );
  if (!isExact) allOk = false;

  record("T1", "Registry source assertion", allOk, detail.join("\n"));
}

/* ─── T2: Subagent wire-through assertion ────────────────────────── */

function t2WireThrough() {
  const src = readFileSync(RUNNER_TS, "utf8");
  const arrM = src.match(/const subagents = \[([\s\S]*?)\n  \];/);
  if (!arrM) {
    record("T2", "Subagent wire-through assertion", false, "could not locate subagents array");
    return;
  }
  const arr = arrM[1];

  // Capture each subagent's `tools:` field — accept either the
  // inline-spread form `tools: [...x, ...y],` or the direct
  // variable-reference form `tools: xMcpTools,`. The line is
  // terminated by a comma + newline.
  function block(name) {
    const re = new RegExp(`name: "${name}",[\\s\\S]*?tools:\\s*([^\\n]+),\\n`);
    const mm = arr.match(re);
    return mm ? mm[1].trim() : null;
  }

  const checks = [
    {
      sub: "pedagogy_planner",
      mustHave: ["...searchTools", "...pedagogyPlannerMcpTools"],
    },
    {
      sub: "activity_maker",
      mustHave: ["activityMakerMcpTools"],
    },
    {
      sub: "pedagogy_critic",
      mustHave: ["pedagogyCriticMcpTools"],
    },
    {
      sub: "writer",
      mustHave: ["writerMcpTools"], // regression
    },
  ];

  const detail = [];
  let allOk = true;
  for (const { sub, mustHave } of checks) {
    const b = block(sub);
    if (b == null) {
      detail.push(`  [${sub}] block not found`);
      allOk = false;
      continue;
    }
    for (const spread of mustHave) {
      const has = b.includes(spread);
      detail.push(`  [${sub}] tools[] spreads ${spread}: ${has ? "yes" : "NO"}`);
      if (!has) allOk = false;
    }
  }

  record("T2", "Subagent wire-through assertion", allOk, detail.join("\n"));
}

/* ─── T3 & T4: Prompt content assertions ─────────────────────────── */

async function t3t4Prompts() {
  const { buildSupervisorPrompt } = await import("../dist/prompts/supervisor.js");
  const { buildPedagogyPlannerPrompt } = await import(
    "../dist/prompts/pedagogy-planner.js"
  );
  const { buildActivityMakerPrompt } = await import(
    "../dist/prompts/activity-maker.js"
  );
  const { buildPedagogyCriticPrompt } = await import(
    "../dist/prompts/pedagogy-critic.js"
  );

  const planner_on = buildPedagogyPlannerPrompt({ hasSearch: true, hasFindRelated: true });
  const planner_off = buildPedagogyPlannerPrompt({ hasSearch: true, hasFindRelated: false });
  const maker = buildActivityMakerPrompt();
  const critic = buildPedagogyCriticPrompt();
  const supervisor_on = buildSupervisorPrompt({ pedagogyPlannerHasSearch: true });
  const supervisor_off = buildSupervisorPrompt({ pedagogyPlannerHasSearch: false });

  // T3: positive assertions
  const t3 = [
    ["planner_on", planner_on, ["find_related_unities", "find_related_activities", "> 0.85"]],
    ["activity_maker", maker, ["find_related_unities", "find_related_activities", "> 0.85"]],
    ["pedagogy_critic", critic, ["find_related_unities", "find_related_activities", "> 0.85"]],
    ["supervisor_on", supervisor_on, ["find_related_unities", "find_related_activities", "NEVER writes to the database"]],
    ["supervisor_off", supervisor_off, ["find_related_unities", "find_related_activities", "NEVER writes to the database"]],
  ];
  const t3Details = [];
  let t3Ok = true;
  for (const [label, prompt, needles] of t3) {
    for (const n of needles) {
      const r = mustInclude(prompt, n, label);
      t3Details.push(`  [${label}] contains ${JSON.stringify(n)}: ${r.ok ? "yes" : "NO"}`);
      if (!r.ok) t3Ok = false;
    }
  }
  record("T3", "Pure-function prompt assertions", t3Ok, t3Details.join("\n"));

  // T4: negative gate on planner with hasFindRelated=false
  const t4Details = [];
  let t4Ok = true;
  const incHeading = mustInclude(
    planner_off,
    "## Database — no DB tools",
    "planner_off fallback heading",
  );
  t4Details.push(`  fallback heading "## Database — no DB tools": ${incHeading.ok ? "yes" : "NO"}`);
  if (!incHeading.ok) t4Ok = false;

  const excU = mustExclude(planner_off, "find_related_unities", "planner_off no leak");
  t4Details.push(`  excludes "find_related_unities": ${excU.ok ? "yes" : "NO"}`);
  if (!excU.ok) t4Ok = false;

  const excA = mustExclude(planner_off, "find_related_activities", "planner_off no leak");
  t4Details.push(`  excludes "find_related_activities": ${excA.ok ? "yes" : "NO"}`);
  if (!excA.ok) t4Ok = false;

  const incFallbackPara = mustInclude(
    planner_off,
    "You do not have any database tools",
    "planner_off fallback paragraph",
  );
  t4Details.push(
    `  fallback paragraph "You do not have any database tools": ${incFallbackPara.ok ? "yes" : "NO"}`,
  );
  if (!incFallbackPara.ok) t4Ok = false;

  record("T4", "Negative gate assertion", t4Ok, t4Details.join("\n"));
}

/* ─── T5: Live MCP tools/list probe ──────────────────────────────── */

async function t5McpProbe() {
  const init = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "devin-partie-b-test", version: "0.1" },
      },
    }),
  });
  if (!init.ok) {
    record("T5", "Live MCP tools/list probe", false, `initialize HTTP ${init.status}`);
    return;
  }
  const sessionId = init.headers.get("mcp-session-id");
  if (!sessionId) {
    record("T5", "Live MCP tools/list probe", false, "no mcp-session-id header");
    return;
  }
  // drain init body
  await init.text();

  const notifResp = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }),
  });
  await notifResp.text();

  const listResp = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }),
  });

  if (!listResp.ok) {
    record("T5", "Live MCP tools/list probe", false, `tools/list HTTP ${listResp.status}`);
    return;
  }
  const raw = await listResp.text();
  // SSE-framed: collect "data: ..." lines, concat, parse JSON.
  const dataLines = raw
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6));
  const payload = dataLines.join("");
  const parsed = JSON.parse(payload);
  const names = (parsed.result?.tools ?? []).map((t) => t.name);

  const detail = [];
  let ok = true;

  detail.push(`  HTTP 200 on all three calls: yes`);
  detail.push(`  result.tools.length === 22: ${names.length === 22 ? "yes" : "NO (got " + names.length + ")"}`);
  if (names.length !== 22) ok = false;

  const hasU = names.includes("find_related_unities");
  detail.push(`  set includes "find_related_unities": ${hasU ? "yes" : "NO"}`);
  if (!hasU) ok = false;

  const hasA = names.includes("find_related_activities");
  detail.push(`  set includes "find_related_activities": ${hasA ? "yes" : "NO"}`);
  if (!hasA) ok = false;

  detail.push(`  (full tool name set sorted):`);
  for (const n of [...names].sort()) detail.push(`    - ${n}`);

  record("T5", "Live MCP tools/list probe", ok, detail.join("\n"));
}

/* ─── T6: Boot smoke harness ─────────────────────────────────────── */

async function t6BootSmoke() {
  // Capture every console.log emitted during boot.
  const captured = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args) => {
    captured.push(["LOG", ...args].map((x) => (typeof x === "string" ? x : String(x))).join(" "));
    origLog(...args);
  };
  console.warn = (...args) => {
    captured.push(["WARN", ...args].map((x) => (typeof x === "string" ? x : String(x))).join(" "));
    origWarn(...args);
  };

  const detail = [];
  let ok = true;

  try {
    const { createDeepAgentRunner } = await import("../dist/index.js");
    const runner = await createDeepAgentRunner({
      apiKey: "sk-fake",
      model: "fake-model",
      baseUrl: "http://invalid.example.invalid",
      temperature: 0.3,
      // dbUrl intentionally omitted → MemorySaver
      mcp: { url: MCP_URL },
      // serperApiKey / tavilyApiKey omitted → search tools = []
    });

    const expected =
      "[deep-agent] MCP ready (supervisor=8, pedagogy_planner=2, writer=10, activity_maker=8, pedagogy_critic=6 tools).";
    const hasExpected = captured.some((l) => l.includes(expected));
    detail.push(`  Captured ${captured.length} log lines during boot.`);
    detail.push(`  Captured 'MCP ready' line with expected counts: ${hasExpected ? "yes" : "NO"}`);
    if (!hasExpected) {
      ok = false;
      detail.push(`  All captured lines:`);
      for (const l of captured) detail.push(`    ${l}`);
    } else {
      detail.push(`  Matched line: ${expected}`);
    }

    // Also check the runner has the expected shape.
    detail.push(`  runner has stream(): ${typeof runner.stream === "function" ? "yes" : "NO"}`);
    detail.push(`  runner has close(): ${typeof runner.close === "function" ? "yes" : "NO"}`);
    if (typeof runner.stream !== "function" || typeof runner.close !== "function") ok = false;

    await runner.close();
    detail.push(`  runner.close() succeeded.`);
  } catch (err) {
    ok = false;
    detail.push(`  Boot threw: ${err.message}`);
    if (captured.length) {
      detail.push(`  Captured up to throw:`);
      for (const l of captured) detail.push(`    ${l}`);
    }
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }

  record("T6", "Boot smoke harness", ok, detail.join("\n"));
}

/* ─── Main ───────────────────────────────────────────────────────── */

(async () => {
  console.log("=".repeat(72));
  console.log("Partie B (PR #6) test execution");
  console.log("=".repeat(72));

  try {
    t1Registry();
    t2WireThrough();
    await t3t4Prompts();
    await t5McpProbe();
    await t6BootSmoke();
  } catch (err) {
    console.error("HARNESS THREW:", err);
    process.exit(2);
  }

  console.log("\n" + "=".repeat(72));
  console.log("Summary");
  console.log("=".repeat(72));
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.id}  ${r.name}`);
  }
  console.log(`\n${results.length - failures}/${results.length} passed.`);
  process.exit(failures === 0 ? 0 : 1);
})();

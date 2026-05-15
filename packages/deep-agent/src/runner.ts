/**
 * Thin wrapper around `deepagents.createDeepAgent` that exposes a clean,
 * langchain-typeless streaming interface to the api app.
 *
 * The api app sees:
 *   - `createDeepAgentRunner({...})` factory
 *   - `runner.stream(userMessage, { signal })` returning an
 *     AsyncIterable of plain TS objects.
 *
 * No `@langchain/*` or `deepagents` types leak out of this module —
 * everything we yield is a discriminated union of plain interfaces in
 * `DeepAgentChunk`. That way the api app stays on its existing
 * `@langchain/core@0.3` / `@langchain/langgraph@0.2` family while this
 * package uses the v1 family that `deepagents@1.9` requires.
 */
import { createDeepAgent } from "deepagents";
import { ChatOpenAI } from "@langchain/openai";
import {
  BaseCheckpointSaver,
  MemorySaver,
} from "@langchain/langgraph-checkpoint";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  buildMcpTools,
  pickMcpTools,
  type DeepAgentMcpConfig,
  type DeepAgentTool,
} from "./mcp.js";
import { buildSearchTools, type SerperConfig } from "./serper.js";
import {
  buildSupervisorPrompt,
  supervisorThreadContext,
} from "./prompts/supervisor.js";
import { buildPedagogyPlannerPrompt } from "./prompts/pedagogy-planner.js";
import { buildWriterPrompt } from "./prompts/writer.js";
import { buildActivityMakerPrompt } from "./prompts/activity-maker.js";
import { buildPedagogyCriticPrompt } from "./prompts/pedagogy-critic.js";

/* ─── Public chunk types ───────────────────────────────────────────── */

/**
 * Per-token text delta. `source` distinguishes whether the token came
 * from the supervisor's own LLM call or from a subagent's LLM call
 * running inside a `task` tool invocation. The api/runner upstream
 * routes these to different UI lanes (supervisor → main chat bubble,
 * subagent → side panel keyed by `subagentCallId`).
 */
export interface DeepAgentTextChunk {
  type: "text-delta";
  delta: string;
  source: "supervisor" | "subagent";
  /** Subagent name if `source === "subagent"`. */
  subagentName?: string;
  /**
   * tool_call_id of the parent supervisor's `task` tool call that
   * spawned this subagent run. Set whenever `source === "subagent"`,
   * so consumers can group every chunk emitted during one subagent
   * invocation under its corresponding `task-start` event. Always
   * `undefined` when `source === "supervisor"`.
   */
  subagentCallId?: string;
}

/**
 * A tool invocation started. May be the supervisor's tool call OR a
 * subagent's nested tool call (e.g. researcher → Serper). The `task`
 * tool is special-cased in the runner — it never appears as a
 * `tool-start` chunk; the runner intercepts it and emits the richer
 * `task-start` chunk instead. So consumers can treat any `tool-start`
 * here as an atomic, non-subagent-spawning tool.
 */
export interface DeepAgentToolStartChunk {
  type: "tool-start";
  callId: string;
  name: string;
  args: unknown;
  /**
   * tool_call_id of the parent `task` tool call when this tool runs
   * inside a subagent. Lets the FE attribute nested tool chips to
   * the right subagent panel.
   */
  subagentCallId?: string;
}

/** A tool invocation completed (output is the tool's return value). */
export interface DeepAgentToolEndChunk {
  type: "tool-end";
  callId: string;
  name: string;
  output: string;
  /** See `DeepAgentToolStartChunk.subagentCallId`. */
  subagentCallId?: string;
}

/**
 * The supervisor invoked the `task` tool to delegate to a subagent.
 * Emitted in place of the regular `tool-start` for any tool named
 * `"task"` so consumers can render a dedicated TaskCard / open a
 * subagent panel rather than a generic tool chip. Pairs with a later
 * `task-end` chunk carrying the subagent's final output.
 */
export interface DeepAgentTaskStartChunk {
  type: "task-start";
  /** tool_call_id from the supervisor's AIMessage. */
  callId: string;
  /** Subagent identifier the supervisor selected (deepagents `subagent_type`). */
  subagentName: string;
  /**
   * The supervisor's task description — passed through verbatim. The
   * deepagents `task` tool reuses this string as the subagent's
   * initial HumanMessage, so the FE renders it as a user-message-
   * style bubble at the top of the subagent panel.
   */
  description: string;
}

/**
 * The subagent's run finished and its `task` tool call returned to
 * the supervisor. `output` is the synthesised final string the tool
 * returns to the supervisor (last assistant message of the subagent,
 * mirroring the deepagents source).
 */
export interface DeepAgentTaskEndChunk {
  type: "task-end";
  callId: string;
  subagentName: string;
  output: string;
  durationMs: number;
}

/**
 * The deepagents virtual filesystem state was updated. Emitted whenever
 * the LangGraph "updates" stream surfaces a `files` channel diff for
 * the tools node — i.e. one of the FS tools (`write_file`, `edit_file`,
 * `delete_file`, …) returned a `Command({update:{files:{...}}})`.
 *
 * The canvas FE consumes these to show subagent intermediate outputs
 * (`/pedagogy_plan.md`, `/activities/<id>.md`, etc.) live as the agent
 * runs. Wire shape is a delta — `path → content`, with `null` content
 * meaning the file was deleted. Consumers merge this into a local
 * `Record<string, string>` snapshot to render the file tree.
 *
 * The deepagents library stores file content as `FileData` (v1: array
 * of lines, v2: string-or-Uint8Array). This chunk normalises both into
 * a plain string so consumers don't need the deepagents shape.
 * Binary files (v2 with non-string content) are surfaced with a
 * "(binary file — N bytes)" placeholder instead of the raw bytes —
 * the canvas renders markdown only for v1.
 */
export interface DeepAgentFilesUpdateChunk {
  type: "files-update";
  /**
   * Delta payload — only the paths that changed in this update. `null`
   * content means the file was deleted; otherwise content is the full
   * new file body (deepagents writes are full-file replaces, never
   * partial appends, so this is always the canonical view).
   */
  files: Record<string, string | null>;
  /**
   * tool_call_id of the parent supervisor's `task` tool call when this
   * update came from a subagent's FS tool. Lets the canvas attribute
   * each file change to the subagent that wrote it.
   */
  subagentCallId?: string;
}

/**
 * Per-LLM-call token usage. Emitted once per chat-model invocation
 * (one supervisor LLM step, one subagent LLM step, …) when the
 * provider returns `usage_metadata` on the final `AIMessageChunk`.
 * The deepagents library streams raw `BaseMessageChunk`s through
 * LangGraph's `streamMode: "messages"`, and ChatOpenAI's adapter
 * stamps `usage_metadata` on the very last chunk of each completion.
 *
 * Chunk consumers (the api `chat.controller.ts` deepagent path) use
 * this to dispatch the typed `llm_usage` slice into `agent_events`,
 * which the eval CLI in `apps/eval/` aggregates per agent.
 *
 * `node` is the runner-internal node name (`deepagent_supervisor` or
 * `deepagent_subagent:<name>`) for parity with the legacy graph's
 * per-node `llm_usage` events.
 */
export interface DeepAgentLlmUsageChunk {
  type: "llm-usage";
  /**
   * The runId LangChain stamped on the AIMessageChunk — distinct per
   * LLM call. Used as the snapshot key by the controller's `emit()`
   * dedupe so two consecutive calls never collide.
   */
  runId: string;
  source: "supervisor" | "subagent";
  /** Subagent name when `source === "subagent"`, otherwise undefined. */
  subagentName?: string;
  /** See `DeepAgentToolStartChunk.subagentCallId`. */
  subagentCallId?: string;
  node: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

/** Final wrap-up chunk: emitted exactly once when the stream is done. */
export interface DeepAgentDoneChunk {
  type: "done";
}

/** Emitted when the runner caught an unrecoverable error mid-stream. */
export interface DeepAgentErrorChunk {
  type: "error";
  message: string;
}

export type DeepAgentChunk =
  | DeepAgentTextChunk
  | DeepAgentToolStartChunk
  | DeepAgentToolEndChunk
  | DeepAgentTaskStartChunk
  | DeepAgentTaskEndChunk
  | DeepAgentFilesUpdateChunk
  | DeepAgentLlmUsageChunk
  | DeepAgentDoneChunk
  | DeepAgentErrorChunk;

/* ─── Public options + runner ──────────────────────────────────────── */

export interface DeepAgentRunnerOptions {
  /** API key for the chat model. */
  apiKey: string;
  /**
   * Model identifier passed verbatim to the OpenAI-compatible endpoint
   * at `baseUrl`. Whatever the api's env supplies in
   * `SUPERVISOR_LLM_MODEL` is forwarded as-is — including provider
   * prefixes that are part of the on-the-wire model name (notably
   * `hf:<owner>/<model>` for the Hugging Face router, which 400s on
   * any model name that doesn't start with `hf:`).
   */
  model: string;
  /** Optional OpenAI-compatible base URL (NVIDIA / Groq / Deepseek / etc). */
  baseUrl?: string;
  /** Override the supervisor system prompt. Defaults to a generic stub. */
  systemPrompt?: string;
  /** Optional sampling temperature; defaults to 0.2. */
  temperature?: number;
  /**
   * Postgres connection string for the LangGraph checkpointer. Same
   * Supabase database the rest of the api uses, isolated to a separate
   * schema (`schema` option below) so the v1 deep-agent checkpoint
   * tables don't collide with the legacy v0.x graph's tables in
   * `public`. When omitted, the runner falls back to an in-process
   * `MemorySaver` and logs a warning — runs will not persist across
   * api restarts in that mode.
   */
  dbUrl?: string;
  /**
   * Postgres schema for the deep-agent checkpoint tables. Defaults to
   * `"deep_agent"` so the v1 family's `checkpoints`,
   * `checkpoint_blobs`, `checkpoint_writes`, etc. live alongside but
   * separate from the legacy graph's same-named v0.x tables. Schema
   * is created on first `setup()` if it doesn't exist.
   */
  dbSchema?: string;
  /**
   * Connection config for the MPFE Supabase MCP server. When omitted,
   * the runner soft-fails MCP initialisation and proceeds with no
   * subagents wired to the database — useful for local smoke tests
   * but the supervisor will refuse to build a syllabus in that mode.
   * The api app passes either an HTTP URL (production / Railway) or
   * a stdio spawn config (local dev) — see DeepAgentMcpConfig.
   */
  mcp?: DeepAgentMcpConfig;
  /**
   * Serper.dev API key for the pedagogy_planner subagent's web
   * search. When omitted, the planner runs LLM-only (the prompt is
   * automatically adjusted). The api app passes
   * `cfg.serperApiKey` straight through.
   */
  serperApiKey?: string;
  /**
   * Tavily API key. When set, takes precedence over `serperApiKey`
   * for the pedagogy_planner subagent's web_search tool.
   */
  tavilyApiKey?: string;
}

export interface DeepAgentRunner {
  /**
   * Stream the supervisor's response to a user message under a given
   * thread id. The `threadId` scopes the LangGraph checkpointer so
   * every call with the same id continues that conversation.
   *
   * When `options.resume === true`, the runner re-runs the graph
   * from START with the existing checkpoint state intact —
   * `userMessage` is ignored on the input merge (an empty messages
   * array is passed, which `addMessages` treats as a no-op). Used by
   * the chat controller's retry path so a re-posted human turn
   * doesn't duplicate itself in `state.messages`. Caller is
   * responsible for verifying the checkpoint already has the user
   * message at the tail (e.g. via `getLastHumanText`).
   */
  stream(
    threadId: string,
    userMessage: string,
    options?: { signal?: AbortSignal; resume?: boolean },
  ): AsyncIterable<DeepAgentChunk>;
  /**
   * Return the text content of the last `human` message in the
   * thread's checkpointed state, or `null` when the thread has no
   * checkpoint or its tail isn't a human message. Used by the retry
   * path to confirm the failed run's user turn is actually present in
   * the v1 `deep_agent` schema before promising a resume — the legacy
   * `GraphService.getMessages` can't reach that schema.
   */
  getLastHumanText(threadId: string): Promise<string | null>;
  /**
   * Read the deepagents virtual filesystem snapshot for a thread from
   * the LangGraph checkpointer. Returns `path → content` for every
   * file the supervisor + subagents have written so far. Used by the
   * api's `/state` hydration so the canvas can re-render the file
   * tree on tab reload after the run has finished.
   *
   * Returns an empty object for unknown threads or threads with no
   * file activity.
   */
  getVfsSnapshot(threadId: string): Promise<Record<string, string>>;
  /**
   * Read the full chat-message history for a thread from the v1
   * `deep_agent` schema checkpointer. Returns one entry per
   * BaseMessage in `state.values.messages`, normalised to a plain
   * `{ role, content }` shape so the api layer doesn't have to
   * import `@langchain/core`. The role is the canonical
   * `BaseMessage._getType()` value (`"human" | "ai" | "tool" |
   * "system"`); `content` is collapsed to a single string (text-only
   * blocks joined; tool/AIMessage tool-call payloads are surfaced as
   * the empty string — the api/UI render the chip and canvas rows
   * from the structured streaming wire frames, not from this text).
   *
   * Used by the chat controller's `/state` endpoint to hydrate the
   * deepagent chat history on a cold reload (and to reconcile the
   * live transcript on `onFinish` resync). The legacy
   * `GraphService.getMessages` can't reach the deepagent schema —
   * its compiled-graph map only has the v0.x `syllabus-generator`
   * and `activity-generator-*` graphs, so calling it for a
   * deepagent thread silently falls back to an unrelated checkpoint
   * and returns empty (the bug this method exists to fix).
   *
   * Returns an empty array for unknown threads or threads with no
   * checkpoint.
   */
  getMessages(
    threadId: string,
  ): Promise<Array<{ role: string; content: string }>>;
  /**
   * Walk the deep-agent checkpoint and return one entry per
   * supervisor tool call — i.e. every AIMessage's `tool_calls[]`
   * paired with the matching ToolMessage(s) downstream that close
   * each call.
   *
   * Used by the chat controller's `/state` endpoint to hydrate the
   * inline tool-call cards rendered in the main chat (write_todos,
   * vfs ops, `task` dispatches). On a cold reload the FE has no
   * `live_tool_calls` to draw from — this is what restores the chips
   * to the chat after a page refresh. Without it, only the supervisor
   * text bubbles come back; the tool calls disappear from the
   * transcript.
   *
   * `anchor_msg_index` is the position of the AIMessage that issued
   * the call inside the canonical messages array returned by
   * `getMessages()`; the FE uses it to render each chip directly
   * under that AI bubble (BEENET-style chronology) instead of at
   * the tail.
   *
   * `task` calls keep their full args (`subagent_type`,
   * `description`) so the FE can render the dedicated TaskCard UI.
   *
   * Returns an empty array for unknown threads or threads with no
   * checkpoint.
   */
  getSupervisorToolCalls(
    threadId: string,
  ): Promise<
    Array<{
      id: string;
      name: string;
      args: Record<string, unknown>;
      status: "ok" | "error";
      preview: string | null;
      anchor_msg_index: number | null;
    }>
  >;
  /**
   * Release any resources held by the runner (notably the
   * `PostgresSaver`'s `pg.Pool`). Idempotent — safe to call multiple
   * times. Implementations should swallow shutdown errors so it can
   * be wired into a NestJS `OnModuleDestroy` hook unconditionally.
   */
  close(): Promise<void>;
}

/* ─── Implementation ───────────────────────────────────────────────── */

const DEFAULT_DB_SCHEMA = "deep_agent";

/**
 * MCP tool name → which subagent (or supervisor) gets it.
 *
 * Centralised here so adding a new MCP tool is one entry. Read tools
 * are dual-listed wherever an agent needs to verify or look up
 * existing rows. Write tools are scoped tightly: only the supervisor
 * calls `create_syllabus`; only the writer calls `create_unity` /
 * `create_activity`; only `activity_maker` calls `update_activity_worksheet`.
 *
 * `pedagogy_planner` intentionally has NO database tools — see
 * `prompts/pedagogy-planner.ts` for the rationale (it produces a
 * markdown plan only, the writer persists). `pedagogy_critic` is
 * read-only by design — see `prompts/pedagogy-critic.ts`.
 */
const MCP_TOOL_REGISTRY = {
  supervisor: [
    // Capability A — Build a syllabus
    "create_syllabus",
    "get_syllabus",
    "list_syllabuses",
    "list_unities",
    "list_activities_for_unity",
    "get_activity",
    // Capability B — Make an activity (grounding lookup + verification)
    "list_activities_for_thread",
  ] as const,
  writer: [
    "list_unities",
    "list_activities_for_unity",
    "get_activity",
    "get_syllabus",
    "create_unity",
    "create_activity",
    "find_related_activities",
    "find_related_unities",
  ] as const,
  activity_maker: [
    "get_activity",
    "list_activities_for_thread",
    "list_unities",
    "list_activities_for_unity",
    "get_syllabus",
    "update_activity_worksheet",
  ] as const,
  pedagogy_critic: [
    "get_activity",
    "get_syllabus",
    "list_unities",
    "list_activities_for_unity",
  ] as const,
} as const;

/**
 * Build the LangGraph checkpointer for the deep-agent supervisor.
 *
 * Tries Postgres first when a `dbUrl` is provided so deep-agent threads
 * survive api restarts (Railway redeploys, Fly machine cycles). Falls
 * back to an in-process `MemorySaver` if the DB is unreachable or no
 * `dbUrl` is supplied — same degradation pattern the legacy
 * `GraphService.buildCheckpointer` uses.
 *
 * `PostgresSaver` is created with a custom `schema` (default
 * `"deep_agent"`) so its v1-shaped `checkpoints` / `checkpoint_blobs`
 * / `checkpoint_writes` tables do not collide with the legacy v0.x
 * tables created by `apps/api/src/graph/graph.service.ts` in `public`.
 * `setup()` creates the schema on first call.
 */
async function buildCheckpointer(
  options: DeepAgentRunnerOptions,
): Promise<{ saver: BaseCheckpointSaver; close: () => Promise<void> }> {
  if (!options.dbUrl) {
    console.warn(
      "[deep-agent] No dbUrl supplied; using in-process MemorySaver. " +
        "Threads will not survive api restarts.",
    );
    const saver = new MemorySaver();
    return { saver, close: async () => {} };
  }
  try {
    const schema = options.dbSchema ?? DEFAULT_DB_SCHEMA;
    const saver = PostgresSaver.fromConnString(options.dbUrl, { schema });
    await saver.setup();
    console.log(
      `[deep-agent] PostgresSaver ready (schema="${schema}").`,
    );
    return {
      saver,
      close: async () => {
        try {
          await saver.end?.();
        } catch (err) {
          // Swallow — onModuleDestroy must not throw.
          console.warn(
            `[deep-agent] PostgresSaver.end() failed: ${(err as Error).message}`,
          );
        }
      },
    };
  } catch (err) {
    console.warn(
      `[deep-agent] PostgresSaver unavailable (${(err as Error).message}). ` +
        "Falling back to MemorySaver — threads will not persist.",
    );
    const saver = new MemorySaver();
    return { saver, close: async () => {} };
  }
}

export async function createDeepAgentRunner(
  options: DeepAgentRunnerOptions,
): Promise<DeepAgentRunner> {
  // Pass the env-supplied model id straight through. Earlier versions of
  // this runner stripped a `provider:` prefix to support langchain's
  // `initChatModel("openai:gpt-4o")`-style strings, but `ChatOpenAI`
  // forwards `model` verbatim in the request body — so e.g. an
  // `hf:zai-org/GLM-4.6` env value coming out of `LlmConfigService.rawConfig`
  // must arrive at the Hugging Face router with the `hf:` prefix intact,
  // otherwise the router 400s with `Your model name should start with an
  // hf: prefix`.
  const model = new ChatOpenAI({
    model: options.model,
    apiKey: options.apiKey,
    streaming: true,
    temperature: options.temperature ?? 0.2,
    ...(options.baseUrl
      ? { configuration: { baseURL: options.baseUrl } }
      : {}),
  });

  const { saver: checkpointer, close: closeCheckpointer } =
    await buildCheckpointer(options);

  // Build MCP tools first (one connection, shared across all
  // agents). Soft-fail when MCP isn't configured — boot continues so
  // local smoke tests can run with the supervisor only, but the
  // supervisor's prompt will be told the DB tools are missing and
  // refuse to attempt a syllabus build.
  let supervisorMcpTools: DeepAgentTool[] = [];
  let writerMcpTools: DeepAgentTool[] = [];
  let activityMakerMcpTools: DeepAgentTool[] = [];
  let pedagogyCriticMcpTools: DeepAgentTool[] = [];
  let mcpClose: () => Promise<void> = async () => {};
  if (options.mcp) {
    try {
      const mcp = await buildMcpTools(options.mcp);
      supervisorMcpTools = pickMcpTools(
        mcp.byName,
        MCP_TOOL_REGISTRY.supervisor,
      );
      writerMcpTools = pickMcpTools(mcp.byName, MCP_TOOL_REGISTRY.writer);
      activityMakerMcpTools = pickMcpTools(
        mcp.byName,
        MCP_TOOL_REGISTRY.activity_maker,
      );
      pedagogyCriticMcpTools = pickMcpTools(
        mcp.byName,
        MCP_TOOL_REGISTRY.pedagogy_critic,
      );
      mcpClose = mcp.close;
      console.log(
        `[deep-agent] MCP ready (supervisor=${supervisorMcpTools.length}, ` +
          `writer=${writerMcpTools.length}, ` +
          `activity_maker=${activityMakerMcpTools.length}, ` +
          `pedagogy_critic=${pedagogyCriticMcpTools.length} tools).`,
      );
    } catch (err) {
      console.warn(
        `[deep-agent] MCP unavailable (${(err as Error).message}). ` +
          "Supervisor will refuse syllabus / activity build requests.",
      );
    }
  } else {
    console.warn(
      "[deep-agent] No MCP config supplied; supervisor will refuse " +
        "syllabus build requests.",
    );
  }

  const serperConfig: SerperConfig = {
    apiKey: options.serperApiKey,
    tavilyApiKey: options.tavilyApiKey,
  };
  const searchTools = buildSearchTools(serperConfig);
  const plannerHasSearch = searchTools.length > 0;

  const baseSupervisorPrompt =
    options.systemPrompt ??
    buildSupervisorPrompt({ pedagogyPlannerHasSearch: plannerHasSearch });

  /**
   * Subagent definitions. Each one is a ReAct agent: the system
   * prompt lists the tools available, the model picks them. We do
   * NOT attach extra middleware — the deepagents library injects the
   * standard filesystem (read_file/write_file/edit_file/ls) and
   * write_todos tools into every subagent automatically.
   *
   * Tools below are the *additional* ones we hand each subagent:
   *   - pedagogy_planner: search tools (when configured); no DB.
   *   - writer: MCP read + create tools for unities/activities,
   *     plus find_related_activities for anti-duplication.
   *   - activity_maker: MCP read tools + update_activity_worksheet.
   *   - pedagogy_critic: MCP read tools only (read-only by design).
   *
   * The supervisor is a *generalist conductor* — its prompt teaches
   * it to dispatch one of these specialists based on the user's
   * request. Some chats use only one specialist (e.g. *make me 5
   * MCQs on photosynthesis* → activity_maker only); others compose
   * several (e.g. *build a syllabus and a worksheet for unity 2
   * activity 1* → pedagogy_planner → writer × N → activity_maker).
   */
  const subagents = [
    {
      name: "pedagogy_planner",
      description:
        "Senior curriculum designer. Reads /user_profile.md, " +
        "produces /pedagogy_plan.md (unity-by-unity plan with " +
        "outcomes, activity outlines, Bloom levels, durations). " +
        (plannerHasSearch
          ? "Has web search (Serper) for grounding. "
          : "LLM-only, no web search. ") +
        "Does NOT touch the database.",
      prompt: buildPedagogyPlannerPrompt({ hasSearch: plannerHasSearch }),
      tools: searchTools,
    },
    {
      name: "writer",
      description:
        "Subject-matter writer. Takes one unity spec (copy-pasted " +
        "from /pedagogy_plan.md by the supervisor) plus a syllabus_id " +
        "and writes one unity row + its activity rows (cours body) in " +
        "the database. Calls find_related_activities before each " +
        "create_activity to keep new content non-overlapping with " +
        "existing rows in the same syllabus. Mirrors each activity " +
        "to /activities/<activity_id>.md so the supervisor can verify.",
      prompt: buildWriterPrompt(),
      tools: writerMcpTools,
    },
    {
      name: "activity_maker",
      description:
        "Worksheet designer. Produces one MCQ / short-answer / " +
        "worked-example worksheet per dispatch and attaches it to an " +
        "existing activity row via update_activity_worksheet. Two " +
        "flavours decided by the supervisor: activity-grounded " +
        "(fetches the cours body via get_activity before drafting " +
        "questions) or standalone (no syllabus binding, generates " +
        "from topic + audience). Mirrors output to " +
        "/activities/<activity_id>.worksheet.json.",
      prompt: buildActivityMakerPrompt(),
      tools: activityMakerMcpTools,
    },
    {
      name: "pedagogy_critic",
      description:
        "Read-only senior reviewer. Critiques a pedagogy plan, " +
        "activity body, unity, or worksheet against the audience " +
        "profile and Bloom progression. Writes severity-tagged " +
        "findings to /critiques/<target>.md (block / revise / " +
        "polish) and returns a one-paragraph summary so the " +
        "supervisor can decide whether to re-task the writer / " +
        "activity_maker. Never touches the database.",
      prompt: buildPedagogyCriticPrompt(),
      tools: pedagogyCriticMcpTools,
    },
  ];

  /**
   * Build a deepagents agent for a specific thread. The system
   * prompt has the thread_id baked in (via `supervisorThreadContext`)
   * so the supervisor knows the exact value to pass to
   * `create_syllabus(thread_id=...)` without having to read it from
   * a tool config. `createDeepAgent` is cheap (no I/O), so building
   * a fresh graph per stream call is fine; the checkpointer + MCP
   * tool closures are reused so persistence and the MCP child
   * process are NOT recreated.
   *
   * Pass `null` for state-read paths (`getLastHumanText`) — they
   * don't need the per-thread prompt, only the graph + checkpointer.
   */
  function buildAgent(threadId: string | null) {
    const systemPrompt =
      threadId === null
        ? baseSupervisorPrompt
        : baseSupervisorPrompt + supervisorThreadContext(threadId);
    return createDeepAgent({
      model,
      // Supervisor tools = MCP database tools only. The deepagents
      // library auto-injects filesystem (read/write/edit/ls), todo,
      // and the `task` tool for subagent dispatch on top of these.
      tools: supervisorMcpTools as never[],
      systemPrompt,
      // NOTE on the catch-all `general-purpose` subagent: deepagents
      // 1.9 unconditionally prepends `GENERAL_PURPOSE_SUBAGENT` to the
      // `subagents` array if no entry with that name is present
      // (`dist/index.js:6498`). The `generalPurposeAgent: false`
      // option only exists on `createSubAgentMiddleware`, not on
      // `createDeepAgent` itself, so we cannot disable the catch-all
      // through the public API in v1.9 without manually composing
      // middleware. This is a deliberate non-issue: the supervisor
      // prompt enumerates `pedagogy_planner` and `writer` explicitly
      // and the model has not been observed to route to
      // `general-purpose` in our prompt structure. If it ever does,
      // we'll override by including a stubbed `name: "general-purpose"`
      // entry of our own (which the library treats as displacing the
      // default — see the `inlineSubagents.some(...)` guard).
      subagents: subagents as never,
      // Pass an actual checkpointer instance. `true` is a sub-graph
      // idiom in v1 LangGraph ("inherit from parent"); the root pregel
      // explicitly rejects it with `Error: "checkpointer: true cannot
      // be used for root graphs."` (langgraph/dist/pregel/index.cjs).
      //
      // `as never` cast: `deepagents@1.9` does not declare
      // `@langchain/langgraph-checkpoint` in its own `dependencies` /
      // `peerDependencies`, so its `.d.ts` `import {BaseCheckpointSaver}
      // from "@langchain/langgraph-checkpoint"` resolves at typecheck
      // time to whichever copy TypeScript hoists first. With the v0.x
      // checkpoint also installed for the legacy graph (apps/api pins
      // it for `langgraph-checkpoint-postgres@0.0.3`'s peer), TS picks
      // v0.x and complains the v1 `BaseCheckpointSaver<number>` we
      // pass here isn't assignable to v0's same-named type. Runtime is
      // unaffected — pnpm's symlinks correctly route every v1 caller
      // to v1.0.1 (verified via `require.resolve` traversal). Mirrors
      // the same v0/v1 cast pattern at `graph.service.ts:156`.
      checkpointer: checkpointer as never,
    });
  }

  async function* stream(
    threadId: string,
    userMessage: string,
    streamOpts?: { signal?: AbortSignal; resume?: boolean },
  ): AsyncIterable<DeepAgentChunk> {
    /**
     * `agent.stream({streamMode:["messages","updates"], subgraphs:true})`
     * yields tuples `[namespace, mode, data]` per the deepagents
     * streaming examples. We split on `mode`:
     *
     *   - "messages" → token deltas (LLM output) + tool messages
     *   - "updates" → per-node state diffs (we use this to detect
     *                 task tool starts / ends — a no-op for the
     *                 supervisor-only build, wired now so it works
     *                 unchanged when subagents are added.)
     *
     * `subgraphs:true` is what makes the namespace include
     * `tools:<uuid>` segments for any nested subagent run, which is
     * how we'll route subagent tokens to a separate UI lane in the
     * future.
     */
    const config = {
      configurable: { thread_id: threadId },
      signal: streamOpts?.signal,
      recursionLimit: 50,
    };

    const seenToolCalls = new Set<string>();
    const finishedToolCalls = new Set<string>();

    // Stack of in-flight `task` tool calls — pushed when the
    // supervisor emits a tool-start with name === "task" and popped
    // when the matching tool-end fires. While the stack is non-empty
    // we know every incoming subagent-namespaced chunk belongs to
    // the most-recent active task call (sequential delegation is the
    // dominant pattern; correct support for parallel `task` calls in
    // a single AIMessage will require namespace-based correlation
    // and is deferred to a follow-up PR).
    //
    // We only treat a tool call as a "task" delegation when the LLM
    // has filled in a `subagent_type`. Mid-stream tool_call_chunks
    // can briefly expose a `task` call with empty args; we emit
    // task-start once the args are populated, otherwise we'd lose
    // the subagent name and description.
    const taskCallStack: Array<{
      callId: string;
      subagentName: string;
      startedAt: number;
    }> = [];
    const seenTaskStart = new Set<string>();

    try {
      // Retry: pass an empty messages array so `addMessages` treats it
      // as a no-op append (state.messages stays as-is, with the user
      // turn at the tail from the failed run's input checkpoint). The
      // graph still re-runs from START because Pregel sees one
      // channel write and triggers normally — but the supervisor
      // doesn't see a duplicated `[…, human, human]` history. We
      // deliberately don't pass `null` (the v1 canonical "resume
      // interrupted run" idiom) because that requires
      // `CONFIG_KEY_RESUMING` in `configurable`, which has wider
      // semantics than we want here (it's meant for resuming after a
      // human-in-the-loop interrupt, not for retrying a failed turn).
      const input =
        streamOpts?.resume === true
          ? { messages: [] }
          : { messages: [{ role: "user", content: userMessage }] };
      // Build a fresh agent for this thread so the supervisor's
      // system prompt has the correct thread_id baked in. This is
      // cheap (no I/O — just object construction); the checkpointer
      // and MCP tool closures are reused so persistence and the MCP
      // child process are NOT recreated.
      const agent = buildAgent(threadId);
      // `as unknown as` cast: deepagents@1.9 narrows the agent's
      // `.stream()` second-arg type to `undefined` when subagents are
      // declared (a TS inference quirk in the library's generic
      // chain). Runtime accepts the full `RunnableConfig` shape — we
      // pass streamMode + subgraphs + configurable + signal exactly
      // as the library's own examples do.
      const streamFn = (
        agent as unknown as {
          stream: (
            input: unknown,
            options: Record<string, unknown>,
          ) => Promise<AsyncIterable<unknown>>;
        }
      ).stream;
      const stream = await streamFn.call(agent, input, {
        streamMode: ["messages", "updates"] as const,
        subgraphs: true,
        ...config,
      });

      for await (const item of stream as AsyncIterable<
        [string[], "messages" | "updates", unknown]
      > ) {
        const [namespace, mode, data] = item;
        const isSubagent = namespace.some((s: string) =>
          s.startsWith("tools:"),
        );

        // The most-recent active task call, if any. Subagent chunks
        // are tagged with this callId so consumers can route them to
        // the right TaskCard / subagent panel. Recomputed every
        // iteration since the stack mutates on task-start / task-end.
        const activeTask = taskCallStack[taskCallStack.length - 1];

        if (mode === "messages") {
          // `data` is `[BaseMessageChunk, RunnableMetadata]`.
          const tuple = data as [
            {
              id?: string;
              content?: unknown;
              tool_calls?: Array<{
                id?: string;
                name?: string;
                args?: unknown;
              }>;
              usage_metadata?: {
                input_tokens?: number;
                output_tokens?: number;
                total_tokens?: number;
              };
            },
            { langgraph_node?: string } | undefined,
          ];
          const message = tuple[0];
          const metadata = tuple[1];

          // Per-LLM-call token usage. ChatOpenAI stamps
          // `usage_metadata` on the FINAL `AIMessageChunk` of each
          // completion (langchain-openai sets `stream_options:
          // include_usage` by default). One LLM call → one chunk
          // here → exactly one llm-usage emission. We use the chunk's
          // own `id` as the runId so the controller's snapshot
          // dedupe by `LlmUsage.run_id` works trivially across
          // multiple consecutive completions in one supervisor turn.
          if (message?.usage_metadata) {
            const u = message.usage_metadata;
            const runId =
              typeof message.id === "string" && message.id.length > 0
                ? message.id
                : `${threadId}-${Date.now()}-${Math.random()
                    .toString(36)
                    .slice(2, 8)}`;
            const langgraphNode = metadata?.langgraph_node;
            const node = isSubagent
              ? `deepagent_subagent:${activeTask?.subagentName ?? langgraphNode ?? "unknown"}`
              : `deepagent_${langgraphNode ?? "supervisor"}`;
            yield {
              type: "llm-usage",
              runId,
              source: isSubagent ? "subagent" : "supervisor",
              ...(isSubagent && activeTask
                ? {
                    subagentName: activeTask.subagentName,
                    subagentCallId: activeTask.callId,
                  }
                : {}),
              node,
              inputTokens:
                typeof u.input_tokens === "number" ? u.input_tokens : null,
              outputTokens:
                typeof u.output_tokens === "number" ? u.output_tokens : null,
              totalTokens:
                typeof u.total_tokens === "number" ? u.total_tokens : null,
            };
          }

          // Token text. BaseMessageChunk.content can be string OR
          // array-of-content-blocks; normalize to string.
          const text = extractText(message?.content);
          if (text) {
            if (isSubagent) {
              yield {
                type: "text-delta",
                delta: text,
                source: "subagent",
                ...(activeTask
                  ? {
                      subagentName: activeTask.subagentName,
                      subagentCallId: activeTask.callId,
                    }
                  : {}),
              };
            } else {
              yield {
                type: "text-delta",
                delta: text,
                source: "supervisor",
              };
            }
          }

          // Surface tool_calls that show up on the AI message stream
          // (these are emitted progressively by ChatOpenAI when the
          // model decides to invoke a tool). The supervisor's `task`
          // tool calls are intercepted here and re-emitted as the
          // richer `task-start` chunk; everything else passes through
          // as a regular `tool-start`, optionally tagged with the
          // surrounding subagent call id.
          for (const tc of message?.tool_calls ?? []) {
            const callId = tc.id;
            if (!callId) continue;
            const toolName = tc.name ?? "unknown";
            const args =
              tc.args && typeof tc.args === "object"
                ? (tc.args as Record<string, unknown>)
                : {};

            // Supervisor's `task` tool call → emit task-start.
            // Skip subagent traffic — a subagent invoking `task`
            // inside its own body is a recursive subagent spawn we
            // don't yet model in the FE; for now treat it like a
            // regular tool call so it's at least visible.
            if (!isSubagent && toolName === "task") {
              if (seenTaskStart.has(callId)) continue;
              const subagentName =
                typeof args.subagent_type === "string"
                  ? args.subagent_type
                  : "";
              const description =
                typeof args.description === "string"
                  ? args.description
                  : "";
              // The LLM may emit a partial tool_call_chunk with the
              // id but empty args first; wait until at least the
              // subagent_type is populated so the TaskCard always
              // has a name to render.
              if (!subagentName) continue;
              seenTaskStart.add(callId);
              taskCallStack.push({
                callId,
                subagentName,
                startedAt: Date.now(),
              });
              yield {
                type: "task-start",
                callId,
                subagentName,
                description,
              };
              continue;
            }

            if (seenToolCalls.has(callId)) continue;
            seenToolCalls.add(callId);
            yield {
              type: "tool-start",
              callId,
              name: toolName,
              args: tc.args ?? {},
              ...(isSubagent && activeTask
                ? { subagentCallId: activeTask.callId }
                : {}),
            };
          }
        }

        if (mode === "updates") {
          // `data` is `Record<nodeName, partialState>`. The
          // tools-node update carries the ToolMessage(s) returned by
          // any executed tool — we fish the output string out of it
          // so the FE can render the tool result chip.
          //
          // The same partial may also carry a `files` channel diff
          // (when a FS tool returns `Command({update:{files:...}})`).
          // We emit a `files-update` chunk in that case so the canvas
          // can render the new VFS contents live.
          const updates = data as Record<
            string,
            {
              messages?: Array<{
                type?: string;
                tool_call_id?: string;
                name?: string;
                content?: unknown;
              }>;
              files?: Record<string, unknown>;
            }
          >;
          for (const [nodeName, partial] of Object.entries(updates ?? {})) {
            // Filter to the standard ReAct-style tools node; some
            // middleware nodes also surface messages (e.g.
            // `summarization`) that we don't want to forward as
            // tool-end events.
            if (nodeName !== "tools") continue;
            // VFS delta first so the FE has the file contents in hand
            // by the time the matching tool-end chip flips to "ok".
            if (partial?.files && typeof partial.files === "object") {
              const normalised = normaliseFilesUpdate(partial.files);
              if (Object.keys(normalised).length > 0) {
                yield {
                  type: "files-update",
                  files: normalised,
                  ...(isSubagent && activeTask
                    ? { subagentCallId: activeTask.callId }
                    : {}),
                };
              }
            }
            for (const m of partial?.messages ?? []) {
              if (m?.type !== "tool" || !m.tool_call_id) continue;
              if (finishedToolCalls.has(m.tool_call_id)) continue;
              finishedToolCalls.add(m.tool_call_id);
              const toolName = m.name ?? "unknown";
              const output = stringifyToolOutput(m.content);

              // Supervisor's `task` tool finished → emit task-end and
              // pop the stack. The output IS the subagent's final
              // answer (deepagents joins the last AIMessage's
              // content blocks into a single string before returning
              // from the task tool body — see deepagents/dist/index.js
              // around `createTaskTool`).
              const taskIdx = !isSubagent
                ? taskCallStack.findIndex(
                    (t) => t.callId === m.tool_call_id,
                  )
                : -1;
              if (taskIdx !== -1) {
                const popped = taskCallStack.splice(taskIdx, 1)[0];
                yield {
                  type: "task-end",
                  callId: popped.callId,
                  subagentName: popped.subagentName,
                  output,
                  durationMs: Date.now() - popped.startedAt,
                };
                continue;
              }

              yield {
                type: "tool-end",
                callId: m.tool_call_id,
                name: toolName,
                output,
                ...(isSubagent && activeTask
                  ? { subagentCallId: activeTask.callId }
                  : {}),
              };
            }
          }
        }
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Deep agent stream failed";
      yield { type: "error", message };
    }

    yield { type: "done" };
  }

  async function getLastHumanText(threadId: string): Promise<string | null> {
    try {
      // State reads don't depend on the system prompt — any agent
      // instance pointing at the shared checkpointer can read this
      // thread's checkpoint. Pass `null` to skip the threadId-in-
      // prompt injection (which would just be wasted work here).
      const stateAgent = buildAgent(null);
      const snap = await (
        stateAgent as unknown as {
          getState: (cfg: {
            configurable: { thread_id: string };
          }) => Promise<{ values?: { messages?: unknown[] } } | undefined>;
        }
      ).getState({ configurable: { thread_id: threadId } });
      const msgs = (snap?.values?.messages ?? []) as Array<{
        _getType?: () => string;
        type?: string;
        content?: unknown;
      }>;
      const tail = msgs.at(-1);
      if (!tail) return null;
      const kind =
        typeof tail._getType === "function" ? tail._getType() : tail.type;
      if (kind !== "human") return null;
      return extractText(tail.content);
    } catch {
      // Missing checkpoint / unreachable saver — caller falls back to
      // the legacy append path.
      return null;
    }
  }

  async function getVfsSnapshot(
    threadId: string,
  ): Promise<Record<string, string>> {
    try {
      const stateAgent = buildAgent(null);
      const snap = await (
        stateAgent as unknown as {
          getState: (cfg: {
            configurable: { thread_id: string };
          }) => Promise<{ values?: { files?: unknown } } | undefined>;
        }
      ).getState({ configurable: { thread_id: threadId } });
      const raw = snap?.values?.files;
      if (!raw || typeof raw !== "object") return {};
      const out: Record<string, string> = {};
      for (const [path, value] of Object.entries(
        raw as Record<string, unknown>,
      )) {
        if (value === null || value === undefined) continue;
        out[path] = extractFileContent(value);
      }
      return out;
    } catch {
      // Missing checkpoint / unreachable saver — caller treats as
      // empty VFS (matches the `getLastHumanText` swallow pattern).
      return {};
    }
  }

  async function getMessages(
    threadId: string,
  ): Promise<Array<{ role: string; content: string }>> {
    try {
      const stateAgent = buildAgent(null);
      const snap = await (
        stateAgent as unknown as {
          getState: (cfg: {
            configurable: { thread_id: string };
          }) => Promise<{ values?: { messages?: unknown[] } } | undefined>;
        }
      ).getState({ configurable: { thread_id: threadId } });
      const msgs = (snap?.values?.messages ?? []) as Array<{
        _getType?: () => string;
        type?: string;
        content?: unknown;
      }>;
      const out: Array<{ role: string; content: string }> = [];
      for (const m of msgs) {
        if (m == null || typeof m !== "object") continue;
        const role =
          typeof m._getType === "function"
            ? m._getType()
            : typeof m.type === "string"
              ? m.type
              : "ai";
        // System messages are an internal-only construct — never
        // surfaced in the chat UI. Drop them so the api doesn't have
        // to special-case them downstream.
        if (role === "system") continue;
        out.push({ role, content: extractText(m.content) });
      }
      return out;
    } catch {
      // Missing checkpoint / unreachable saver — caller treats as
      // empty history (matches the `getLastHumanText` /
      // `getVfsSnapshot` swallow pattern).
      return [];
    }
  }

  async function getSupervisorToolCalls(
    threadId: string,
  ): Promise<
    Array<{
      id: string;
      name: string;
      args: Record<string, unknown>;
      status: "ok" | "error";
      preview: string | null;
      anchor_msg_index: number | null;
    }>
  > {
    try {
      const stateAgent = buildAgent(null);
      const snap = await (
        stateAgent as unknown as {
          getState: (cfg: {
            configurable: { thread_id: string };
          }) => Promise<{ values?: { messages?: unknown[] } } | undefined>;
        }
      ).getState({ configurable: { thread_id: threadId } });
      const msgs = (snap?.values?.messages ?? []) as Array<{
        _getType?: () => string;
        type?: string;
        content?: unknown;
        tool_calls?: Array<{
          id?: string;
          name?: string;
          args?: unknown;
        }>;
        tool_call_id?: string;
      }>;
      // Build the same canonical role list `getMessages()` exposes so
      // anchor_msg_index points at the right offset on the FE side
      // (we filter system messages there too).
      const canonicalIndex = new Map<number, number>();
      let canonicalI = 0;
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (m == null || typeof m !== "object") continue;
        const role =
          typeof m._getType === "function"
            ? m._getType()
            : typeof m.type === "string"
              ? m.type
              : "ai";
        if (role === "system") continue;
        canonicalIndex.set(i, canonicalI);
        canonicalI += 1;
      }

      // Pass 1: collect every AIMessage's tool_calls keyed by id, with
      // the canonical anchor index of the issuing AI bubble.
      const calls = new Map<
        string,
        {
          id: string;
          name: string;
          args: Record<string, unknown>;
          anchor_msg_index: number | null;
        }
      >();
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (m == null || typeof m !== "object") continue;
        const role =
          typeof m._getType === "function"
            ? m._getType()
            : typeof m.type === "string"
              ? m.type
              : "";
        if (role !== "ai") continue;
        for (const tc of m.tool_calls ?? []) {
          if (!tc?.id || !tc.name) continue;
          calls.set(tc.id, {
            id: tc.id,
            name: tc.name,
            args:
              tc.args && typeof tc.args === "object"
                ? (tc.args as Record<string, unknown>)
                : {},
            anchor_msg_index: canonicalIndex.get(i) ?? null,
          });
        }
      }

      // Pass 2: walk ToolMessages and close each call with its
      // string preview (truncated to ~80 chars to match the live wire
      // chip preview convention).
      const results = new Map<string, { preview: string }>();
      for (const m of msgs) {
        if (m == null || typeof m !== "object") continue;
        const role =
          typeof m._getType === "function"
            ? m._getType()
            : typeof m.type === "string"
              ? m.type
              : "";
        if (role !== "tool") continue;
        const id = typeof m.tool_call_id === "string" ? m.tool_call_id : null;
        if (!id) continue;
        const text = extractText(m.content);
        const preview = text.length > 80 ? `${text.slice(0, 77)}…` : text;
        results.set(id, { preview });
      }

      const out: Array<{
        id: string;
        name: string;
        args: Record<string, unknown>;
        status: "ok" | "error";
        preview: string | null;
        anchor_msg_index: number | null;
      }> = [];
      for (const c of calls.values()) {
        const r = results.get(c.id);
        out.push({
          id: c.id,
          name: c.name,
          args: c.args,
          // The checkpoint doesn't distinguish ok vs error directly
          // — error tool messages still land as ToolMessage rows, but
          // they typically include `"error"` in the payload. Treat
          // every closed tool call as `ok` for the FE chip; the
          // canvas SubagentRunRow already surfaces the per-task
          // error status via the durable `subagent_runs` event-log
          // snapshot. Calls without a matching ToolMessage are
          // mid-flight from a previous run that crashed before
          // closing — surface as `error` so the chip doesn't render
          // as a forever-spinning "running" entry on reload.
          status: r ? "ok" : "error",
          preview: r?.preview ?? null,
          anchor_msg_index: c.anchor_msg_index,
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  // Composite shutdown: close the MCP transport AND the postgres
  // checkpointer pool. Idempotent — both close fns swallow their
  // own errors so onModuleDestroy never throws.
  async function close(): Promise<void> {
    await mcpClose();
    await closeCheckpointer();
  }

  return {
    stream,
    getLastHumanText,
    getVfsSnapshot,
    getMessages,
    getSupervisorToolCalls,
    close,
  };
}

/* ─── Helpers ─────────────────────────────────────────────────────── */

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (typeof block === "string") {
      out += block;
      continue;
    }
    if (
      block != null &&
      typeof block === "object" &&
      "type" in block &&
      (block as { type: unknown }).type === "text" &&
      "text" in block
    ) {
      const t = (block as { text: unknown }).text;
      if (typeof t === "string") out += t;
    }
  }
  return out;
}

/**
 * Convert a deepagents `Record<path, FileData | null>` partial state
 * update into the wire shape consumers want (`Record<path, string |
 * null>`). FileDataV1 stores content as `string[]` (one entry per
 * line); FileDataV2 stores it as `string | Uint8Array`. We collapse
 * both to a single string. Binary files (V2 with Uint8Array content)
 * are surfaced with a placeholder — the canvas isn't a binary viewer.
 */
function normaliseFilesUpdate(
  raw: Record<string, unknown>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [path, value] of Object.entries(raw)) {
    if (value === null) {
      out[path] = null;
      continue;
    }
    out[path] = extractFileContent(value);
  }
  return out;
}

function extractFileContent(file: unknown): string {
  if (file == null || typeof file !== "object") return "";
  const c = (file as { content?: unknown }).content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    // FileDataV1 — array of lines. Per the deepagents schema each
    // entry is a single line (no trailing newline), so re-join with
    // "\n".
    return c.filter((s) => typeof s === "string").join("\n");
  }
  // V2 with Uint8Array content (binary file).
  if (c && typeof c === "object" && "byteLength" in c) {
    const len = (c as { byteLength: number }).byteLength;
    return `(binary file — ${len} bytes)`;
  }
  return "";
}

function stringifyToolOutput(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (
          block != null &&
          typeof block === "object" &&
          "text" in block &&
          typeof (block as { text: unknown }).text === "string"
        ) {
          return (block as { text: string }).text;
        }
        return JSON.stringify(block);
      })
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}



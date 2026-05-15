import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import * as path from "node:path";
import {
  createDeepAgentRunner,
  type DeepAgentChunk,
  type DeepAgentMcpConfig,
  type DeepAgentRunner,
} from "@mpfe/deep-agent";
import { LlmConfigService } from "../config/llm-config.service";
import { AppConfigService } from "../config/app-config.service";

/**
 * Nest wrapper around `@mpfe/deep-agent`.
 *
 * The runner is built once on module init and reused for every thread;
 * LangGraph's per-thread checkpointer keeps each conversation's state
 * isolated by the `thread_id` we pass in the runtime config.
 *
 * The deep-agent persists checkpoints to the same Supabase Postgres
 * the legacy `GraphService` uses (`SUPABASE_DB_URL`), but isolated to
 * the `deep_agent` schema so its v1-shaped LangGraph tables don't
 * collide with the legacy v0.x tables in `public`. If the DB is
 * unreachable the runner falls back to an in-process `MemorySaver`
 * and logs — same degradation pattern as `GraphService`.
 *
 * The supervisor uses the same `supervisor` LLM tier as the existing
 * graph supervisor so credentials/limits are shared with the rest of
 * the app. We pass the raw `{apiKey, baseUrl, model}` triple from
 * `LlmConfigService.rawConfig` rather than a `ChatOpenAI` instance —
 * see `rawConfig`'s docstring for why crossing the v0.3/v1.x
 * `@langchain/core` boundary with an object is unsafe.
 */
@Injectable()
export class DeepAgentService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeepAgentService.name);
  private runner!: DeepAgentRunner;

  constructor(
    private readonly llm: LlmConfigService,
    private readonly cfg: AppConfigService,
  ) {}

  /**
   * Wire model id the runner was constructed with. Cached at module
   * init so the chat controller's per-LLM-call `llm_usage` events
   * can stamp the model alongside token counts without having to
   * re-resolve through `LlmConfigService`. Read-only.
   */
  private supervisorModel = "";

  async onModuleInit() {
    const llm = this.llm.rawConfig("supervisor");
    this.supervisorModel = llm.model;
    this.runner = await createDeepAgentRunner({
      apiKey: llm.apiKey,
      baseUrl: llm.baseUrl,
      model: llm.model,
      temperature: 0.3,
      dbUrl: this.cfg.supabaseDbUrl,
      mcp: this.buildMcpConfig(),
      serperApiKey: this.cfg.serperApiKey,
      tavilyApiKey: this.cfg.tavilyApiKey,
    });
    this.logger.log(
      `Deep agent runner initialised (model=${llm.model} @ ${llm.baseUrl}).`,
    );
  }

  /**
   * Wire model id the runner is currently using. Stamped on per-LLM
   * `llm_usage` events so the eval CLI can cross-check against
   * provider invoices.
   */
  getSupervisorModel(): string {
    return this.supervisorModel;
  }

  /**
   * Build the MCP connection config for the deep-agent runner.
   *
   * Mirrors the pattern in `apps/api/src/graph/activity/mcp-client.service.ts`:
   *   - When `MCP_SUPABASE_URL` is set (production / Railway), connect
   *     over streamable-http to the private domain.
   *   - Otherwise, spawn the MCP Python server as a stdio child
   *     process via `uv run --directory apps/mcp-supabase mpfe-mcp-supabase`.
   *     Inherits SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for the
   *     server to use, plus PATH so `uv` resolves.
   */
  private buildMcpConfig(): DeepAgentMcpConfig {
    const url = this.cfg.mcpSupabaseUrl;
    if (url) {
      return { url };
    }
    return {
      stdio: {
        command: "uv",
        args: [
          "run",
          "--directory",
          this.mcpServerDir(),
          "mpfe-mcp-supabase",
        ],
        env: {
          SUPABASE_URL: this.cfg.supabaseUrl,
          SUPABASE_SERVICE_ROLE_KEY: this.cfg.supabaseServiceRoleKey,
          PATH: process.env.PATH ?? "",
        },
      },
    };
  }

  /** Absolute path to apps/mcp-supabase. Resolved relative to this
   * file to survive a `pnpm start` from any cwd. */
  private mcpServerDir(): string {
    // __dirname at runtime is dist/agents-v2 (compiled) or
    // src/agents-v2 (tsx). Both are 3 levels deep relative to the
    // repo root — apps/api/(dist|src)/agents-v2.
    return path.resolve(__dirname, "..", "..", "..", "mcp-supabase");
  }

  async onModuleDestroy() {
    await this.runner?.close();
  }

  /**
   * Stream the supervisor's response to a user message under a given
   * `threadId`. Returns the runner's plain async iterator of typed
   * chunks; the chat controller is responsible for translating each
   * chunk into v5 UI Message Stream wire frames + Redis mirrors for
   * resumability.
   *
   * `options.resume` is forwarded to the runner so the chat controller
   * can skip the human-message merge on retries (the existing
   * checkpoint already carries the user's turn at the tail of
   * `state.messages` for a freshly-failed run).
   */
  stream(
    threadId: string,
    userMessage: string,
    options: { signal?: AbortSignal; resume?: boolean } = {},
  ): AsyncIterable<DeepAgentChunk> {
    return this.runner.stream(threadId, userMessage, options);
  }

  /**
   * Text content of the last `human` message in the deep-agent thread's
   * checkpointed state, or `null` when the thread has no checkpoint or
   * its tail isn't a human message. Routed through the runner because
   * deep-agent threads live in the `deep_agent` schema, which the
   * legacy `GraphService.getMessages` cannot reach.
   */
  getLastHumanText(threadId: string): Promise<string | null> {
    return this.runner.getLastHumanText(threadId);
  }

  /**
   * Read the deepagents virtual filesystem snapshot for a thread —
   * `path → content` for every file the supervisor and subagents have
   * written so far. Used by the canvas's `/state` hydration on cold
   * reload (live updates come through the `vfs_update` data part).
   * Returns an empty object for threads with no file activity.
   */
  getVfsSnapshot(threadId: string): Promise<Record<string, string>> {
    return this.runner.getVfsSnapshot(threadId);
  }

  /**
   * Read the chat-message history for a deep-agent thread directly
   * from the v1 `deep_agent` schema checkpointer. Returns one
   * `{ role, content }` entry per BaseMessage in
   * `state.values.messages`.
   *
   * Why a dedicated path instead of `GraphService.getMessages`: the
   * legacy graph service routes through `compiledByAgent` which only
   * has the v0.x graphs (`syllabus-generator`, `activity-generator-*`).
   * Calling it for `agent === "deepagent"` silently falls back to the
   * `syllabus-generator` graph in the `public` schema, which has no
   * record of the thread — returning `[]` and causing the chat
   * controller's `/state` endpoint to fall back to
   * `reconstructMessagesFromEvents`. That fallback only carries
   * `agent_runs.user_message` + `agent_events("assistant_text")`,
   * but the deep-agent stream path deliberately does NOT persist
   * `assistant_text` events (it relies on the LangGraph checkpoint
   * for messages — see `DURABLE_EVENT_KINDS`). Net effect: the AI's
   * full response disappears from `/state` after the stream
   * finishes, and the FE's `onFinish` resync wipes the live chat.
   */
  getMessages(
    threadId: string,
  ): Promise<Array<{ role: string; content: string }>> {
    return this.runner.getMessages(threadId);
  }

  /**
   * Read the supervisor's tool-call history for a deep-agent thread —
   * one entry per AIMessage tool_call paired with its closing
   * ToolMessage in the checkpoint. Returns the canonical
   * `anchor_msg_index` so the FE can render each chip directly under
   * the AI bubble that issued it.
   *
   * Used by `/state` hydration on cold reload to restore the inline
   * supervisor tool cards (write_todos, vfs ops, `task` dispatches)
   * to the chat after a page refresh. Without this, the live
   * `live_tool_calls` store loses every chip on reload because we
   * deliberately don't persist live wire frames to a snapshot slice
   * (the LangGraph checkpoint is already the source of truth — this
   * just walks it).
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
  > {
    return this.runner.getSupervisorToolCalls(threadId);
  }
}

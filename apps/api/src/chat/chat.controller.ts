import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { GraphService } from "../graph/graph.service";
import {
  initStreamingResponse,
  startKeepalive,
  DataStreamWriter,
} from "./data-stream";
import { TokenPacer, pacerIntervalFromEnv } from "./token-pacer";
import { RunRecorder } from "../runs/run-recorder.service";
import { EventLog } from "../runs/event-log.service";
import { RunStream } from "../runs/run-stream.service";
import { RunRegistry } from "../runs/run-registry.service";
import { ThreadsService } from "../threads/threads.service";
import { DeepAgentService } from "../agents-v2/deepagent.service";
import type {
  ActivityGenerationProgress,
  ActivityManifestItem,
  ActivityToolCall,
  AgentInterrupt,
  AgentKind,
  AgentPhase,
  AssistantTextDelta,
  DataPart,
  DataPartKind,
  LlmUsage,
  ManifestItem,
  ResearchPlan,
  ResearchStep,
  RunSnapshot,
  SubagentRun,
  SubagentTextDelta,
  SubagentToolCall,
  TodoPlan,
  ToolCallArgDelta,
  ToolCallEnd,
  ToolCallStart,
  ToolResult,
  VfsUpdate,
} from "@mpfe/shared";
import { mergeResearchPlan, patchResearchStep } from "../graph/state";
import { randomUUID } from "node:crypto";
// IntakeFormAnswer / ActivityIntakeFormAnswer are exported as BOTH Zod
// schemas (runtime values) and type aliases (z.infer of the same name).
// Importing without `type` gives us both runtime parse + TS type via
// declaration merging.
import { ActivityIntakeFormAnswer, IntakeFormAnswer } from "@mpfe/shared";

interface ChatBody {
  // The Vercel AI SDK v5 `useChat` hook posts messages in UIMessage
  // shape (`role` + `parts: UIMessagePart[]`), with no `content` field.
  // The legacy `{ role, content }` shape is still accepted on the
  // `extractLatestUserMessage` path so non-React clients (curl, tests,
  // future server-side callers) don't have to adopt the parts shape.
  messages?: Array<
    | { role: string; content: string }
    | {
        role: string;
        parts?: Array<{ type: string; text?: string } & Record<string, unknown>>;
      }
  >;
  message?: string;
  // Structured payload from IntakeCard (kind="intake_form" interrupts).
  // When present, the controller validates it via Zod, hands it to
  // GraphService.streamTurn as `intakeAnswer`, and uses a synthesized
  // human-readable string as the userMessage for the chat history /
  // run row. Mutually independent from `message`/`messages` — if the
  // body has both, intake wins because that's the resume path that's
  // currently pending in graph state.
  intake?: unknown;
  // Structured payload from ActivityIntakeCard (kind="activity_intake"
  // interrupts on activity-generator threads). Same lifecycle as
  // `intake` but routes through the activity-side resolver.
  activity_intake?: unknown;
  // Retry-of-a-failed-run flag. When the FE's FailedRunCard fires its
  // Retry button it re-posts the same `message` text but sets this
  // flag. The controller then verifies that (a) the latest run for the
  // thread is `failed`, (b) its `user_message` matches what was just
  // posted, and (c) the LangGraph checkpoint's last message is that
  // same human turn — when all three hold, the new run resumes the
  // graph from the existing checkpoint (`streamEvents(null, …)` /
  // `agent.stream(null, …)`) instead of appending another HumanMessage
  // to state.messages and creating a `[…, human, human]` history that
  // the supervisor would react to as two separate user turns.
  // Otherwise the flag is ignored (best-effort: the retry still does
  // *something* useful — a fresh turn — even if the checkpoint state
  // doesn't match the retry-resume preconditions).
  retry?: boolean;
}

/**
 * Vercel AI SDK v5 UI Message Stream wire format.
 *
 * Header: `x-vercel-ai-ui-message-stream: v1` + `Content-Type: text/event-stream`.
 *
 * Frames are SSE-prefixed JSON chunks (`data: {…}\n\n`):
 *  - `{ type: "start", messageId }`             once per turn
 *  - `{ type: "text-start", id }`               opens a text block
 *  - `{ type: "text-delta", id, delta }`        supervisor's `user_message`, token by token
 *  - `{ type: "text-end", id }`                 closes the text block
 *  - `{ type: "data-<kind>", data, transient }` typed agent-state snapshot
 *  - `{ type: "error", errorText }`             error string
 *  - `{ type: "finish", finishReason }`         finish marker
 *  - `[DONE]`                                   SSE terminator
 *
 * The data parts are typed (`kind` is the second segment of the chunk
 * `type` string, e.g. `"data-phase"`). All 13 typed slices are emitted
 * with `transient: true` so they only fire useChat's `onData` callback
 * and never land in `messages[].parts` — the FE keeps the latest
 * snapshot per kind in Zustand (the pre-v5 demuxer used the same store
 * routing). The two transport kinds `_keepalive` and `_cursor` are
 * also transient: the chat pane's `onData` ignores `_keepalive` and
 * the realtime hook routes `_cursor` to sessionStorage for resume.
 *
 * Strict allow-list: ONLY `on_chain_end` events are forwarded, and only the
 * five known slices per output. `on_chat_model_stream` is dropped so the
 * picker / critic / summarizer / writer JSONs never reach the chat pane.
 */

/**
 * Fold a chronological list of `subagent_run` event payloads into a
 * canonical SubagentRun array — one entry per `call_id`, with the
 * latest emit winning. The event log persists each emit as a separate
 * row (running → ok|error), so on hydration we collapse those back into
 * the per-call snapshot the canvas renders.
 *
 * Skips rows that don't parse as the SubagentRun shape (forward-compat
 * with future schema additions). Orders the result by `started_at` so
 * the canvas renders runs in the order they were dispatched.
 */
function foldSubagentRuns(rows: unknown[]): SubagentRun[] {
  const byCallId = new Map<string, SubagentRun>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Partial<SubagentRun>;
    if (typeof r.call_id !== "string") continue;
    if (typeof r.name !== "string") continue;
    if (typeof r.description !== "string") continue;
    if (typeof r.started_at !== "string") continue;
    if (
      r.status !== "running" &&
      r.status !== "ok" &&
      r.status !== "error"
    ) {
      continue;
    }
    byCallId.set(r.call_id, {
      call_id: r.call_id,
      name: r.name,
      description: r.description,
      status: r.status,
      started_at: r.started_at,
      ended_at: typeof r.ended_at === "string" ? r.ended_at : null,
      output: typeof r.output === "string" ? r.output : null,
      duration_ms:
        typeof r.duration_ms === "number" && Number.isFinite(r.duration_ms)
          ? r.duration_ms
          : null,
      error: typeof r.error === "string" ? r.error : null,
    });
  }
  return Array.from(byCallId.values()).sort((a, b) =>
    a.started_at.localeCompare(b.started_at),
  );
}

/**
 * Fold a chronological list of `subagent_tool_call` event payloads
 * into the canonical SubagentToolCall array — one entry per
 * `tool_call_id`, with the latest emit winning. Matches the
 * `foldSubagentRuns` semantics used for the parent rows.
 *
 * Skips rows that don't parse cleanly so a future schema addition
 * can't break hydration of older threads.
 */
function foldSubagentToolCalls(rows: unknown[]): SubagentToolCall[] {
  const byId = new Map<string, SubagentToolCall>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Partial<SubagentToolCall>;
    if (typeof r.call_id !== "string") continue;
    if (typeof r.tool_call_id !== "string") continue;
    if (typeof r.name !== "string") continue;
    if (typeof r.started_at !== "string") continue;
    if (
      r.status !== "running" &&
      r.status !== "ok" &&
      r.status !== "error"
    ) {
      continue;
    }
    byId.set(r.tool_call_id, {
      call_id: r.call_id,
      tool_call_id: r.tool_call_id,
      name: r.name,
      args:
        r.args && typeof r.args === "object"
          ? (r.args as Record<string, unknown>)
          : {},
      status: r.status,
      started_at: r.started_at,
      ended_at: typeof r.ended_at === "string" ? r.ended_at : null,
      duration_ms:
        typeof r.duration_ms === "number" && Number.isFinite(r.duration_ms)
          ? r.duration_ms
          : null,
      output: typeof r.output === "string" ? r.output : null,
      error: typeof r.error === "string" ? r.error : null,
    });
  }
  // Order chronologically so the canvas SubagentRunRow renders nested
  // tool calls in dispatch order.
  return Array.from(byId.values()).sort((a, b) =>
    a.started_at.localeCompare(b.started_at),
  );
}

/**
 * Slice kinds that MUST be persisted to `agent_events`.
 *
 * Everything else we emit is reachable on reload from one of the other
 * three durable stores already in play:
 *
 *   - LangGraph checkpoint (`state.values.*`) — read by `/state` via
 *     `graph.getAgentSnapshot()` for `phase`, `research_plan`,
 *     `todo_plan`, `manifest`, `activity_*`, `interrupt_payload`,
 *     `interrupt_history`, the two anchors; via `graph.getMessages()`
 *     for `messages`; and via `deepAgent.getVfsSnapshot()` for `files`.
 *     Verified empirically (see PR description): completed deepagent
 *     and legacy threads on production retain their full `messages`
 *     and `files` blobs in the latest checkpoint, contradicting the
 *     audit §2.2 "checkpoint sheds messages" hypothesis (what the
 *     audit observed was MemorySaver-fallback threads with no
 *     checkpoint at all).
 *
 *   - `agent_runs` row — lifecycle (`status`, `finished_at`, `error`).
 *     Read by `runs.latestForThread()`. Makes `done`/`error` slice
 *     persistence redundant, and `run` snapshots redundant.
 *
 *   - Redis Stream `run:<runId>:events` — live channel + 24h replay,
 *     covers driver / follower / disconnect-resume for every kind
 *     including the per-token deltas. The 24h TTL is the live-resume
 *     window we ship; nothing past that needs delta-level granularity.
 *
 * The two kinds below are the ONLY slices the deepagent runner emits
 * that are not exposed in `state.values.*`: a `task()` dispatch is a
 * deepagents-internal middleware call, not a LangGraph state channel,
 * and the same is true of nested tool calls inside a subagent. Without
 * persisting them, the deepagent canvas (Subagents tab + per-row tool
 * call traces) would empty out on reload — see
 * `eventLog.listSubagentRunsForThread` and
 * `eventLog.listSubagentToolCallsForThread`, which are the only two
 * non-fallback reads against `agent_events` left in the codebase.
 *
 * `assistant_text` is intentionally NOT in this set. The audit-era
 * `reconstructMessagesFromEvents` fallback is kept around defensively
 * for legacy threads that still have these rows, but new runs go
 * straight to the checkpoint. See `debugState`.
 */
const DURABLE_EVENT_KINDS = new Set<string>([
  "subagent_run",
  "subagent_tool_call",
  // Per-LLM-call token / cost telemetry, persisted so the eval CLI
  // in `apps/eval/` can compute per-agent token + cost numbers from
  // the durable event log without having to re-run agents to measure
  // them. One row per chat-model invocation; payload is a `LlmUsage`.
  "llm_usage",
]);

@Controller("api/chat")
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    private readonly graph: GraphService,
    private readonly runs: RunRecorder,
    private readonly eventLog: EventLog,
    private readonly runStream: RunStream,
    private readonly runRegistry: RunRegistry,
    private readonly threads: ThreadsService,
    private readonly deepAgent: DeepAgentService,
  ) {}

  @Get(":threadId/state")
  async debugState(@Param("threadId") threadId: string) {
    // Hydration source for the FE on reload. Includes the latest
    // `agent_runs` row so the chat UI can distinguish a thread that
    // is still running server-side from one that died after the tab
    // closed — the LangGraph checkpointer's `phase` alone can't tell
    // them apart (it just stores whatever the last node set, and is
    // never reverted on crash).
    //
    // Chat history is read from the LangGraph checkpointer. Each
    // agent family lives in its own checkpoint schema, so we route
    // by `agent`:
    //
    //   - Legacy v0.x graphs (`syllabus-generator`, `activity-*`)
    //     share the `public` schema PostgresSaver mounted on
    //     `GraphService` — read via `graph.getMessages()`.
    //   - The v1 deep-agent (`agent === "deepagent"`) lives in the
    //     `deep_agent` schema with its own PostgresSaver inside the
    //     deep-agent runner — read via `deepAgent.getMessages()`.
    //     Routing this through `graph.getMessages()` would silently
    //     fall back to the syllabus-generator's checkpointer (the
    //     compiled-graph map has no `deepagent` entry), which has
    //     no record of the thread and returns `[]`. That hits the
    //     `reconstructMessagesFromEvents` branch, which can only
    //     surface `agent_runs.user_message` for non-failed runs —
    //     the AI side disappears entirely (the deep-agent path
    //     intentionally doesn't persist `assistant_text` events,
    //     see `DURABLE_EVENT_KINDS`). Net result before this fix:
    //     chat-pane's `onFinish` resync wiped every assistant
    //     bubble the user just watched stream.
    //
    // The `reconstructMessagesFromEvents` fallback below is kept as
    // defensive code for one specific edge case: threads that booted
    // when `SUPABASE_DB_URL` was unreachable, fell back to the
    // in-memory checkpointer, and therefore have NO checkpoint at all.
    // For those, `getMessages()` returns `[]` and the reconstruction
    // path tries to fish the chat back out of the legacy
    // `agent_events("assistant_text")` rows. New runs no longer write
    // those rows (see `DURABLE_EVENT_KINDS` and `EventLog`'s docstring),
    // so the fallback only ever produces output for old threads.
    const meta = await this.threads.getAgent(threadId);
    const agent: AgentKind = meta?.agent ?? "syllabus-generator";
    const [snap, checkpointMessages, latestRun] = await Promise.all([
      this.graph.getAgentSnapshot(threadId, agent),
      agent === "deepagent"
        ? this.deepAgent.getMessages(threadId)
        : this.graph
            .getMessages(threadId, agent)
            .then((msgs) =>
              msgs.map((m) => ({ role: m._getType(), content: m.content })),
            ),
      this.runs.latestForThread(threadId),
    ]);
    const messagesOut: Array<{ role: string; content: unknown }> =
      checkpointMessages.length > 0
        ? checkpointMessages
        : await this.reconstructMessagesFromEvents(threadId);
    // Deep-agent canvas hydration. The legacy syllabus / activity
    // graphs don't have a VFS or subagent panel, so we only pay the
    // round-trip on `agent === "deepagent"`. VFS comes from the
    // checkpointer (durable, survives run boundaries); subagent runs
    // and their nested tool calls come from the event log (one row
    // per emit, fold-by-id on the server so the latest status wins
    // before we hand the snapshot to the FE).
    let vfs: Record<string, string> = {};
    let subagent_runs: SubagentRun[] = [];
    let subagent_tool_calls: SubagentToolCall[] = [];
    let supervisor_tool_calls: Array<{
      id: string;
      name: string;
      args: Record<string, unknown>;
      status: "ok" | "error";
      preview: string | null;
      anchor_msg_index: number | null;
    }> = [];
    if (agent === "deepagent") {
      const [v, runRows, toolRows, supTools] = await Promise.all([
        this.deepAgent.getVfsSnapshot(threadId),
        this.eventLog.listSubagentRunsForThread(threadId),
        this.eventLog.listSubagentToolCallsForThread(threadId),
        // Supervisor tool calls (write_todos, vfs ops, `task`) walked
        // from the LangGraph checkpoint. Required for the chat-pane
        // to re-render the inline supervisor tool cards on cold
        // reload — without this the chips live only in the in-memory
        // `live_tool_calls` store and disappear on F5.
        this.deepAgent.getSupervisorToolCalls(threadId),
      ]);
      vfs = v;
      subagent_runs = foldSubagentRuns(runRows);
      subagent_tool_calls = foldSubagentToolCalls(toolRows);
      supervisor_tool_calls = supTools;
    }
    return {
      ...snap,
      agent,
      bound_syllabus_thread_id: meta?.bound_syllabus_thread_id ?? null,
      messages: messagesOut,
      latest_run: latestRun,
      vfs,
      subagent_runs,
      subagent_tool_calls,
      supervisor_tool_calls,
    };
  }

  /**
   * Rebuild a `[human, ai, ai?, human, ai, …]` chat history from
   * durable storage when the LangGraph checkpoint no longer carries
   * the messages array.
   *
   * Walks `agent_runs` (oldest first) and for each run emits a `human`
   * message from `user_message`, followed by the run's
   * `assistant_text` events in per-run seq order. Multi-bubble runs
   * (the supervisor calling itself again after a search/write hop)
   * naturally produce multiple AI bubbles between user turns.
   */
  private async reconstructMessagesFromEvents(
    threadId: string,
  ): Promise<Array<{ role: string; content: string }>> {
    const [runs, assistantTexts] = await Promise.all([
      this.runs.listForThread(threadId),
      this.eventLog.listAssistantTextsForThread(threadId),
    ]);
    if (runs.length === 0) return [];
    const aiByRun = new Map<string, Array<{ seq: number; content: string }>>();
    for (const ev of assistantTexts) {
      const arr = aiByRun.get(ev.run_id);
      if (arr) {
        arr.push({ seq: ev.seq, content: ev.content });
      } else {
        aiByRun.set(ev.run_id, [{ seq: ev.seq, content: ev.content }]);
      }
    }
    for (const arr of aiByRun.values()) {
      arr.sort((a, b) => a.seq - b.seq);
    }
    const out: Array<{ role: string; content: string }> = [];
    for (const run of runs) {
      // user_message is nullable on the wire (queued runs that never
      // received the body); skip the human bubble for those rather
      // than rendering an empty turn.
      if (run.user_message) {
        out.push({ role: "human", content: run.user_message });
      }
      const aiTurns = aiByRun.get(run.id) ?? [];
      for (const t of aiTurns) {
        if (t.content) out.push({ role: "ai", content: t.content });
      }
    }
    return out;
  }

  /**
   * Live + replay SSE channel for a thread's most recent run, backed
   * by the Redis stream the active POST writes to.
   *
   * The chat pane uses this for cross-tab visibility and for resuming
   * after a reload mid-run: the FE persists the last seen entry id to
   * `sessionStorage` and passes it as `?lastId=…` so reconnect picks
   * up exactly where the disconnected stream left off — no missed
   * frames, no duplicated frames.
   *
   * Wire format: same Vercel AI SDK Data Stream Protocol v1 as the
   * POST endpoint. The FE demuxes both transports through the same
   * code path. Each typed-slice frame is wrapped to include the
   * Redis entry id in a sidecar header (`x-mpfe-last-id` on the
   * response) so the FE can persist it without parsing the body.
   *
   * Returns 204 with `x-mpfe-no-active-run: 1` if there is no run
   * for this thread (FE falls back to `/state` snapshot).
   */
  @Get(":threadId/stream")
  async streamReplay(
    @Param("threadId") threadId: string,
    @Query("lastId") lastIdRaw: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const latestRun = await this.runs.latestForThread(threadId);
    if (!latestRun) {
      res.setHeader("x-mpfe-no-active-run", "1");
      res.status(204).end();
      return;
    }
    const runId = latestRun.id;
    const lastId = (lastIdRaw && lastIdRaw.trim()) || "-";

    const writer = initStreamingResponse(res, { "x-mpfe-run-id": runId });
    const abort = new AbortController();
    let replayClosed = false;
    req.on("close", () => {
      replayClosed = true;
      abort.abort();
    });
    // Periodic keepalive so HTTP/2 edges (Railway/Cloudflare) don't kill
    // the stream during long idle windows — XREAD BLOCK can park for
    // up to 5 minutes between events while the graph waits on an LLM
    // call. Without this the browser sees ERR_HTTP2_PROTOCOL_ERROR /
    // ERR_CONNECTION_RESET and the agent_run_realtime hook has to
    // reconnect with `lastId`, which is correct but visible.
    const stopKeepalive = startKeepalive(writer, () => replayClosed);

    // Always lead the replay with the run snapshot so consumers that
    // missed the original POST's `run` slice (e.g. a tab opened after
    // a crash) see the badge state immediately, even if the stream
    // was already finalized. All typed slices are transient — the FE
    // keeps them in Zustand keyed by `kind`, never in `messages[].parts`.
    writer.data({ kind: "run", value: latestRun, transient: true });

    let saw: { done: boolean; error: string | null } = {
      done: false,
      error: null,
    };
    // Emit each Redis-assigned entry id alongside its slice so the
    // FE can persist the cursor and resume on reconnect with no
    // missed/duplicated frames. `_cursor` is intentionally not in
    // the typed `DataPart` discriminated union — it's transport-only,
    // ignored by the chat pane store, consumed by the realtime hook.
    // Both the slice itself and the cursor are emitted as v5 transient
    // data parts: the FE only sees them through `onData`, never in
    // `messages[].parts` — same routing as the POST stream.
    const writeEvent = (ev: { id: string; kind: string; payload: unknown }) => {
      writer.data({ kind: ev.kind, value: ev.payload, transient: true });
      writer.data({
        kind: "_cursor",
        value: { id: ev.id },
        transient: true,
      });
      if (ev.kind === "done") saw = { done: true, error: null };
      if (ev.kind === "error") {
        const msg =
          typeof (ev.payload as { message?: string })?.message === "string"
            ? (ev.payload as { message: string }).message
            : "agent run failed";
        saw = { done: true, error: msg };
      }
    };
    try {
      // 1) Backfill from `lastId` (exclusive) to the current end.
      const backfill = await this.runStream.range(runId, lastId);
      for (const ev of backfill) {
        if (abort.signal.aborted) return;
        writeEvent(ev);
      }

      // 2) If we already saw a terminal marker in backfill the run is
      //    finalized — close out without opening a blocking follower.
      if (!saw.done) {
        const cursor = backfill.length
          ? backfill[backfill.length - 1].id
          : lastId;
        for await (const ev of this.runStream.subscribe(
          runId,
          cursor,
          abort.signal,
        )) {
          if (abort.signal.aborted) return;
          writeEvent(ev);
        }
      }

      if (saw.error) writer.error(saw.error);
      writer.finish({ finishReason: saw.error ? "error" : "stop" });
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.warn(`stream replay failed for run ${runId}: ${msg}`);
      try {
        writer.error(msg);
        writer.finish({ finishReason: "error" });
      } catch {
        // response may already be closed
      }
    } finally {
      stopKeepalive();
      res.end();
    }
  }

  @Post(":threadId")
  async chat(
    @Param("threadId") threadId: string,
    @Body() body: ChatBody,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // Resume paths in priority order:
    //   1. body.intake — validated, structured intake_form answer; synthesize
    //      a human-readable userMessage so the run row / chat history make
    //      sense (the [Intake] prefix is the same one DECISION_INSTRUCTIONS
    //      tells the supervisor to expect).
    //   2. body.message / body.messages — regular freeform user turn or
    //      freeform answer to an `ask` interrupt.
    let intakeAnswer: IntakeFormAnswer | undefined;
    if (body.intake !== undefined && body.intake !== null) {
      const parsed = IntakeFormAnswer.safeParse(body.intake);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: "Invalid intake payload", issues: parsed.error.issues });
        return;
      }
      intakeAnswer = parsed.data;
    }

    let activityIntakeAnswer: ActivityIntakeFormAnswer | undefined;
    if (body.activity_intake !== undefined && body.activity_intake !== null) {
      const parsed = ActivityIntakeFormAnswer.safeParse(body.activity_intake);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid activity_intake payload",
          issues: parsed.error.issues,
        });
        return;
      }
      activityIntakeAnswer = parsed.data;
    }

    // Look up the agent + binding for this thread BEFORE allocating any
    // streaming resources. If this fails (e.g. transient Supabase
    // outage) we want a clean JSON 500 rather than a half-flushed SSE
    // response with a leaked keepalive timer + run row + heartbeat.
    let threadAgent: AgentKind = "syllabus-generator";
    let boundSyllabusThreadId: string | null = null;
    try {
      const threadMeta = await this.threads.getAgent(threadId);
      threadAgent = threadMeta?.agent ?? "syllabus-generator";
      boundSyllabusThreadId = threadMeta?.bound_syllabus_thread_id ?? null;
    } catch (err) {
      this.logger.warn(
        `getAgent failed for thread ${threadId}: ${(err as Error).message}`,
      );
      res.status(500).json({
        error: "Could not look up thread metadata. Please retry.",
      });
      return;
    }

    // For activity_intake resume turns, look up real lesson titles from
    // the pending interrupt's `lessons_menu` so the synthesized user
    // message reads as `Lessons: B-tree fundamentals, Hash indexes`
    // instead of `Lessons: 462c0654-…, 0eef98a2-…` (audit §2.3 fix #2).
    // The map is empty for toolless intakes — falls back to id.slice(0,8)
    // inside the synthesizer. Failure is non-fatal: the run still
    // proceeds with id slices and the resolved card downstream picks
    // titles up directly from the menu when GraphService synthesizes
    // `answer.text`.
    let activityLessonTitles: Record<string, string> = {};
    if (activityIntakeAnswer) {
      try {
        activityLessonTitles =
          await this.graph.getPendingActivityIntakeLessonTitles(
            threadId,
            threadAgent,
          );
      } catch (err) {
        this.logger.warn(
          `getPendingActivityIntakeLessonTitles failed for ${threadId}: ${(err as Error).message}`,
        );
      }
    }

    const userMessage = intakeAnswer
      ? this.synthesizeIntakeChatMessage(intakeAnswer)
      : activityIntakeAnswer
        ? this.synthesizeActivityIntakeChatMessage(
            activityIntakeAnswer,
            activityLessonTitles,
          )
        : this.extractLatestUserMessage(body);
    if (!userMessage) {
      res.status(400).json({ error: "No user message provided" });
      return;
    }

    // Resume-from-checkpoint flag. Only honoured for plain `retry: true`
    // re-posts of a freeform message (no intake / activity_intake
    // payload — those have their own resume semantics in graph state).
    // Validated below against agent_runs + the LangGraph checkpoint to
    // make sure we're actually re-running a failed turn whose user
    // message is already at the tail of state.messages. When it can't
    // be honoured we fall through to the legacy append-and-rerun path
    // so a stale FE never ends up posting a no-op resume.
    let resumeFromCheckpoint = false;
    if (body.retry === true && !intakeAnswer && !activityIntakeAnswer) {
      try {
        const latest = await this.runs.latestForThread(threadId);
        const looksLikeRetry =
          !!latest &&
          latest.status === "failed" &&
          latest.user_message === userMessage;
        if (looksLikeRetry) {
          // Confirm the checkpoint actually carries the user message at
          // the tail before we promise the graph a clean resume — older
          // pre-checkpoint failures may have lost it. Deep-agent
          // threads live in the v1 `deep_agent` schema and aren't
          // visible to `GraphService.getMessages` (which routes through
          // the legacy v0.x checkpointer), so we read those via the
          // deep-agent runner directly.
          let tailHumanText: string | null = null;
          if (threadAgent === "deepagent") {
            tailHumanText = await this.deepAgent.getLastHumanText(threadId);
          } else {
            const msgs = await this.graph.getMessages(threadId, threadAgent);
            const tail = msgs.at(-1);
            if (tail && tail._getType() === "human") {
              tailHumanText =
                typeof tail.content === "string" ? tail.content : "";
            }
          }
          if (tailHumanText === userMessage) {
            resumeFromCheckpoint = true;
          }
        }
      } catch (err) {
        this.logger.warn(
          `retry validation failed for ${threadId}: ${(err as Error).message}`,
        );
      }
      if (!resumeFromCheckpoint) {
        // Surface the fall-through so we can spot stale-FE retries in
        // logs without poking at the FE state.
        this.logger.log(
          `retry flag set but resume preconditions not met for ${threadId}; falling back to fresh turn`,
        );
      }
    }

    const writer: DataStreamWriter = initStreamingResponse(res);
    // Decoupled lifetime: this AbortController is tied to the *run*,
    // not to the HTTP request. Closing the tab / refreshing the page
    // MUST NOT abort the agent — only an explicit user action via the
    // Stop button (→ POST :threadId/runs/:runId/cancel) does. We
    // register with RunRegistry as soon as we have a runId so the
    // cancel endpoint can find us. We deliberately do NOT attach
    // `req.on("close", () => abort.abort())` here — that was the bug.
    const abort = new AbortController();
    // After `req.on("close")` we still want to stop streaming bytes
    // to the dead socket (writes are silent no-ops, but it's wasteful
    // and confuses the chunker). This local flag lets the loop bail
    // its writer-side work while letting the graph keep producing
    // events into Redis for cross-tab subscribers and reload paths.
    let clientDisconnected = false;
    req.on("close", () => {
      clientDisconnected = true;
    });
    // Periodic keepalive so HTTP/2 edges (Railway/Cloudflare) don't kill
    // the stream during long idle windows. Long supervisor / writer /
    // critic LLM calls can run 30–60s without producing any wire
    // events; without keepalives the edge closes the stream and the
    // browser surfaces ERR_HTTP2_PROTOCOL_ERROR / ERR_CONNECTION_RESET.
    // The FE demuxer ignores `_keepalive` data parts, so this is
    // invisible to the user.
    const stopKeepalive = startKeepalive(writer, () => clientDisconnected);

    // Run lifecycle row + (narrow) durable event log. The live channel
    // for the FE is the Redis Stream `run:<runId>:events`; the only
    // reason `agent_events` still receives writes is for the two
    // slice families the LangGraph checkpoint can't express
    // (`subagent_run`, `subagent_tool_call` — see DURABLE_EVENT_KINDS
    // for the full reasoning). Every other emit goes Redis-only.
    // Failures here are logged-and-swallowed — the live SSE stream is
    // the source of truth for the active tab and must not block on
    // backing-store hiccups.
    let runId: string | null = null;
    let runRow: RunSnapshot | null = null;
    try {
      runRow = await this.runs.create(threadId, userMessage);
      runId = runRow.id;
      // Seed the per-run seq counter synchronously so the first
      // batch of fire-and-forget appends doesn't race on the
      // cold `await fetchMaxSeq` path. See EventLog.initRun.
      this.eventLog.initRun(runId);
    } catch (err) {
      this.logger.warn(
        `RunRecorder.create failed (continuing without shadow log): ${(err as Error).message}`,
      );
    }
    if (runId) this.runRegistry.register(runId, abort);

    // Last serialized snapshot per kind so we only emit on change.
    // Only snapshot kinds use this dedupe — delta kinds (text deltas,
    // tool-call deltas, tool results) bypass `emit()` entirely and
    // go through `emitDelta()` because every event in those streams
    // is by construction unique.
    type SnapshotKind = Exclude<
      DataPart["kind"],
      | "assistant_text_delta"
      | "tool_call_start"
      | "tool_call_arg_delta"
      | "tool_call_end"
      | "tool_result"
    >;
    const last: Record<SnapshotKind, string | null> = {
      phase: null,
      research_plan: null,
      todo_plan: null,
      manifest: null,
      activity_manifest: null,
      activity_tool_calls: null,
      activity_progress: null,
      activity_worksheets: null,
      interrupt: null,
      interrupt_history: null,
      run: null,
      research_anchor_msg_index: null,
      todo_anchor_msg_index: null,
      // Deep-agent canvas slices. The runtime emit paths for these
      // (`emitVfsUpdate` / `emitSubagentRun` / `emitSubagentTextDelta`)
      // bypass this dedupe map and call `writer.data()` +
      // `runStream.append()` (+ `eventLog.append()` for the kinds in
      // DURABLE_EVENT_KINDS) directly because every delta is unique by
      // construction (path/content delta, call-id snapshot, per-token
      // delta). The entries here exist only to satisfy
      // `Record<SnapshotKind, …>`.
      vfs_update: null,
      subagent_run: null,
      subagent_text_delta: null,
      subagent_tool_call: null,
      // Per-LLM-call token telemetry. Each event is unique (its
      // `run_id` is the LangChain runId of the LLM invocation, distinct
      // per call), so this dedupe slot is satisfied trivially — kept
      // for `Record<SnapshotKind, …>` completeness only.
      llm_usage: null,
    };
    const emit = <K extends SnapshotKind>(
      kind: K,
      value: Extract<DataPart, { kind: K }>["value"],
    ) => {
      const ser = JSON.stringify(value ?? null);
      if (ser !== last[kind]) {
        // Suppress writes to the closed socket but keep mirroring to
        // Redis / Postgres so reconnect / cross-tab consumers see
        // every slice the graph produces. Express makes res.write()
        // a no-op after close, but skipping the call entirely avoids
        // wasted JSON.stringify and keeps the chunker accurate.
        // All 13 typed slices are emitted with `transient: true` so
        // useChat's `onData` fires for them but they NEVER land in
        // `messages[].parts` — the chat pane keeps them in Zustand
        // keyed by `kind` (same routing the v4 demuxer used).
        if (!clientDisconnected)
          writer.data({ kind, value: value ?? null, transient: true });
        last[kind] = ser;
        if (runId) {
          // Fire-and-forget mirroring. Redis is the live channel for
          // every emit; `agent_events` only receives the two slice
          // families the checkpoint can't express. Failures must not
          // block the live SSE stream and are logged inside each
          // service and swallowed.
          void this.runStream.append(runId, kind, value ?? null);
          if (DURABLE_EVENT_KINDS.has(kind)) {
            void this.eventLog.append(threadId, runId, kind, value ?? null);
          }
        }
      }
    };

    let emittedSupervisorTexts = 0;

    // Per-node live-streamed text buffer. The supervisor + activity
    // decide nodes drive their LLM via `streamLlmAndExtractField`,
    // which dispatches `assistant_text_token` custom events as the
    // user-visible field characters arrive. We mirror those characters
    // into this map so the on_chain_end branch below can decide whether
    // to suppress the redundant `streamChunked` emission (when the live
    // tokens already produced the final text) or fall through to it
    // (when a parse failure forced a fallback AIMessage that doesn't
    // match what the user already saw on the wire).
    const liveStreamed = new Map<string, string>();
    // Per-node `blockId` for streaming text deltas. Minted on the
    // first `assistant_text_token` from a node and cleared on the
    // node's `on_chain_end`. The follower side (Redis replay)
    // consumes the resulting `assistant_text_delta` events keyed by
    // blockId so multi-bubble runs (e.g. supervisor calling itself
    // again after a search hop) don't merge into one block. Active
    // POST tabs continue to consume text via the v5 `text-delta`
    // wire frame written by `writer.text(...)`.
    const blockIdByNode = new Map<string, string>();
    // Append-only "delta" emitter for kinds whose stream is unique
    // per event (text deltas, tool-call deltas, tool results). The
    // existing `emit()` dedupes by JSON equality, which is correct
    // for snapshot kinds but wrong for delta kinds — every event
    // is by construction unique and must reach the wire + Redis +
    // Postgres exactly once. Kept narrow to the streaming-foundation
    // kinds so a typo can't accidentally bypass the snapshot dedupe
    // for an existing kind.
    const emitDelta = (
      kind:
        | "assistant_text_delta"
        | "tool_call_start"
        | "tool_call_arg_delta"
        | "tool_call_end"
        | "tool_result",
      value:
        | AssistantTextDelta
        | ToolCallStart
        | ToolCallArgDelta
        | ToolCallEnd
        | ToolResult,
      opts: { skipWire?: boolean } = {},
    ) => {
      // `skipWire` is set by callers whose payload is already on the
      // wire under a different frame type — currently only the text
      // pacer, which writes the v5 `text-delta` frame for the driver
      // tab and uses `assistant_text_delta` purely as a Redis-mirror
      // for follower-tab replay. Other delta kinds (tool_call_*,
      // tool_result) still need the wire emission because the FE has
      // no other way to hear them on the driver tab.
      if (!clientDisconnected && !opts.skipWire) {
        writer.data({
          kind: kind satisfies DataPartKind,
          value,
          transient: true,
        });
      }
      if (runId) {
        // Redis is the only durable mirror for delta kinds. The 24h
        // stream TTL is the live-resume window we ship; nothing past
        // that needs delta-level granularity. The Redis entry is what
        // GET /stream replays as `data-<kind>` wire frames for
        // follower tabs, so dropping the wire emission above never
        // hides events from non-driver consumers.
        void this.runStream.append(runId, kind, value);
      }
    };

    // Per-run smooth-streaming pacer. Buffers `assistant_text_token`
    // events per node and emits them at most one word per
    // `MPFE_SMOOTH_STREAM_INTERVAL_MS` (default 30 ms). For naturally
    // slow LLMs (≥30 ms between tokens) the pacer is a no-op — each
    // token is emitted immediately. For bursty providers (Groq /
    // Gemini-Flash returning a paragraph in 100 ms) the pacer spreads
    // the burst over time so the bubble visibly types in instead of
    // appearing all-at-once.
    //
    // Wire shape per paced chunk:
    //   - `writer.text(chunk)` — the v5 `text-delta` frame the driver
    //     tab consumes via `useChat`'s `messages[]`. Single source of
    //     text on the driver path.
    //   - `emitDelta("assistant_text_delta", …, { skipWire: true })`
    //     — mirrors the same chunk to Redis + Postgres only. Follower
    //     tabs / new-device joins replay it from Redis via GET /stream;
    //     the driver tab already has the text via `text-delta`, so we
    //     suppress the redundant `data-assistant_text_delta` wire
    //     emission to halve text bandwidth on the POST socket.
    const pacer = new TokenPacer((node, chunk) => {
      if (!clientDisconnected) writer.text(chunk);
      const blockId = blockIdByNode.get(node);
      if (blockId) {
        emitDelta(
          "assistant_text_delta",
          { blockId, node, delta: chunk },
          { skipWire: true },
        );
      }
    }, pacerIntervalFromEnv());

    // Controller-side merged research plan. The parallel `search_topic`
    // workers run inside one parent step (Send-fanout), so LangGraph
    // only checkpoints — and therefore only fires `on_chain_end` carrying
    // `research_plan` — once all branches have folded their state slices
    // back via the merge reducer. Without anything mid-flight, the FE
    // would jump from "5 pending topics" straight to "5 done topics"
    // with no per-substep transitions visible.
    //
    // To preserve Perplexity-style live progress across parallel branches,
    // each worker dispatches `research_progress` custom events with a
    // patch for its own step (id + status / counts). The controller
    // merges those patches against the last plan baseline (seeded by
    // `search_planner`'s on_chain_end) and emits the merged plan to the
    // FE on every patch. By the time the parent `on_chain_end` fires,
    // the typed-slice serializer's dedupe will collapse the final
    // emission.
    let liveResearchPlan: ResearchPlan | null = null;

    // Emit the freshly-created run row to the FE before the graph
    // produces any state. This flips the chat UI's RunBadge from
    // idle/whatever-the-last-run-was to `running` immediately, and
    // disables the input box for this turn even if no node has
    // emitted a phase yet.
    if (runRow) emit("run", runRow);

    // ── Deep agent branch (PR #109) ────────────────────────────────
    // The deepagents-based supervisor runs on a different LangChain
    // family (v1.x vs the legacy v0.3.x) and emits a much narrower
    // event vocabulary — there is no phase, research_plan, todo_plan
    // or interrupt yet. Route those threads through a dedicated
    // streaming loop that owns its own teardown so the existing
    // legacy code path stays untouched until the deepagent track is
    // ready to subsume it.
    if (threadAgent === "deepagent") {
      await this.runDeepAgentTurn({
        threadId,
        userMessage,
        abort,
        writer,
        res,
        stopKeepalive,
        clientDisconnected: () => clientDisconnected,
        runId,
        resume: resumeFromCheckpoint,
      });
      return;
    }

    // Heartbeat throttle: fire on *every* graph event (not just
    // on_chain_end), but at most once per HEARTBEAT_DEBOUNCE_MS.
    // Long LLM calls only emit on_chat_model_stream tokens, so
    // gating on on_chain_end means a single 30s+ supervisor call
    // makes the reaper think we crashed. The reaper guards against
    // same-process false positives via EventLog.hasRun(), but
    // heartbeating earlier also keeps cross-process semantics
    // honest if Phase 2 splits the executor out.
    let lastHeartbeatAt = 0;
    const HEARTBEAT_DEBOUNCE_MS = 5_000;
    const maybeHeartbeat = () => {
      if (!runId) return;
      const now = Date.now();
      if (now - lastHeartbeatAt < HEARTBEAT_DEBOUNCE_MS) return;
      lastHeartbeatAt = now;
      void this.runs.heartbeat(runId);
    };

    // Decoupled periodic heartbeat: critical nodes (supervisor.decide,
    // search_summarizer, command_write_one) make blocking `.invoke()`
    // calls on the LLM. During those calls LangGraph emits zero parent
    // events for tens of seconds — the graph-event-driven heartbeat
    // above sits idle and the reaper kills the run with `heartbeat
    // timed out` even though work is progressing fine. A wall-clock
    // timer keeps `last_heartbeat` fresh regardless of where in the
    // graph we are. Cancelled in `finally` so a finished run can never
    // keep heartbeating after `release()`.
    const heartbeatTimer = runId
      ? setInterval(() => {
          if (abort.signal.aborted) return;
          maybeHeartbeat();
        }, HEARTBEAT_DEBOUNCE_MS)
      : null;

    try {
      for await (const ev of this.graph.streamTurn(
        threadId,
        userMessage,
        abort.signal,
        intakeAnswer,
        threadAgent,
        boundSyllabusThreadId,
        activityIntakeAnswer,
        resumeFromCheckpoint,
      )) {
        if (abort.signal.aborted) {
          // Explicit cancel: fall through to the catch branch so the
          // run is recorded as failed (with the cancel reason) and
          // the terminal `error` marker reaches Redis. Returning
          // normally here would route the run through `runs.complete`
          // which is wrong — the user pressed Stop, the work didn't
          // finish.
          throw new Error(
            typeof abort.signal.reason === "string" && abort.signal.reason
              ? abort.signal.reason
              : "run cancelled",
          );
        }
        maybeHeartbeat();

        // Custom events let nodes emit fine-grained progress that's
        // smaller than a full node return. The command subgraph fires
        // `todo_progress` from inside its writer→critic loop so the FE
        // sees per-attempt status flips ("writing attempt 1" →
        // "critiquing" → "writing attempt 2" → "accepted") rather than
        // just the final state at the end of writeOne. Carry both
        // todo_plan and manifest so a single dispatch updates both UI
        // surfaces atomically.
        // Per-substep research progress. Dispatched from inside
        // SearchSubgraph.searchTopic for every transition
        // (searching_urls → picking_candidates → scraping → done /
        // failed) so the FE sees live status flips per topic even
        // though parallel branches share one parent step. Each patch
        // is merged into the controller-side `liveResearchPlan` and
        // emitted as a typed `research_plan` slice; the parent
        // `on_chain_end` later folds the same data through the typed
        // emit dedupe path harmlessly.
        if (
          ev.event === "on_custom_event" &&
          ev.name === "research_progress"
        ) {
          const data = ev.data as
            | { step_id?: string; patch?: Partial<ResearchStep> }
            | undefined;
          if (data?.step_id && data.patch) {
            liveResearchPlan = patchResearchStep(liveResearchPlan, {
              id: data.step_id,
              ...data.patch,
            });
            emit("research_plan", liveResearchPlan);
          }
          continue;
        }

        if (ev.event === "on_custom_event" && ev.name === "todo_progress") {
          const data = ev.data as
            | {
                todo_plan?: TodoPlan | null;
                manifest?: ManifestItem[];
              }
            | undefined;
          if (data?.todo_plan !== undefined) {
            emit("todo_plan", data.todo_plan);
          }
          if (Array.isArray(data?.manifest)) {
            emit("manifest", data.manifest);
          }
          continue;
        }

        // Activity-tooled MCP tool-call timeline. Dispatched from
        // ActivityAgentService.generateTooled before/after every
        // `list_lessons_for_thread` / `get_lesson` round-trip so the FE
        // sees per-call status flips ("calling" → "complete" / "error")
        // live, not just the final array at on_chain_end. Same shape
        // the on_chain_end slice ships, so the FE applies them through
        // the same store setter and dedup is handled by `emit`'s
        // serialized-equality check.
        if (
          ev.event === "on_custom_event" &&
          ev.name === "activity_tool_call"
        ) {
          const data = ev.data as
            | { activity_tool_calls?: ActivityToolCall[] }
            | undefined;
          if (Array.isArray(data?.activity_tool_calls)) {
            emit("activity_tool_calls", data.activity_tool_calls);
          }
          continue;
        }

        // Activity-generator live progress while the writer LLM is
        // streaming the worksheet JSON. Dispatched from
        // `streamWorksheetWithProgress` whenever the partial buffer
        // crosses another item boundary; the FE renders "3/5 MCQs"
        // copy on the drafting manifest card. Emits with `activity_progress: null`
        // at the tail of generation so the FE can drop the progress UI
        // before the final manifest=ready slice lands.
        if (
          ev.event === "on_custom_event" &&
          ev.name === "activity_progress"
        ) {
          const data = ev.data as
            | { activity_progress?: ActivityGenerationProgress | null }
            | undefined;
          if (data && "activity_progress" in data) {
            emit("activity_progress", data.activity_progress ?? null);
          }
          continue;
        }

        // Live `interrupt` draft from the supervisor's streaming JSON
        // envelope. Dispatched by `streamLlmAndExtractStructure` as
        // soon as `question` / `suggestions[i]` / `fields[i]` /
        // `defaults` land in the partial buffer, well before the
        // envelope closes and the supervisor's `on_chain_end` ships
        // the real `interrupt_payload`. The draft slice carries
        // `__draft: true` so the FE renders it with a shimmer; the
        // eventual on_chain_end emit replaces it via `emit()` dedupe.
        // Identical wire shape to the on_chain_end interrupt slice
        // — store setter is shared on the FE side.
        if (
          ev.event === "on_custom_event" &&
          ev.name === "interrupt_progress"
        ) {
          const data = ev.data as
            | { interrupt?: AgentInterrupt | null }
            | undefined;
          if (data && "interrupt" in data) {
            emit("interrupt", data.interrupt ?? null);
          }
          continue;
        }

        // Live LLM token stream from the supervisor / activity decide
        // / chat nodes. `streamLlmAndExtractField` and
        // `streamLlmAndExtractToolCalls` walk the LLM output and
        // dispatch one `assistant_text_token` event per batch of
        // characters. Tokens are routed through the per-run
        // `TokenPacer` (declared above), which:
        //
        //   - emits `writer.text(chunk)` on the v5 wire — the
        //     `text-delta` frame the active POST tab consumes via
        //     `useChat`. Single source of truth for the driver tab.
        //   - mirrors the same chunk to Redis + Postgres via
        //     `emitDelta("assistant_text_delta", …, { skipWire: true })`.
        //     Follower tabs / new-device joins replay these from Redis
        //     via GET /stream, where the replay endpoint re-emits
        //     them as `data-assistant_text_delta` wire frames the
        //     follower's `useAgentRunRealtime` hook consumes. Without
        //     this mirror, only the driver saw the prose preceding an
        //     ask interrupt; followers got the `interrupt` slice but
        //     no chat-bubble context.
        //
        // The `blockId` is minted lazily per (run, node) so a
        // multi-bubble turn (supervisor calling itself again after a
        // search hop) produces multiple blocks the FE can render as
        // separate bubbles, not one merged stream. Cleared on the
        // node's `on_chain_end` below.
        if (
          ev.event === "on_custom_event" &&
          ev.name === "assistant_text_token"
        ) {
          const data = ev.data as
            | { token?: string; node?: string }
            | undefined;
          if (data?.token && data.node) {
            // `liveStreamed` tracks every token the AGENT produced for
            // this node, regardless of whether it has hit the wire yet.
            // The dedup check below (`text.startsWith(streamed)`) needs
            // the full picture — pacer-buffered tokens count too — so
            // the bookkeeping happens on receipt, not on emission.
            liveStreamed.set(
              data.node,
              (liveStreamed.get(data.node) ?? "") + data.token,
            );
            // Mint blockId BEFORE handing the token to the pacer so
            // the pacer's emit callback (which routes via the same
            // blockId for the Redis mirror) always finds one.
            if (!blockIdByNode.has(data.node)) {
              blockIdByNode.set(data.node, randomUUID());
            }
            // Push to the pacer instead of emitting synchronously. The
            // pacer's emit callback writes the v5 `text-delta` frame
            // and mirrors a `data-assistant_text_delta` to wire/Redis/
            // Postgres at a per-node cadence bounded by
            // `MPFE_SMOOTH_STREAM_INTERVAL_MS` (default 30 ms/word).
            pacer.push(data.node, data.token);
          }
          continue;
        }

        // Live LLM tool-call streaming. `streamLlmAndExtractToolCalls`
        // wraps `llm.stream()` so the FE sees args growing live as
        // ChatOpenAI emits `tool_call_chunks`. Three custom events
        // per call: `tool_call_start` (id + name + node + index),
        // many `tool_call_arg_delta` (raw JSON delta), one
        // `tool_call_end` (parsed args once the message closes).
        //
        // All three are mirrored to Redis as typed slices so a
        // follower tab joining mid-stream replays the exact growth
        // sequence — same semantics as the text deltas above. The
        // legacy `activity_tool_call` snapshot envelope is still
        // dispatched alongside (drives the existing chip rendering)
        // until the FE migrates fully to the per-call shape.
        if (
          ev.event === "on_custom_event" &&
          ev.name === "tool_call_start"
        ) {
          const data = ev.data as ToolCallStart | undefined;
          if (data?.id && data.name && data.node) {
            emitDelta("tool_call_start", data);
          }
          continue;
        }
        if (
          ev.event === "on_custom_event" &&
          ev.name === "tool_call_arg_delta"
        ) {
          const data = ev.data as ToolCallArgDelta | undefined;
          if (data?.id && typeof data.delta === "string") {
            emitDelta("tool_call_arg_delta", data);
          }
          continue;
        }
        if (ev.event === "on_custom_event" && ev.name === "tool_call_end") {
          const data = ev.data as ToolCallEnd | undefined;
          if (data?.id && data.args && typeof data.args === "object") {
            emitDelta("tool_call_end", data);
          }
          continue;
        }
        if (ev.event === "on_custom_event" && ev.name === "tool_result") {
          const data = ev.data as ToolResult | undefined;
          if (data?.id && data.name && data.status) {
            emitDelta("tool_result", {
              id: data.id,
              name: data.name,
              status: data.status,
              preview: data.preview ?? null,
              duration_ms: data.duration_ms ?? null,
              error: data.error ?? null,
            });
          }
          continue;
        }
        // Per-LLM-call token usage. Dispatched by each of the three
        // streaming helpers in `apps/api/src/graph/streaming/` after
        // their inner stream closes, carrying the accumulated
        // `AIMessageChunk.usage_metadata` plus identifying metadata
        // (node, tier, model). Routed through `emit("llm_usage", …)`
        // so it lands on the wire AND in `agent_events` (durable —
        // see `DURABLE_EVENT_KINDS`). The eval CLI in `apps/eval/`
        // reads these rows to compute per-agent tokens + cost.
        if (ev.event === "on_custom_event" && ev.name === "llm_usage") {
          const data = ev.data as LlmUsage | undefined;
          if (data?.run_id && data.node) {
            emit("llm_usage", {
              run_id: data.run_id,
              node: data.node,
              tier: data.tier ?? null,
              model: data.model ?? null,
              input_tokens: data.input_tokens ?? null,
              output_tokens: data.output_tokens ?? null,
              total_tokens: data.total_tokens ?? null,
            });
          }
          continue;
        }

        if (ev.event !== "on_chain_end") continue;

        // Some on_chain_end events (notably the END marker) carry a string
        // output like "__end__" or no output at all — guard before any `in`
        // checks so a stray non-object doesn't poison the loop.
        const rawOut = ev.data?.output;
        if (!rawOut || typeof rawOut !== "object" || Array.isArray(rawOut)) {
          continue;
        }
        const out = rawOut as Record<string, unknown>;

        // Chat-pane text. The syllabus-generator emits its assistant
        // turn from the `supervisor` node; the activity agents emit
        // it from a `chat` node (the ReAct loop's conversational
        // step) or, for legacy threads checkpointed before the
        // ReAct refactor, the old `decide` node. Gate on the agent
        // kind so we don't re-stream from intermediate writer /
        // critic nodes inside the syllabus graph (those have their
        // own data parts), and accept the activity loop's
        // intermediate `chat` emissions — the controller's
        // `extractLatestAiText` already returns null when an
        // AIMessage carries only tool_calls, so intermediate ReAct
        // turns are naturally ignored until the model produces a
        // tool-call-free final reply.
        const isChatTextNode =
          (threadAgent === "syllabus-generator" && ev.name === "supervisor") ||
          (threadAgent !== "syllabus-generator" &&
            (ev.name === "chat" || ev.name === "decide"));
        if (isChatTextNode) {
          // Smooth-drain any pacer-buffered tokens for this node BEFORE the
          // dedup check + `streamChunked` fallback. Without this, the
          // tail of a paced stream could still be queued when
          // `on_chain_end` fires; `liveStreamed` would already include
          // the queued tokens but the wire wouldn't, so the fallback
          // would re-emit the un-flushed tail and the user would see
          // the same text twice.
          await pacer.drainSmooth(ev.name);
          const text = this.extractLatestAiText(out);
          if (text) {
            // If the node already live-streamed the same text via
            // `assistant_text_token` events, the wire already carries
            // it — skip the redundant `streamChunked` emission.
            // Otherwise (e.g. the LLM produced one envelope but the
            // node fell back to a different AIMessage, or the node
            // never streamed at all), fall through to the existing
            // post-completion emission so the user still sees the
            // final text.
            const streamed = liveStreamed.get(ev.name);
            const remaining =
              streamed !== undefined && text.startsWith(streamed)
                ? text.slice(streamed.length)
                : text;
            if (!clientDisconnected && remaining) {
              await this.streamChunked(writer, remaining);
            }
            emittedSupervisorTexts += 1;
            // Persist the assistant turn to the durable event log so the
            // `/state` reload path can reconstruct chat history once the
            // LangGraph checkpoint sheds the messages array (audit §2.2).
            // Mirrored to the Redis stream too so a tab opened on a
            // running thread sees the prior assistant texts on backfill,
            // not just the typed slices. Fire-and-forget; failures here
            // must not break the live wire.
            if (runId) {
              // Redis-only: the LangGraph checkpoint already retains the
              // full `messages` array on completed turns (verified — see
              // `DURABLE_EVENT_KINDS` JSDoc), so persisting the consolidated
              // assistant text to `agent_events` would just duplicate the
              // checkpoint. The Redis Stream still carries it for the 24h
              // follower-tab replay window.
              void this.runStream.append(runId, "assistant_text", text);
            }
            // Reset the per-node buffer so a subsequent emission from
            // the same node within this turn (rare, but possible if
            // the graph re-enters) re-evaluates suppression correctly.
            liveStreamed.delete(ev.name);
            // Mint a fresh blockId on the next stream from this node.
            // The FE treats a new blockId as a new assistant bubble,
            // which is exactly the right behaviour when the supervisor
            // re-enters after a search/write hop.
            blockIdByNode.delete(ev.name);
          }
        }

        // Typed slices — emitted on every node end if changed.
        if ("phase" in out) emit("phase", out.phase as AgentPhase);
        if ("research_plan" in out) {
          // Keep the controller-side baseline in sync with the
          // framework's authoritative view so subsequent
          // `research_progress` patches start from the same plan
          // shape — including the planner-emitted stubs (so a
          // status-only patch doesn't have to re-supply title /
          // queries) and the post-merge fan-in (so any per-step
          // diffs from cross-branch reduction are reflected).
          liveResearchPlan = mergeResearchPlan(
            liveResearchPlan,
            out.research_plan as ResearchPlan | null,
          );
          emit("research_plan", liveResearchPlan);
        }
        if ("todo_plan" in out)
          emit("todo_plan", out.todo_plan as TodoPlan | null);
        if ("manifest" in out)
          emit("manifest", out.manifest as ManifestItem[]);
        if ("activity_manifest" in out)
          emit(
            "activity_manifest",
            out.activity_manifest as ActivityManifestItem[],
          );
        if ("activity_tool_calls" in out)
          emit(
            "activity_tool_calls",
            out.activity_tool_calls as ActivityToolCall[],
          );
        if ("activity_worksheets" in out)
          emit(
            "activity_worksheets",
            out.activity_worksheets as Extract<
              DataPart,
              { kind: "activity_worksheets" }
            >["value"],
          );
        if ("interrupt_payload" in out)
          emit("interrupt", out.interrupt_payload as AgentInterrupt | null);
        if ("interrupt_history" in out)
          emit(
            "interrupt_history",
            out.interrupt_history as AgentInterrupt[],
          );
        // Card anchors — server-authoritative position of the AI bubble
        // each card belongs to. The supervisor sets these when it
        // commits a search / write decision, and they survive into the
        // checkpoint, so `/state` hydration places cards in the same
        // chronological slot as the live stream did. See
        // graph/state.ts for the full rationale.
        if ("research_anchor_msg_index" in out)
          emit(
            "research_anchor_msg_index",
            out.research_anchor_msg_index as number | null,
          );
        if ("todo_anchor_msg_index" in out)
          emit(
            "todo_anchor_msg_index",
            out.todo_anchor_msg_index as number | null,
          );
      }

      // Belt-and-braces: if the abort fired but LangGraph closed the
      // async generator gracefully (no throw), the in-loop check above
      // never ran. Re-check here so the run still routes through the
      // failure branch instead of being recorded as `completed`.
      if (abort.signal.aborted) {
        throw new Error(
          typeof abort.signal.reason === "string" && abort.signal.reason
            ? abort.signal.reason
            : "run cancelled",
        );
      }

      // Final drain before the success-path terminal frames. Any
      // tokens still queued after the last `on_chain_end` would
      // otherwise be lost when `writer.finish()` closes the text block.
      await pacer.drainAllSmooth();
      if (emittedSupervisorTexts === 0 && !clientDisconnected) {
        // Fail-safe: surface a status string so the chat pane isn't blank.
        writer.text("(agent finished with no message — check server logs)");
      }
      // If the supervisor paused on an `ask`, the run is logically
      // "interrupted" — surface that as `paused` so the FE can
      // distinguish it from a hard `running` state and gate the
      // input differently (free-text answer allowed; new question
      // not allowed).
      const finalSnap = await this.graph.getAgentSnapshot(
        threadId,
        threadAgent,
      );
      // If the run was explicitly cancelled (Stop button → cancel
      // endpoint), we record it as `failed` with a clear reason. The
      // cancel signal arrives via abort.signal but only after the
      // current LangGraph node yields, so by the time we reach the
      // terminal cleanup the cancel reason may already be on the
      // controller. We treat AbortError-shaped exits as cancellation
      // and route them through the failure branch in `catch`.
      const terminalStatus: "completed" | "paused" =
        finalSnap.interrupt ? "paused" : "completed";
      if (runId) {
        // Lifecycle write is wrapped in try/catch and the error is
        // swallowed (logged only): a Postgres hiccup on the terminal
        // status flip must NOT propagate past this block, otherwise
        // the outer catch would emit `writer.error()` and call
        // `runs.fail()` against a run whose graph work actually
        // completed successfully.
        try {
          if (terminalStatus === "paused") {
            await this.runs.pause(runId);
          } else {
            await this.runs.complete(runId);
          }
        } catch (e) {
          this.logger.warn(
            `runs.complete/pause failed (shadow-mode, swallowed): ${(e as Error).message}`,
          );
        }
        // Wire-ordering contract (mirrored in run-worker.service.ts):
        // the terminal `run` slice MUST be emitted BEFORE the
        // protocol-level `finish` frame on the local socket and
        // BEFORE the `done` / `finalize` markers in Redis. Live
        // cross-tab subscribers (whose `subscribe()` generator exits
        // on `done`) and the driving tab both rely on the `run`
        // slice for user-visible status — the FE explicitly ignores
        // `done` / `error` markers.
        //
        // Crucially this whole block runs BEFORE `writer.finish()`
        // below: the v5 writer's internal `finished` flag would
        // turn the `emit("run", fresh)` call into a silent no-op
        // on the local socket if finish ran first, dropping the
        // terminal slice from the driving tab even though the
        // cross-tab Redis mirror still got it.
        const fresh = await this.runs.getById(runId);
        if (fresh) emit("run", fresh);
        void this.runStream.append(runId, "done", {
          finishReason: "stop",
          status: terminalStatus,
        });
        void this.runStream.finalize(runId);
      }
      if (!clientDisconnected) writer.finish({ finishReason: "stop" });
    } catch (err) {
      // Flush whatever paced text the user has already "earned" before
      // surfacing the error frame — losing the tail of a half-streamed
      // sentence on cancel/error feels worse than the error itself.
      await pacer.drainAllSmooth();
      const msg = (err as Error).message;
      this.logger.error(`stream error: ${msg}`);
      if (!clientDisconnected) writer.error(msg);
      if (runId) {
        // Same swallowing rule for the failure path: `runs.fail()`
        // throwing here would propagate uncaught (we're already in the
        // catch), and the headers have been flushed so NestJS can't
        // send a structured error response anyway.
        try {
          await this.runs.fail(runId, msg);
        } catch (e) {
          this.logger.warn(
            `runs.fail failed (shadow-mode, swallowed): ${(e as Error).message}`,
          );
        }
        // Emit the failed `run` slice BEFORE the `error` marker —
        // see the success-path comment above for the ordering
        // contract. Live cross-tab subscribers' `subscribe()`
        // generator exits on `error`, so the row update must reach
        // the stream first.
        try {
          const fresh = await this.runs.getById(runId);
          if (fresh) emit("run", fresh);
        } catch {
          // best-effort — the writer is about to close anyway
        }
        void this.runStream.append(runId, "error", {
          message: msg,
          recoverable: false,
        });
        void this.runStream.finalize(runId);
      }
      // The `[DONE]` SSE terminator emitted by `writer.finish()` is the
      // only signal v5 `useChat` uses to know the producer has closed.
      // Without it the client's `status` lingers on `'streaming'`
      // (Stop button stays visible, input stays disabled, `onFinish`
      // never fires) until the underlying TCP socket physically dies
      // in `finally → res.end()`. Mirror the GET replay endpoint's
      // error path (lines 313–320) so the FE transitions to terminal
      // state cleanly. The writer's internal `finished` flag makes
      // this a no-op if `finish()` was somehow already called.
      if (!clientDisconnected) {
        try {
          writer.finish({ finishReason: "error" });
        } catch {
          // socket may already be torn down
        }
      }
    } finally {
      // Defensive: clear any pacer timer that might still be queued
      // (e.g. a path that bypassed the success/error drains above).
      pacer.dispose();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      stopKeepalive();
      if (runId) {
        this.eventLog.release(runId);
        this.runRegistry.unregister(runId);
      }
      try {
        res.end();
      } catch {
        // Express has already ended the response after `req.close`;
        // calling end() again throws on some Node versions. Swallow.
      }
    }
  }

  /**
   * Streaming loop for `agent === "deepagent"` threads.
   *
   * Mirrors the legacy supervisor's lifecycle (heartbeat timer +
   * runs.complete/fail + Redis "done"/"error" markers + `writer.finish`
   * + `res.end`) but consumes the much narrower event vocabulary the
   * deepagents runner produces (text-delta + tool-start + tool-end +
   * done/error). Lives inside the chat controller for now so it shares
   * the per-run resources (writer, run row, RunRegistry, EventLog,
   * RunStream) the existing GET /stream replay path already consumes.
   *
   * Wire format is identical to the legacy path:
   *  - `text-delta` frames for token-level supervisor output (driver
   *    tab consumes via `useChat`'s `messages[]`)
   *  - `data-assistant_text_delta` events mirrored to Redis only so
   *    follower-tab replay sees them (skipWire on the local socket)
   *  - `data-tool_call_start` / `data-tool_call_end` for the placeholder
   *    `echo` tool — same kinds the toolless activity agent already
   *    emits, so the chat-pane renders them with the existing
   *    ToolCallCard component without FE changes.
   *
   * No phase / research_plan / todo_plan slices yet — those will be
   * added once subagents are wired and we can decide whether each
   * subagent's lifecycle deserves its own typed slice or whether the
   * existing kinds can be reused.
   */
  private async runDeepAgentTurn(args: {
    threadId: string;
    userMessage: string;
    abort: AbortController;
    writer: DataStreamWriter;
    res: Response;
    stopKeepalive: () => void;
    clientDisconnected: () => boolean;
    runId: string | null;
    resume: boolean;
  }): Promise<void> {
    const {
      threadId,
      userMessage,
      abort,
      writer,
      res,
      stopKeepalive,
      clientDisconnected,
      runId,
      resume,
    } = args;

    // Same heartbeat cadence as the legacy supervisor — see comments
    // around HEARTBEAT_DEBOUNCE_MS in `chat()` for why a wall-clock
    // timer is used in addition to per-event heartbeats.
    const HEARTBEAT_DEBOUNCE_MS = 5_000;
    const heartbeatTimer = runId
      ? setInterval(() => {
          if (abort.signal.aborted) return;
          void this.runs.heartbeat(runId);
        }, HEARTBEAT_DEBOUNCE_MS)
      : null;

    // One stable block id for the whole turn — the deepagent runner
    // produces a single supervisor text stream, no node-keyed
    // multiplexing yet, so we don't need the legacy
    // `blockIdByNode` map.
    const blockId = `deepagent-${runId ?? randomUUID()}`;

    // Accumulator for the supervisor's running assistant text. We
    // mirror per-token deltas as `assistant_text_delta` (live wire +
    // Redis backfill) but `/state` reloads also need a consolidated
    // `assistant_text` event in `agent_events` so the FE can rebuild
    // the chat history once the v1 LangGraph checkpoint sheds the
    // messages array (same durability contract the legacy supervisor
    // uses at line ~1040 — `agent_events.kind = "assistant_text"`,
    // `payload = <full text string>`). Without this, deepagent
    // threads would reload to "empty assistant turn" because the
    // checkpoint reload via `getMessages` short-circuits to the
    // syllabus-generator graph (deepagent isn't in `compiledByAgent`)
    // and falls through to `reconstructMessagesFromEvents`, which
    // only knows how to read `assistant_text` rows.
    //
    // Flushed at every tool boundary (so the FE renders one AI
    // bubble per pre-tool / post-tool segment, matching the legacy
    // supervisor's multi-bubble behaviour after a search/write hop)
    // and one final time after the success branch.
    let assistantTextBuf = "";
    const flushAssistantText = (): void => {
      const text = assistantTextBuf;
      assistantTextBuf = "";
      if (!text || !runId) return;
      // Redis-only — see the legacy-graph flushAssistantText comment.
      void this.runStream.append(runId, "assistant_text", text);
    };

    // Local "run" snapshot dedupe (we only emit it twice in this
    // path: once after runs.complete/fail, identical to the legacy
    // wire-ordering contract).
    let lastRunSer: string | null = null;
    const emitRun = (row: RunSnapshot) => {
      const ser = JSON.stringify(row);
      if (ser === lastRunSer) return;
      lastRunSer = ser;
      if (!clientDisconnected())
        writer.data({ kind: "run", value: row, transient: true });
      if (runId) {
        // Redis-only — `agent_runs` is the durable lifecycle row.
        void this.runStream.append(runId, "run", row);
      }
    };

    // Per-task book-keeping for the canvas's subagent panel.
    // Mirrored to the wire as `subagent_run` data parts AND the chip
    // path (`task` tool_call_start/end + tool_result) — different
    // surfaces need different shapes:
    //   - the chip path drives the chat-pane "task" pill,
    //   - the subagent_run path drives the canvas activity panel
    //     with the full description + final output (no 80-char
    //     truncation), durations, and per-status replacement.
    const subagentRuns = new Map<
      string,
      { name: string; description: string; startedAt: string }
    >();
    const emitSubagentRun = (value: SubagentRun) => {
      if (!clientDisconnected())
        writer.data({ kind: "subagent_run", value, transient: true });
      if (runId) {
        void this.runStream.append(runId, "subagent_run", value);
        void this.eventLog.append(threadId, runId, "subagent_run", value);
      }
    };
    // VFS deltas: Redis-only. The LangGraph checkpoint accumulates the
    // full `state.values.files` map via the deepagents reducer, and
    // `/state` reads it via `deepAgent.getVfsSnapshot()`. The per-write
    // delta is only useful as a live UI tick during streaming.
    const emitVfsUpdate = (value: VfsUpdate) => {
      if (!clientDisconnected())
        writer.data({ kind: "vfs_update", value, transient: true });
      if (runId) {
        void this.runStream.append(runId, "vfs_update", value);
      }
    };
    // Live subagent text-deltas. Routed by call_id to the matching
    // canvas Subagents row for a "thinking…" preview while the
    // run is in flight. Mirrors to Redis Streams so a follower tab
    // (or a post-disconnect resume) catches up to the live buffer,
    // but deliberately does NOT mirror to `agent_events` — the
    // canvas hydrates each row's final answer from the
    // `subagent_run` snapshot on reload, so persisting per-token
    // deltas would be pure write amplification.
    const emitSubagentTextDelta = (value: SubagentTextDelta) => {
      if (!clientDisconnected())
        writer.data({
          kind: "subagent_text_delta",
          value,
          transient: true,
        });
      if (runId) {
        void this.runStream.append(runId, "subagent_text_delta", value);
      }
    };
    // Per-LLM-call token usage. Mirrored to wire (transient — no FE
    // consumer today) + Redis (so reconnect replay carries it) +
    // `agent_events` (durable — the eval CLI in `apps/eval/` reads
    // these rows to compute per-agent tokens + cost). Each event is
    // unique by `LlmUsage.run_id` (the langchain runId of the LLM
    // invocation), so no dedupe is needed.
    const emitLlmUsage = (value: LlmUsage) => {
      if (!clientDisconnected())
        writer.data({ kind: "llm_usage", value, transient: true });
      if (runId) {
        void this.runStream.append(runId, "llm_usage", value);
        void this.eventLog.append(threadId, runId, "llm_usage", value);
      }
    };
    // Per-tool-call book-keeping for the canvas's nested tool-call
    // trace inside each SubagentRunRow. Mirrored to wire +
    // Redis + agent_events so reload replays the full trace.
    //
    // Keyed by the subagent's `tool_call_id` (NOT the parent task
    // call_id) so multiple concurrent calls inside one subagent are
    // tracked independently. The parent task `call_id` is carried in
    // the payload so the FE can group them under their row.
    const subagentTools = new Map<
      string,
      {
        callId: string; // parent task() id (matches the SubagentRun)
        name: string;
        args: Record<string, unknown>;
        startedAt: string;
      }
    >();
    const emitSubagentToolCall = (value: SubagentToolCall) => {
      if (!clientDisconnected())
        writer.data({
          kind: "subagent_tool_call",
          value,
          transient: true,
        });
      if (runId) {
        void this.runStream.append(runId, "subagent_tool_call", value);
        void this.eventLog.append(
          threadId,
          runId,
          "subagent_tool_call",
          value,
        );
      }
    };
    // Cap nested tool-call output previews so the snapshot stays
    // small (the durable artifact still lives in Supabase / VFS).
    // 4 KB is generous enough for `create_lesson` JSON returns and
    // tight enough that `agent_events.payload` rows don't bloat.
    const SUBAGENT_TOOL_OUTPUT_PREVIEW_CHARS = 4000;
    const truncateOutput = (s: string): string =>
      s.length > SUBAGENT_TOOL_OUTPUT_PREVIEW_CHARS
        ? `${s.slice(0, SUBAGENT_TOOL_OUTPUT_PREVIEW_CHARS - 1)}…`
        : s;
    // Per-call_id stable block id. The deepagents library doesn't
    // give us its own block-level structure today (one subagent
    // run = one logical text block in the FE buffer), so we mint
    // a deterministic one keyed off the call_id.
    const subagentBlockId = (callId: string) => `subagent-${callId}`;

    try {
      for await (const chunk of this.deepAgent.stream(threadId, userMessage, {
        signal: abort.signal,
        resume,
      })) {
        if (abort.signal.aborted) {
          // Same explicit-cancel handling as the legacy path.
          throw new Error(
            typeof abort.signal.reason === "string" && abort.signal.reason
              ? abort.signal.reason
              : "run cancelled",
          );
        }

        if (chunk.type === "text-delta") {
          // Subagent text deltas (running inside a `task` tool call)
          // are NOT part of the supervisor's chat bubble — they
          // belong to the canvas Subagents row routed by
          // `subagentCallId`. We emit them as their own
          // `subagent_text_delta` slice so the canvas can render a
          // live thinking preview, but we do NOT call `writer.text`
          // (which would land in `useChat.messages[]` and pollute
          // the supervisor bubble) and we do NOT add to
          // `assistantTextBuf` (which feeds the durable
          // `assistant_text` row used to rebuild the chat history
          // on reload — that buffer must remain supervisor-only).
          // The subagent's *final* answer still reaches the user
          // through the matching `task-end` chunk's `output`,
          // surfaced as the canvas row's expanded output and the
          // chat-pane chip's `tool_result` preview below.
          if (chunk.source === "subagent") {
            if (chunk.subagentCallId) {
              emitSubagentTextDelta({
                call_id: chunk.subagentCallId,
                block_id: subagentBlockId(chunk.subagentCallId),
                delta: chunk.delta,
              });
            }
            continue;
          }
          if (!clientDisconnected()) writer.text(chunk.delta);
          assistantTextBuf += chunk.delta;
          if (runId) {
            const value: AssistantTextDelta = {
              blockId,
              node: "deepagent_supervisor",
              delta: chunk.delta,
            };
            void this.runStream.append(runId, "assistant_text_delta", value);
          }
        } else if (chunk.type === "task-start") {
          // Supervisor delegated to a subagent. Two concurrent
          // surfaces consume this:
          //   1. The chat-pane chip — `tool_call_start` +
          //      `tool_call_end` with name="task" (matched later by
          //      `tool_result` from `task-end`). This is the inline
          //      "task" pill the existing ToolCallCard already
          //      renders.
          //   2. The canvas's subagent panel — `subagent_run` data
          //      part with status="running", carrying the full
          //      description verbatim. Replaced when `task-end`
          //      fires with status="ok" + the full output.
          flushAssistantText();
          const startedAt = new Date().toISOString();
          subagentRuns.set(chunk.callId, {
            name: chunk.subagentName,
            description: chunk.description,
            startedAt,
          });
          const startValue: ToolCallStart = {
            id: chunk.callId,
            name: "task",
            node: "deepagent_supervisor",
            call_index: 0,
          };
          const endValue: ToolCallEnd = {
            id: chunk.callId,
            args: {
              subagent_type: chunk.subagentName,
              description: chunk.description,
            },
          };
          if (!clientDisconnected()) {
            writer.data({
              kind: "tool_call_start",
              value: startValue,
              transient: true,
            });
            writer.data({
              kind: "tool_call_end",
              value: endValue,
              transient: true,
            });
          }
          if (runId) {
            // Redis-only: the FE renders the placeholder `task` chips
            // from live wire frames, and the canvas SubagentRun cards
            // are already persisted via `subagent_run` (which IS in
            // DURABLE_EVENT_KINDS). Mirroring the placeholder chip to
            // `agent_events` would just duplicate the canvas snapshot.
            void this.runStream.append(runId, "tool_call_start", startValue);
            void this.runStream.append(runId, "tool_call_end", endValue);
          }
          emitSubagentRun({
            call_id: chunk.callId,
            name: chunk.subagentName,
            description: chunk.description,
            status: "running",
            started_at: startedAt,
            ended_at: null,
            output: null,
            duration_ms: null,
            error: null,
          });
        } else if (chunk.type === "task-end") {
          // Subagent finished. Two surfaces again:
          //   1. The chip path — `tool_result` with an 80-char
          //      preview (matches every other tool's chip).
          //   2. The canvas's subagent panel — terminal
          //      `subagent_run` snapshot with status="ok" + the FULL
          //      output. Replaces the earlier `running` snapshot
          //      keyed by `call_id`.
          const preview =
            chunk.output.length > 80
              ? `${chunk.output.slice(0, 77)}…`
              : chunk.output;
          const value: ToolResult = {
            id: chunk.callId,
            name: "task",
            status: "ok",
            preview,
            duration_ms: chunk.durationMs,
            error: null,
          };
          if (!clientDisconnected())
            writer.data({
              kind: "tool_result",
              value,
              transient: true,
            });
          if (runId) {
            // Redis-only — see `task-start` comment.
            void this.runStream.append(runId, "tool_result", value);
          }
          const tracked = subagentRuns.get(chunk.callId);
          subagentRuns.delete(chunk.callId);
          emitSubagentRun({
            call_id: chunk.callId,
            name: chunk.subagentName,
            description: tracked?.description ?? "",
            status: "ok",
            started_at: tracked?.startedAt ?? new Date().toISOString(),
            ended_at: new Date().toISOString(),
            output: chunk.output,
            duration_ms: chunk.durationMs,
            error: null,
          });
        } else if (chunk.type === "files-update") {
          // Mirror the deepagents virtual-filesystem delta to the FE
          // canvas. Only the paths that changed in this update are
          // forwarded; FE merges them into a local snapshot. `null`
          // content means the file was deleted.
          //
          // Persisted in the event log (and Redis stream) so the
          // GET /stream replay path can reconstruct the live VFS
          // history for a follower tab. /state hydration on a cold
          // reload reads the durable VFS snapshot directly via
          // `agent.getState()` instead of replaying these deltas.
          const value: VfsUpdate = {
            files: chunk.files,
            subagent_call_id: chunk.subagentCallId ?? null,
          };
          emitVfsUpdate(value);
        } else if (chunk.type === "tool-start") {
          // Subagent's nested tool calls (researcher → Serper, writer
          // → create_lesson, etc.) belong inside the subagent's
          // canvas row, NOT the supervisor's chat bubble. We track
          // them as `subagent_tool_call` snapshots keyed by
          // `tool_call_id`, persisted to the durable event log so
          // reload replays the full nested trace.
          if (chunk.subagentCallId) {
            const startedAt = new Date().toISOString();
            const args =
              chunk.args && typeof chunk.args === "object"
                ? (chunk.args as Record<string, unknown>)
                : {};
            subagentTools.set(chunk.callId, {
              callId: chunk.subagentCallId,
              name: chunk.name,
              args,
              startedAt,
            });
            emitSubagentToolCall({
              call_id: chunk.subagentCallId,
              tool_call_id: chunk.callId,
              name: chunk.name,
              args,
              status: "running",
              started_at: startedAt,
              ended_at: null,
              duration_ms: null,
              output: null,
              error: null,
            });
            continue;
          }
          // Flush any text the supervisor produced before deciding to
          // call this tool — that's a complete pre-tool assistant
          // bubble in `/state` reload terms.
          flushAssistantText();
          // Deepagents gives us the assembled `args` object up-front
          // (no streaming of arg tokens yet — that would require a
          // dedicated wrapper around the LLM's `tool_call_chunks`),
          // so we emit `tool_call_start` and `tool_call_end` back-
          // to-back with the same id. The FE's ToolCallCard already
          // tolerates this — `tool_call_arg_delta` is optional.
          const startValue: ToolCallStart = {
            id: chunk.callId,
            name: chunk.name,
            node: "deepagent_supervisor",
            call_index: 0,
          };
          const endValue: ToolCallEnd = {
            id: chunk.callId,
            args:
              chunk.args && typeof chunk.args === "object"
                ? (chunk.args as Record<string, unknown>)
                : {},
          };
          if (!clientDisconnected()) {
            writer.data({
              kind: "tool_call_start",
              value: startValue,
              transient: true,
            });
            writer.data({
              kind: "tool_call_end",
              value: endValue,
              transient: true,
            });
          }
          if (runId) {
            // Redis-only: live wire frames drive the chip; the parsed
            // tool calls live in `state.values.messages[].tool_calls`
            // (LangGraph checkpoint), so durable mirror would be pure
            // write amplification.
            void this.runStream.append(runId, "tool_call_start", startValue);
            void this.runStream.append(runId, "tool_call_end", endValue);
          }
        } else if (chunk.type === "tool-end") {
          // Symmetric subagent path — emit a terminal
          // `subagent_tool_call` snapshot reusing the start's
          // started_at so the canvas can compute the duration.
          if (chunk.subagentCallId) {
            const tracked = subagentTools.get(chunk.callId);
            subagentTools.delete(chunk.callId);
            const startedAt = tracked?.startedAt ?? new Date().toISOString();
            const startedMs = Date.parse(startedAt);
            const endedAt = new Date().toISOString();
            const duration = Number.isFinite(startedMs)
              ? Math.max(0, Date.now() - startedMs)
              : null;
            emitSubagentToolCall({
              call_id: chunk.subagentCallId,
              tool_call_id: chunk.callId,
              name: chunk.name,
              // tool-end doesn't carry args (the start-chunk did);
              // reuse the tracked args so the snapshot is complete.
              args: tracked?.args ?? {},
              status: "ok",
              started_at: startedAt,
              ended_at: endedAt,
              duration_ms: duration,
              output: truncateOutput(chunk.output),
              error: null,
            });
            continue;
          }
          // Tool finished executing — emit `tool_result` so the
          // ToolCallCard flips from "running" to "completed". Preview
          // is the FE-visible chip text; trim to 80 chars.
          const preview =
            chunk.output.length > 80
              ? `${chunk.output.slice(0, 77)}…`
              : chunk.output;
          const value: ToolResult = {
            id: chunk.callId,
            name: chunk.name,
            status: "ok",
            preview,
            duration_ms: null,
            error: null,
          };
          if (!clientDisconnected())
            writer.data({
              kind: "tool_result",
              value,
              transient: true,
            });
          if (runId) {
            // Redis-only — same reasoning as the deepagent supervisor
            // `tool_call_start` block above.
            void this.runStream.append(runId, "tool_result", value);
          }
        } else if (chunk.type === "llm-usage") {
          // Per-LLM-call token usage from the deepagent. The runner
          // yields this chunk once per chat-model invocation when the
          // provider returned `usage_metadata` on the final
          // `AIMessageChunk`. Routed through the local
          // `emitLlmUsage` helper above (mirrors to wire + Redis +
          // `agent_events`). The eval CLI in `apps/eval/` reads
          // these rows to compute per-agent tokens + cost.
          emitLlmUsage({
            run_id: chunk.runId,
            node: chunk.node,
            tier: "supervisor",
            model: this.deepAgent.getSupervisorModel() || null,
            input_tokens: chunk.inputTokens,
            output_tokens: chunk.outputTokens,
            total_tokens: chunk.totalTokens,
          });
        } else if (chunk.type === "error") {
          throw new Error(chunk.message);
        }
        // chunk.type === "done" — falls through; the iterator ends
        // immediately afterwards anyway.

        if (runId) void this.runs.heartbeat(runId);
      }

      // ── Success path (mirrors the legacy completed/paused branch) ──
      // Persist the trailing assistant text (everything streamed
      // since the last tool-start, or the entire turn if no tool was
      // called). Must precede `runs.complete` so the durable record
      // exists by the time the FE follows up with /state on reload.
      flushAssistantText();
      if (runId) {
        try {
          await this.runs.complete(runId);
        } catch (e) {
          this.logger.warn(
            `runs.complete failed (deepagent, swallowed): ${(e as Error).message}`,
          );
        }
        // Wire-ordering contract — see legacy comment in `chat()`.
        const fresh = await this.runs.getById(runId);
        if (fresh) emitRun(fresh);
        void this.runStream.append(runId, "done", {
          finishReason: "stop",
          status: "completed",
        });
        void this.runStream.finalize(runId);
      }
      if (!clientDisconnected()) writer.finish({ finishReason: "stop" });
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.error(`deepagent stream error: ${msg}`);
      // Flush any in-flight subagent runs to terminal status so the
      // canvas doesn't render forever-spinning entries on error.
      const errorAt = new Date().toISOString();
      for (const [callId, tracked] of subagentRuns.entries()) {
        const startedMs = Date.parse(tracked.startedAt);
        const duration = Number.isFinite(startedMs)
          ? Math.max(0, Date.now() - startedMs)
          : null;
        emitSubagentRun({
          call_id: callId,
          name: tracked.name,
          description: tracked.description,
          status: "error",
          started_at: tracked.startedAt,
          ended_at: errorAt,
          output: null,
          duration_ms: duration,
          error: msg,
        });
      }
      subagentRuns.clear();
      // Same idempotency for nested subagent tool calls — don't leave
      // them spinning in the canvas if the supervisor crashes mid-call.
      for (const [toolCallId, tracked] of subagentTools.entries()) {
        const startedMs = Date.parse(tracked.startedAt);
        const duration = Number.isFinite(startedMs)
          ? Math.max(0, Date.now() - startedMs)
          : null;
        emitSubagentToolCall({
          call_id: tracked.callId,
          tool_call_id: toolCallId,
          name: tracked.name,
          args: tracked.args,
          status: "error",
          started_at: tracked.startedAt,
          ended_at: errorAt,
          duration_ms: duration,
          output: null,
          error: msg,
        });
      }
      subagentTools.clear();
      if (!clientDisconnected()) writer.error(msg);
      if (runId) {
        try {
          await this.runs.fail(runId, msg);
        } catch (e) {
          this.logger.warn(
            `runs.fail failed (deepagent, swallowed): ${(e as Error).message}`,
          );
        }
        try {
          const fresh = await this.runs.getById(runId);
          if (fresh) emitRun(fresh);
        } catch {
          // best-effort — writer is about to close
        }
        void this.runStream.append(runId, "error", {
          message: msg,
          recoverable: false,
        });
        void this.runStream.finalize(runId);
      }
      if (!clientDisconnected()) {
        try {
          writer.finish({ finishReason: "error" });
        } catch {
          // socket may already be torn down
        }
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      stopKeepalive();
      if (runId) {
        this.eventLog.release(runId);
        this.runRegistry.unregister(runId);
      }
      try {
        res.end();
      } catch {
        // Express may already have ended the response.
      }
    }
  }

  /**
   * Explicit, user-driven cancel.
   *
   * Closing the tab / refreshing the page is NOT a cancel — those
   * code paths just stop reading the SSE response, while the run
   * keeps progressing on the server (and other tabs / a reload of
   * the same tab continue to see slices through the Redis stream
   * and `/state`). The Stop button calls this endpoint, which
   * aborts the in-process AbortController owned by the chat handler
   * for that runId.
   *
   * Returns 202 once the cancel request has been broadcast. The owning
   * replica may be a different API process, so local registry misses
   * are not treated as request failures.
   */
  @Post(":threadId/runs/:runId/cancel")
  async cancelRun(
    @Param("threadId") threadId: string,
    @Param("runId") runId: string,
    @Res() res: Response,
  ) {
    const local = await this.runRegistry.cancel(runId, "user pressed Stop");
    if (!local) {
      this.logger.log(
        `cancel: broadcast for run ${runId} (thread=${threadId}); not active on this instance`,
      );
    } else {
      this.logger.log(
        `cancel: aborted run ${runId} (thread=${threadId}) by user request`,
      );
    }
    res.status(202).json({ ok: true, local });
  }

  /** Slow-stream a complete string so the chat UI animates in. */
  private async streamChunked(writer: DataStreamWriter, text: string) {
    const chunkSize = 16;
    for (let i = 0; i < text.length; i += chunkSize) {
      writer.text(text.slice(i, i + chunkSize));
      await new Promise((r) => setTimeout(r, 6));
    }
  }

  private extractLatestUserMessage(body: ChatBody): string | null {
    if (body.message) return body.message;
    if (Array.isArray(body.messages)) {
      const last = [...body.messages].reverse().find((m) => m.role === "user");
      if (!last) return null;
      // v4 shape: `{ role, content }`. Single string.
      if (
        "content" in last &&
        typeof (last as { content?: unknown }).content === "string" &&
        (last as { content: string }).content.length > 0
      ) {
        return (last as { content: string }).content;
      }
      // v5 UIMessage shape: `{ role, parts: UIMessagePart[] }`. Concat
      // every text-typed part into one flat string. Non-text parts
      // (file, reasoning, tool, etc.) are ignored — the supervisor
      // only consumes the user's text turn.
      if ("parts" in last && Array.isArray((last as { parts?: unknown[] }).parts)) {
        const text = ((last as { parts: Array<{ type: string; text?: string }> }).parts ?? [])
          .filter((p) => p && p.type === "text" && typeof p.text === "string")
          .map((p) => p.text as string)
          .join("");
        if (text.length > 0) return text;
      }
    }
    return null;
  }

  /**
   * Mirror of GraphService.synthesizeIntakeMessage — used by the controller
   * to produce the same human-readable chat-history string before the graph
   * runs (so the run row's `last_user_message`, the appended HumanMessage,
   * and the `answer.text` on the resolved intake_form interrupt all match).
   */
  private synthesizeIntakeChatMessage(a: IntakeFormAnswer): string {
    const parts: string[] = [];
    parts.push(`Audience level: ${a.audience_level}`);
    if (a.prior_knowledge.length) {
      parts.push(`Prior knowledge: ${a.prior_knowledge.join(", ")}`);
    } else {
      parts.push("Prior knowledge: (none stated)");
    }
    parts.push(`Time budget: ${a.duration_hours}h`);
    parts.push(`Language: ${a.language}`);
    if (a.target_outcome.trim()) {
      parts.push(`Target outcome: ${a.target_outcome.trim()}`);
    }
    return `[Intake] ${parts.join(". ")}.`;
  }

  /**
   * Mirror of GraphService.synthesizeActivityIntakeMessage. The "[Activity
   * Intake]" prefix is the marker the activity agent watches for to skip
   * the follow-up classifier and route directly to worksheet generation.
   */
  private synthesizeActivityIntakeChatMessage(
    a: ActivityIntakeFormAnswer,
    lessonTitlesById: Record<string, string> = {},
  ): string {
    const parts: string[] = [];
    if (a.lesson_ids.length) {
      const labels = a.lesson_ids.map(
        (id) => lessonTitlesById[id] ?? id.slice(0, 8),
      );
      parts.push(`Lessons: ${labels.join(", ")}`);
    } else {
      parts.push("Lessons: (none — toolless)");
    }
    parts.push(`Difficulty: ${a.difficulty}`);
    parts.push(`MCQs: ${a.mcq_count}`);
    parts.push(`Short-answers: ${a.short_answer_count}`);
    parts.push(`Worked example: ${a.include_worked_example ? "yes" : "no"}`);
    parts.push(`Language: ${a.language}`);
    return `[Activity Intake] ${parts.join(" · ")}`;
  }

  /**
   * Pull only the LATEST AI message added by the node. The reducer
   * concatenates messages, so output.messages may include the human turn
   * plus the new ai turn — we want the new ai content, nothing else.
   */
  private extractLatestAiText(out: unknown): string | null {
    if (!out || typeof out !== "object") return null;
    const o = out as {
      messages?: Array<{ content?: unknown; _getType?: () => string }>;
    };
    if (!Array.isArray(o.messages)) return null;
    for (let i = o.messages.length - 1; i >= 0; i--) {
      const m = o.messages[i];
      if (m?._getType?.() === "ai" && typeof m.content === "string") {
        return m.content;
      }
    }
    return null;
  }
}

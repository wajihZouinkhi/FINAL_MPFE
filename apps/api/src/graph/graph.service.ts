import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { END, Send, START, StateGraph } from "@langchain/langgraph";
import { BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { v4 as uuidv4 } from "uuid";
import { GraphAnnotation, GraphStateType, replaceResearchPlan } from "./state";
import { SupervisorNode } from "./supervisor/supervisor.node";
import { SearchSubgraph } from "./search/search.subgraph";
import { CommandSubgraph } from "./command/command.subgraph";
import { LlmConfigService } from "../config/llm-config.service";
import { AppConfigService } from "../config/app-config.service";
import { ActivityAgentService } from "./activity/activity-agent.service";
import { buildActivityGraph } from "./activity/activity.subgraph";
import type {
  ActivityIntakeFormAnswer,
  ActivityManifestItem,
  ActivityToolCall,
  ActivityWorksheetEmission,
  AgentInterrupt,
  AgentKind,
  AgentPhase,
  IntakeFormAnswer,
  IntakeFormSpec,
  ManifestItem,
  ResearchPlan,
  TodoPlan,
} from "@mpfe/shared";

const SUPERVISOR_HOPS_MAX = 4;

/**
 * Render a structured intake answer as a human-readable user turn so the
 * supervisor's chat history reads coherently and the LLM can pick up each
 * value from the message stream. The "[Intake]" prefix is documented in
 * DECISION_INSTRUCTIONS so the model knows to treat the values as
 * load-bearing constraints on subsequent turns.
 */
/**
 * Render a structured activity-intake answer as a human-readable user turn.
 * The "[Activity Intake]" prefix is the marker the activity agent's
 * `runDecide` checks to skip the follow-up classifier and route directly
 * to generation. Mirrors the syllabus-side `[Intake]` prefix.
 *
 * `lessonTitlesById` resolves UUIDs in `a.lesson_ids` to human-readable
 * lesson titles so the synthesized turn (and the resolved-card mirror
 * downstream) reads as `Lessons: Hashing 101, B-tree fundamentals`
 * instead of `Lessons: 462c0654-…, 0eef98a2-…`. Audit §2.3 fix #2.
 * Falls back to a short id slice when a title is unknown so the prefix
 * marker stays stable for the activity agent's `runDecide` parser.
 */
export function synthesizeActivityIntakeMessage(
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

function synthesizeIntakeMessage(a: IntakeFormAnswer): string {
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
 * Graph topology:
 *
 *           ┌─────────────┐
 *   START → │  supervisor │ → END (action="reply" | "ask")
 *           └─────────────┘
 *               ↓ (search)
 *           ┌─────────────┐
 *           │   search    │ ──┐
 *           └─────────────┘   │
 *                             ↓ feedback to supervisor (≤ SUPERVISOR_HOPS_MAX)
 *               ↓ (write)
 *           ┌─────────────┐
 *           │   command   │ ──┐
 *           └─────────────┘   ↓ wrap-up via supervisor → END
 *
 * `ask` halts the graph at the supervisor with `interrupt_payload` set so
 * the frontend renders an inline question card. The user's answer arrives
 * as the next user turn (a normal POST to /api/chat/:threadId), at which
 * point `interrupt_payload` is cleared and the supervisor sees the answer
 * in its message history.
 *
 * After the command subgraph finishes writing every lesson it routes
 * back through the supervisor (NOT directly to END) so the supervisor
 * produces a brief wrap-up reply ("Done — your syllabus on X is
 * ready"). Without this, the user would see lessons appear in the
 * tree but no closing message in the chat. `command_just_finalized`
 * is the transient flag that triggers the wrap-up branch in the
 * supervisor; it is cleared on the way out.
 */
@Injectable()
export class GraphService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GraphService.name);
  // Registry of compiled graphs keyed by AgentKind. The original
  // syllabus-generator graph is the same one this file used to expose
  // as `compiled`; the activity agents reuse the checkpointer but a
  // distinct StateGraph (different annotation, different node set).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private compiledByAgent: Map<AgentKind, any> = new Map();
  private checkpointer!: MemorySaver | PostgresSaver;

  constructor(
    private readonly cfg: AppConfigService,
    private readonly llm: LlmConfigService,
    private readonly supervisor: SupervisorNode,
    private readonly search: SearchSubgraph,
    private readonly command: CommandSubgraph,
    private readonly activity: ActivityAgentService,
  ) {}

  async onModuleInit() {
    this.checkpointer = await this.buildCheckpointer();
    // `as never` cast: with both v0.x (legacy graph) and v1.x (deep-agent)
    // copies of `@langchain/langgraph-checkpoint` present in the workspace
    // — pinned explicitly for `langgraph-checkpoint-postgres@0.0.3`'s peer
    // and pulled in transitively by `deepagents@1.9` respectively — TS
    // sometimes resolves the `BaseCheckpointSaver` type referenced here
    // through the v1 copy while `langgraph@0.2.74.compile()` expects the
    // v0.0.18 nominal type. Pnpm's runtime symlinks are correct (v0.x
    // postgres-checkpoint loads v0.0.18 langgraph-checkpoint, verified
    // via `require.resolve` traversal); only the typecheck disagrees.
    // Cast scoped to the callsite so the rest of the file stays typed.
    // Mirrors the same v0/v1 cast pattern at `runner.ts` in @mpfe/deep-agent.
    const checkpointer = this.checkpointer as never;
    this.compiledByAgent.set(
      "syllabus-generator",
      this.buildGraph().compile({ checkpointer }),
    );
    this.compiledByAgent.set(
      "activity-generator-tooled",
      buildActivityGraph(this.activity, "tooled").compile({
        checkpointer,
      }),
    );
    this.compiledByAgent.set(
      "activity-generator-toolless",
      buildActivityGraph(this.activity, "toolless").compile({
        checkpointer,
      }),
    );
    this.logger.log(
      `Graphs compiled: ${[...this.compiledByAgent.keys()].join(", ")}`,
    );
    void this.llm; // keep DI dependency stable for tier introspection
  }

  /**
   * Resolve the compiled graph for an agent. Falls back to the
   * syllabus-generator graph for unknown agent strings so legacy
   * threads (with no `agent` column populated) still run.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private compiledFor(agent: AgentKind | string | null | undefined): any {
    const key = (agent ?? "syllabus-generator") as AgentKind;
    return (
      this.compiledByAgent.get(key) ??
      this.compiledByAgent.get("syllabus-generator")
    );
  }

  async onModuleDestroy() {
    if (this.checkpointer instanceof PostgresSaver) {
      await (this.checkpointer as PostgresSaver).end?.();
    }
  }

  private async buildCheckpointer(): Promise<MemorySaver | PostgresSaver> {
    try {
      const saver = PostgresSaver.fromConnString(this.cfg.supabaseDbUrl);
      await saver.setup();
      this.logger.log("Using PostgresSaver checkpointer");
      return saver;
    } catch (err) {
      this.logger.warn(
        `PostgresSaver unavailable (${(err as Error).message}). ` +
          `Falling back to MemorySaver — runs will not persist across restarts.`,
      );
      return new MemorySaver();
    }
  }

  private buildGraph() {
    // Both search and command nodes are wired DIRECTLY into the parent
    // graph (not as compiled subgraphs). Compiled subgraphs in LangGraph
    // JS execute as a single parent step: their internal node returns
    // are NOT propagated to the parent's checkpointer until the
    // subgraph completes, AND their inner `on_chain_end` events are not
    // surfaced on the parent's `streamEvents` v2 stream. That broke
    // reload-mid-flight hydration for research substeps and per-lesson
    // writes, and it broke live SSE updates for both. Inlining the
    // nodes makes every sub-stage transition a parent-level checkpoint
    // and a parent-level `on_chain_end`. See the top-of-file comments
    // in `search/search.subgraph.ts` and `command/command.subgraph.ts`.
    const totalLessons = (s: GraphStateType) =>
      this.command.totalLessons(s);
    return new StateGraph(GraphAnnotation)
      .addNode("supervisor", this.runSupervisor.bind(this))
      .addNode("search_planner", this.search.planner.bind(this.search))
      // `search_topic` is the parallel per-topic worker introduced by
      // audit §2.1's optimisation. The legacy sequential `search_step`
      // node is left out: the parent now fans out via `Send` so every
      // topic's search→pick→scrape pipeline runs concurrently with its
      // siblings, capped by per-call timeouts inside the worker.
      .addNode("search_topic", this.search.searchTopic.bind(this.search))
      .addNode("search_summarizer", this.search.summarizer.bind(this.search))
      .addNode(
        "command_seed_plans",
        this.command.seedPlans.bind(this.command),
      )
      .addNode(
        "command_commit_syllabus",
        this.command.commitSyllabus.bind(this.command),
      )
      .addNode(
        "command_write_one",
        this.command.writeOne.bind(this.command),
      )
      .addNode(
        "command_finalize",
        this.command.finalize.bind(this.command),
      )
      .addEdge(START, "supervisor")
      .addConditionalEdges("supervisor", (s: GraphStateType) => {
        if (s.next_route === "search") return "search_planner";
        if (s.next_route === "command") return "command_seed_plans";
        return END;
      })
      // Fan-out via the LangGraph `Send` API (the canonical primitive
      // for parallel branches in LangGraph). Returning an array of
      // `Send("search_topic", payload)` from a conditional edge spawns
      // one worker per topic; each runs in its own task, and LangGraph
      // implicitly synchronises at the next sequential edge — so the
      // summarizer only fires once every parallel branch has folded
      // its state contribution into the parent via the merge reducers
      // on `research_plan` / `search_plan_internal`. If the planner
      // produced no topics (degenerate case) we route straight to the
      // summarizer so the graph still terminates cleanly.
      .addConditionalEdges("search_planner", (s: GraphStateType) => {
        const internal = s.search_plan_internal;
        if (!internal || internal.topics.length === 0) {
          return "search_summarizer";
        }
        return internal.topics.map(
          (topic, i) =>
            new Send("search_topic", {
              topic_index: i,
              topic,
              goal: internal.goal,
              language: internal.language,
              thread_id: s.thread_id,
            }),
        );
      })
      .addEdge("search_topic", "search_summarizer")
      .addEdge("search_summarizer", "supervisor")
      .addEdge("command_seed_plans", "command_commit_syllabus")
      // Skip straight to finalize when the plan has no lessons — defensive,
      // because the supervisor wouldn't normally route here in that case.
      .addConditionalEdges("command_commit_syllabus", (s: GraphStateType) =>
        totalLessons(s) > 0 ? "command_write_one" : "command_finalize",
      )
      // Wave loop: each `command_write_one` invocation processes every
      // lesson whose `depends_on` set is already in
      // `committed_lesson_ids`, in parallel via Promise.all, and
      // returns the new commits unioned into that set. The next wave
      // either picks up the lessons unblocked by this wave's commits or
      // — if all lessons are committed (or the plan deadlocked) —
      // routes to finalize. Each wave is its own parent-level
      // checkpoint, so the FE can reload mid-build and resume from the
      // last committed snapshot; per-lesson status flips inside the
      // wave are surfaced via `dispatchCustomEvent("todo_progress")`.
      .addConditionalEdges("command_write_one", (s: GraphStateType) => {
        const total = totalLessons(s);
        const committed = (s.committed_lesson_ids ?? []).length;
        if (committed >= total) return "command_finalize";
        // No ready lessons remain even though some are pending — the
        // supervisor's forward-ref drop should prevent this, but we
        // route to finalize defensively so a malformed plan can't
        // hang the graph.
        if (this.command.readyLessons(s).length === 0) {
          return "command_finalize";
        }
        return "command_write_one";
      })
      // Loop back to supervisor for a wrap-up reply instead of ending
      // silently after the writer commits. The supervisor reads the
      // `command_just_finalized` flag set by command_finalize and
      // responds with action="reply" so the user actually sees a
      // closing message in the chat.
      .addEdge("command_finalize", "supervisor");
  }

  /**
   * Supervisor "node" wrapper. Runs the LLM, parses the decision, mutates
   * state to set up the next route, and emits the conversational reply
   * onto state.messages. Subgraphs read what they need from state.
   */
  private async runSupervisor(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    // Wrap-up branch: the command subgraph just finished committing the
    // syllabus and routed back here. Bypass the regular decision LLM
    // (which might re-pick "write" / "search" / "ask" and loop) and
    // instead produce a deterministic short closing message. The flag
    // is cleared on the way out so subsequent user turns aren't biased.
    if (state.command_just_finalized) {
      const aiMessage = await this.supervisor.composeWrapUp(state);
      return {
        messages: [aiMessage],
        phase: "chatting",
        interrupt_payload: null,
        next_route: null,
        command_just_finalized: false,
      };
    }

    const hops = this.countSupervisorHops(state.messages);
    if (hops >= SUPERVISOR_HOPS_MAX) {
      this.logger.warn(
        `supervisor hop cap (${SUPERVISOR_HOPS_MAX}) reached — forcing reply`,
      );
      return {
        messages: [
          {
            role: "assistant",
            content:
              "I've gone in circles a bit — could you give me one more hint about what you'd like in the syllabus?",
          } as unknown as BaseMessage,
        ],
        phase: "chatting",
        interrupt_payload: null,
        next_route: null,
      };
    }

    const { decision, aiMessage } = await this.supervisor.decide(state);

    if (decision.action === "search") {
      this.logger.log(`supervisor → search (${decision.topics.length} topics)`);
      // Detect language ONCE and stash it on search_plan_internal so the
      // summarizer can produce the brief in the user's language and the
      // picker can use it as a tie-breaker on equally-authoritative
      // candidates. Re-detecting at every node would risk drift if the
      // history is compacted or the heuristic flips on a short ack turn.
      const language = this.supervisor.detectLanguage(state.messages);
      return {
        messages: [aiMessage],
        phase: "researching",
        research_plan: replaceResearchPlan({ goal: decision.goal, steps: [] }),
        interrupt_payload: null,
        search_plan_internal: {
          goal: decision.goal,
          topics: decision.topics,
          language,
          candidates_by_topic: {},
        },
        next_route: "search",
        // The new aiMessage is appended at index `state.messages.length`
        // by the MessagesAnnotation reducer, so that's the slot the FE
        // will find the "Researching…" bubble in. The card renders
        // directly under that bubble in both live and hydrated views.
        research_anchor_msg_index: state.messages.length,
      };
    }

    if (decision.action === "write") {
      const plan = this.supervisor.buildPlan(decision);
      this.logger.log(
        `supervisor → command (${plan.chapters.length} chapters, ` +
          `${plan.chapters.reduce((n, c) => n + c.lessons.length, 0)} lessons)`,
      );
      return {
        messages: [aiMessage],
        syllabus_plan: plan,
        phase: "planning",
        interrupt_payload: null,
        next_route: "command",
        // Index of the supervisor's "Here's your … syllabus!" bubble —
        // the TodoCard anchors here so writer/critic progress shows up
        // inline with the message that announced the build.
        todo_anchor_msg_index: state.messages.length,
      };
    }

    if (decision.action === "ask") {
      this.logger.log(`supervisor → ask: ${decision.question}`);
      const interruptId = uuidv4();
      const interrupt: AgentInterrupt = {
        id: interruptId,
        kind: "ask",
        question: decision.question,
        suggestions: decision.suggestions.map((s, i) => ({
          id: `${interruptId}-s${i}`,
          value: s.value,
          ...(s.label != null ? { label: s.label } : {}),
          ...(s.recommended === true ? { recommended: true } : {}),
        })),
        allow_free_text: decision.allow_free_text,
        answer: null,
        intake: null,
        intake_answer: null,
        activity_intake: null,
        activity_intake_answer: null,
      };
      return {
        messages: [aiMessage],
        phase: "asking",
        interrupt_payload: interrupt,
        // Append the new (unanswered) ask onto history so the FE keeps
        // a permanent record across reloads.
        interrupt_history: [...(state.interrupt_history ?? []), interrupt],
        next_route: null,
      };
    }

    if (decision.action === "intake") {
      this.logger.log(`supervisor → intake: ${decision.question}`);
      const interruptId = uuidv4();
      // The intake interrupt shares the AgentInterrupt envelope with `ask`
      // so the FE / DB / replay code can treat it uniformly. The
      // `intake` field carries the form spec; the FE picks IntakeCard
      // vs AskCard off `kind`.
      const intakeSpec: IntakeFormSpec = {
        fields: decision.fields,
        defaults: decision.defaults,
      };
      const interrupt: AgentInterrupt = {
        id: interruptId,
        kind: "intake_form",
        question: decision.question,
        // Intake interrupts intentionally have no suggestions / free-text:
        // the typed form IS the answer surface. We keep the fields on the
        // envelope (defaulted to empty) so existing downstream code that
        // dereferences them keeps working.
        suggestions: [],
        allow_free_text: false,
        answer: null,
        intake: intakeSpec,
        intake_answer: null,
        activity_intake: null,
        activity_intake_answer: null,
      };
      return {
        messages: [aiMessage],
        phase: "asking",
        interrupt_payload: interrupt,
        interrupt_history: [...(state.interrupt_history ?? []), interrupt],
        next_route: null,
      };
    }

    // action === "reply"
    return {
      messages: [aiMessage],
      phase: "chatting",
      interrupt_payload: null,
      next_route: null,
    };
  }

  private countSupervisorHops(messages: BaseMessage[]): number {
    return messages.filter((m) => m instanceof ToolMessage).length;
  }

  /**
   * Stream events for one user turn.
   *
   * The optional `signal` is plumbed into the underlying
   * `streamEvents` config so that an explicit Stop / cancel from the
   * RunRegistry interrupts the graph between nodes (LangGraph checks
   * the signal at every node boundary). It is intentionally NOT wired
   * to `req.on("close")` upstream — closing the tab must not cancel.
   */
  async *streamTurn(
    threadId: string,
    userMessage: string,
    signal?: AbortSignal,
    intakeAnswer?: IntakeFormAnswer,
    agent: AgentKind = "syllabus-generator",
    boundSyllabusThreadId: string | null = null,
    activityIntakeAnswer?: ActivityIntakeFormAnswer,
    resumeFromCheckpoint = false,
  ) {
    const config: Record<string, unknown> = {
      configurable: { thread_id: threadId },
      recursionLimit: 30,
    };
    if (signal) config.signal = signal;
    const compiled = this.compiledFor(agent);

    // Retry-of-a-failed-run: re-run the graph from START with the
    // existing checkpoint state intact, instead of appending another
    // HumanMessage that would leave the supervisor with a
    // `[…, human, human]` history. The chat controller has already
    // verified that the user message is at the tail of
    // `state.messages` and that the latest run for this thread is
    // `failed` with a matching `user_message`.
    //
    // Why `{messages: []}` and not `null`: passing `null` is the
    // canonical "resume an interrupted run" idiom but it requires
    // `CONFIG_KEY_RESUMING` in `configurable` (v1 Pregel raises
    // `EmptyInputError` otherwise), and the langgraph-checkpoint
    // family also persists a `__pregel_resuming` flag whose semantics
    // we don't want to leak into the durable checkpoint. An empty
    // messages array maps to a single channel write with value `[]`,
    // which `messagesStateReducer` (addMessages) treats as a no-op
    // append (state is unchanged) — Pregel still sees a non-empty
    // input write and triggers START normally.
    if (resumeFromCheckpoint) {
      const input: Partial<GraphStateType> = { messages: [] };
      yield* compiled.streamEvents(input, { ...config, version: "v2" });
      return;
    }

    if (agent !== "syllabus-generator") {
      // Activity agents now use the same ask / intake interrupt machinery
      // as the syllabus side. Resume paths:
      //  • activityIntakeAnswer present → resolveLatestActivityIntake fills
      //    `activity_intake_answer` AND `answer.text` on the pending
      //    `activity_intake` interrupt so the chat history reads coherently.
      //  • Otherwise we treat the user message as either freeform ask
      //    resume (if an `ask` interrupt is pending) or a fresh prompt.
      const resolved = activityIntakeAnswer
        ? await this.resolveLatestActivityIntake(
            threadId,
            agent,
            activityIntakeAnswer,
          )
        : await this.resolveLatestAsk(threadId, userMessage, agent);
      const input: Record<string, unknown> = {
        messages: [new HumanMessage(userMessage)],
        thread_id: threadId,
        bound_syllabus_thread_id: boundSyllabusThreadId,
        interrupt_payload: null,
      };
      if (resolved?.history) {
        input.interrupt_history = resolved.history;
      }
      // Persist the structured intake answer onto state so the agent's
      // `runDecide` can branch on `state.activity_intake` next turn
      // without having to re-parse the synthesized "[Activity Intake] …"
      // chat message.
      if (activityIntakeAnswer) {
        input.activity_intake = activityIntakeAnswer;
      }
      yield* compiled.streamEvents(input, { ...config, version: "v2" });
      return;
    }

    // If we were paused on an interrupt, resolve it in interrupt_history
    // before clearing interrupt_payload — this keeps the Q&A visible in
    // the chat as a tool-message bubble after the user answers.
    //
    // Two resume paths:
    //  • freeform ask → resolveLatestAsk, fills `answer.text` from prose.
    //  • structured intake_form → resolveLatestIntake, fills `intake_answer`
    //    AND `answer.text` (so chat history stays human-readable) from the
    //    typed payload posted by IntakeCard.
    const resolvedHistory = intakeAnswer
      ? await this.resolveLatestIntake(threadId, intakeAnswer)
      : (await this.resolveLatestAsk(threadId, userMessage))?.history ?? null;
    const input: Partial<GraphStateType> = {
      messages: [new HumanMessage(userMessage)],
      thread_id: threadId,
      // Clearing the interrupt here means the FE no longer renders the question
      // card once the user has answered.
      interrupt_payload: null,
      ...(resolvedHistory ? { interrupt_history: resolvedHistory } : {}),
    };
    yield* compiled.streamEvents(input, { ...config, version: "v2" });
  }

  /**
   * Look up `lessons_menu` from the latest unanswered `activity_intake`
   * interrupt and return a `lesson_id → title` map. Used by the chat
   * controller to synthesize the user-facing chat message with real
   * lesson titles instead of UUIDs (audit §2.3 fix #2). Returns an
   * empty map for toolless intakes (which have no menu) and for
   * threads with no pending intake.
   */
  async getPendingActivityIntakeLessonTitles(
    threadId: string,
    agent: AgentKind,
  ): Promise<Record<string, string>> {
    const snap = await this.compiledFor(agent).getState({
      configurable: { thread_id: threadId },
    });
    const history =
      (snap?.values?.interrupt_history as AgentInterrupt[] | undefined) ?? [];
    for (let i = history.length - 1; i >= 0; i--) {
      const itr = history[i];
      if (itr.kind !== "activity_intake" || itr.activity_intake_answer) continue;
      const out: Record<string, string> = {};
      const menu = itr.activity_intake?.lessons_menu ?? [];
      for (const opt of menu) out[opt.id] = opt.title;
      return out;
    }
    return {};
  }

  /**
   * Resolve the latest unanswered `activity_intake` interrupt for an
   * activity-generator thread and stamp both the structured answer AND
   * a human-readable synthesized text onto the history entry. Returns
   * the updated history array; null if there's nothing to resolve.
   */
  private async resolveLatestActivityIntake(
    threadId: string,
    agent: AgentKind,
    answer: ActivityIntakeFormAnswer,
  ): Promise<{ history: AgentInterrupt[] } | null> {
    const snap = await this.compiledFor(agent).getState({
      configurable: { thread_id: threadId },
    });
    const history =
      (snap?.values?.interrupt_history as AgentInterrupt[] | undefined) ?? [];
    if (!history.length) return null;
    let pendingIdx = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      const itr = history[i];
      if (itr.kind === "activity_intake" && !itr.activity_intake_answer) {
        pendingIdx = i;
        break;
      }
    }
    if (pendingIdx < 0) return null;
    const pending = history[pendingIdx];
    // Pull lesson titles from the menu the tooled agent attached to the
    // pending interrupt so the resolved card shows real lesson titles
    // instead of raw UUIDs (audit §2.3 fix #2). Toolless intakes leave
    // the menu empty — the synthesizer's per-id fallback to id.slice(0,8)
    // covers that path.
    const lessonTitlesById: Record<string, string> = {};
    const menu = pending.activity_intake?.lessons_menu ?? [];
    for (const opt of menu) lessonTitlesById[opt.id] = opt.title;
    const synthesizedText = synthesizeActivityIntakeMessage(
      answer,
      lessonTitlesById,
    );
    const next: AgentInterrupt = {
      ...pending,
      activity_intake_answer: answer,
      answer: {
        text: synthesizedText,
        suggestion_id: null,
        source: "free_text",
        answered_at: answer.answered_at,
      },
    };
    const updated = [...history];
    updated[pendingIdx] = next;
    return { history: updated };
  }

  /**
   * Find the latest unanswered intake_form interrupt and fill in BOTH the
   * structured `intake_answer` AND a human-readable `answer.text` synthesized
   * from the form fields. The supervisor sees the synthesized text in chat
   * history so it can use the values to fill in audience / scope on the
   * eventual `write` decision; the FE consumes `intake_answer` for the
   * collapsed Q&A trail render.
   */
  private async resolveLatestIntake(
    threadId: string,
    answer: IntakeFormAnswer,
  ): Promise<AgentInterrupt[] | null> {
    const snap = await this.compiledFor("syllabus-generator").getState({
      configurable: { thread_id: threadId },
    });
    const history =
      (snap?.values?.interrupt_history as AgentInterrupt[] | undefined) ?? [];
    if (!history.length) return null;
    let pendingIdx = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      const itr = history[i];
      if (itr.kind === "intake_form" && !itr.intake_answer) {
        pendingIdx = i;
        break;
      }
    }
    if (pendingIdx < 0) return null;
    const pending = history[pendingIdx];
    const synthesizedText = synthesizeIntakeMessage(answer);
    const next: AgentInterrupt = {
      ...pending,
      intake_answer: answer,
      answer: {
        text: synthesizedText,
        suggestion_id: null,
        source: "free_text",
        answered_at: answer.answered_at,
      },
    };
    const updated = [...history];
    updated[pendingIdx] = next;
    return updated;
  }

  /**
   * Find the latest unanswered entry in interrupt_history, fill in its
   * `answer` from the user's text, and return the updated history. Returns
   * null if there's nothing pending (no ask was open).
   */
  private async resolveLatestAsk(
    threadId: string,
    userText: string,
    agent: AgentKind = "syllabus-generator",
  ): Promise<{ history: AgentInterrupt[] } | null> {
    const snap = await this.compiledFor(agent).getState({
      configurable: { thread_id: threadId },
    });
    const history =
      (snap?.values?.interrupt_history as AgentInterrupt[] | undefined) ?? [];
    if (!history.length) return null;
    // Find the latest still-pending ASK (kind === "ask" — old kindless rows
    // default to "ask"). We deliberately skip pending intake_form interrupts
    // here: those must be resolved through resolveLatestIntake with a
    // structured IntakeFormAnswer so `intake_answer` gets filled and the
    // synthesized "[Intake] …" message reaches the supervisor. If a user
    // somehow types prose while an intake_form is pending (the chat input
    // is enabled while paused on intake), the prose lands as a regular
    // user turn but the intake_form interrupt stays pending — so the next
    // graph turn re-emits the interrupt and the form re-renders, instead
    // of silently being resolved with prose and leaving the supervisor
    // without the structured constraints it expects.
    let pendingIdx = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      const itr = history[i];
      if (itr.kind === "intake_form" || itr.kind === "activity_intake") {
        continue;
      }
      if (!itr.answer) {
        pendingIdx = i;
        break;
      }
    }
    if (pendingIdx < 0) return null;
    const pending = history[pendingIdx];
    const trimmed = userText.trim();
    const matched = pending.suggestions.find((s) => s.value === trimmed);
    const next: AgentInterrupt = {
      ...pending,
      answer: {
        text: trimmed,
        suggestion_id: matched?.id ?? null,
        source: matched ? "suggestion" : "free_text",
        answered_at: new Date().toISOString(),
      },
    };
    const updated = [...history];
    updated[pendingIdx] = next;
    return { history: updated };
  }

  /** Snapshot of the streamed slices for hydration on reload. */
  async getAgentSnapshot(
    threadId: string,
    agent: AgentKind = "syllabus-generator",
  ): Promise<{
    phase: AgentPhase;
    research_plan: ResearchPlan | null;
    todo_plan: TodoPlan | null;
    manifest: ManifestItem[];
    activity_manifest: ActivityManifestItem[];
    activity_tool_calls: ActivityToolCall[];
    activity_worksheets: ActivityWorksheetEmission[];
    interrupt: AgentInterrupt | null;
    interrupt_history: AgentInterrupt[];
    research_anchor_msg_index: number | null;
    todo_anchor_msg_index: number | null;
  }> {
    const snap = await this.compiledFor(agent).getState({
      configurable: { thread_id: threadId },
    });
    const v = snap?.values ?? {};
    return {
      phase: (v.phase as AgentPhase | undefined) ?? "idle",
      research_plan: (v.research_plan as ResearchPlan | undefined) ?? null,
      todo_plan: (v.todo_plan as TodoPlan | undefined) ?? null,
      manifest: (v.manifest as ManifestItem[] | undefined) ?? [],
      activity_manifest:
        (v.activity_manifest as ActivityManifestItem[] | undefined) ?? [],
      activity_tool_calls:
        (v.activity_tool_calls as ActivityToolCall[] | undefined) ?? [],
      activity_worksheets:
        (v.activity_worksheets as ActivityWorksheetEmission[] | undefined) ??
        [],
      interrupt: (v.interrupt_payload as AgentInterrupt | undefined) ?? null,
      interrupt_history:
        (v.interrupt_history as AgentInterrupt[] | undefined) ?? [],
      research_anchor_msg_index:
        (v.research_anchor_msg_index as number | null | undefined) ?? null,
      todo_anchor_msg_index:
        (v.todo_anchor_msg_index as number | null | undefined) ?? null,
    };
  }

  async getMessages(
    threadId: string,
    agent: AgentKind = "syllabus-generator",
  ): Promise<BaseMessage[]> {
    const snap = await this.compiledFor(agent).getState({
      configurable: { thread_id: threadId },
    });
    return (snap?.values?.messages as BaseMessage[] | undefined) ?? [];
  }
}

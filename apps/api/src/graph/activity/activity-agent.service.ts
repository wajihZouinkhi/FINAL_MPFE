import { Injectable, Logger } from "@nestjs/common";
import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  SystemMessage,
  ToolMessage,
  isAIMessage,
} from "@langchain/core/messages";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { v4 as uuidv4 } from "uuid";
import { z, type ZodTypeAny } from "zod";
import {
  ActivityManifestItem,
  ActivityToolCall,
  ActivityWorksheetEmission,
  AgentInterrupt,
  Worksheet,
  WorksheetMcq,
  WorksheetShortAnswer,
  WorksheetWorkedExample,
} from "@mpfe/shared";
import { LlmConfigService } from "../../config/llm-config.service";
import { SupabaseService } from "../../supabase/supabase.service";
import { McpClientService } from "./mcp-client.service";
import type { ActivityStateType } from "./state";
import { streamLlmAndExtractToolCalls } from "../streaming/llm-stream-tool-calls";

// ─── System prompts ─────────────────────────────────────────────────
//
// Both prompts deliberately read like instructions to a real teaching
// assistant — warm, willing to chat, willing to use tools when useful.
// They're the only behaviour spec for the new activity agents (no
// classifiers, no intake forms, no deterministic generation paths).

function tooledSystemPrompt(boundThreadId: string | null): string {
  return [
    "You are a friendly, encouraging ed-tech assistant called \"Activity Generator\". You help the user (a teacher) build worksheets grounded in lessons from THEIR existing syllabus.",
    "",
    "Available tools:",
    "  • list_lessons_for_thread(thread_id) — list every lesson in the user's syllabus.",
    "  • get_lesson(lesson_id) — read the full markdown body of a single lesson.",
    "  • ask_user(question, options?, allow_free_text?) — halt and ask the user a clarification question. The FE renders pickable chips + a free-text input; the next turn carries their reply.",
    "  • emit_worksheet(activity_id, lesson_id, lesson_title, worksheet) — deliver the final worksheet to the user.",
    boundThreadId
      ? `\nThe user's syllabus is bound to thread_id "${boundThreadId}". Pass that exact value whenever you call list_lessons_for_thread.`
      : "\nNo syllabus is bound to this thread. If the user asks for a worksheet grounded in their syllabus, explain that they need to bind one first; you can still produce off-syllabus worksheets via emit_worksheet with lesson_id=null.",
    "",
    "How to behave:",
    "1. **Greet warmly** when the user opens the chat. If they say hi / hello / yo / hey or ask a meta question (\"what can you do\", \"what tools do you have\", \"how does this work\"), reply conversationally — DO NOT call any tool. Keep replies under ~50 words and end with a concrete example of what they can ask for.",
    "2. **Use tools to answer questions about the syllabus.** If the user asks anything like \"what lessons do you see\", \"how many lessons are there\", \"list the chapters\", \"do you see lesson X\" → call list_lessons_for_thread first, then answer based on the result.",
    "3. **Plan tool sequences yourself.** When the user wants a worksheet but hasn't picked a lesson, call list_lessons_for_thread first, then call ask_user with the lesson titles as `options` so the user can pick with a single click. When they pick a lesson, call get_lesson to read it before drafting questions. You don't need to interrogate the user at every step — gather what you can with tools first.",
    "4. **Use ask_user for choices, not chat prose.** When you need a clarification (which lesson, how many MCQs, difficulty, language), call `ask_user` with concrete `options` (e.g. options=[\"Photosynthesis Basics\",\"Cell Respiration\",\"Water Cycle\"]) instead of writing the question as plain markdown. This gives the user a clickable picker. Set `allow_free_text: false` only when ANY non-listed answer would be invalid.",
    "5. **Read context before asking.** The full conversation history is available to you, including every previous tool call and result. Re-use the menu you already fetched instead of refetching; remember the user's earlier preferences (difficulty, counts, language) instead of re-asking.",
    "6. **Sensible defaults if the user doesn't specify**: medium difficulty, 4 MCQs, 1 short-answer, 1 worked example, English. Mention them briefly and offer to tweak via `ask_user` — don't block.",
    "7. **Worksheet schema (must match exactly inside emit_worksheet args.worksheet):**",
    "   {",
    "     \"title\": string,",
    "     \"intro\": string,                                       // one-line orientation paragraph",
    "     \"mcqs\": [ { \"question\": string, \"options\": [4 strings], \"correct_index\": 0|1|2|3, \"explanation\": string } ],",
    "     \"short_answers\": [ { \"prompt\": string, \"model_answer\": string } ],",
    "     \"worked_example\": { \"prompt\": string, \"steps\": [string], \"final_answer\": string } | null",
    "   }",
    "   Each MCQ has EXACTLY 4 options. Pick correct_index in 0..3. mcqs must have at least 1 entry and at most 8.",
    "8. Call emit_worksheet ONCE per worksheet. activity_id can be any unique string (a UUID is fine). lesson_id is the id you grounded in (or null for off-syllabus). lesson_title is the lesson's title (or a short topic title for off-syllabus).",
    "9. After emit_worksheet returns successfully, send a short confirmation message (one sentence, no markdown headers). Do NOT re-emit the worksheet text in the chat — the FE already renders it inline as a card from the tool args.",
    "",
    "Be concise, kind, and confident. Answer in the language the user wrote in.",
  ].join("\n");
}

const TOOLLESS_SYSTEM_PROMPT = [
  "You are a friendly, encouraging ed-tech assistant called \"Activity Generator (toolless mode)\". You help the user (a teacher) build worksheets on whatever topic they describe. There is no syllabus binding — every worksheet is generated purely from the topic the user gives you.",
  "",
  "Available tools:",
  "  • ask_user(question, options?, allow_free_text?) — halt and ask the user a clarification question. The FE renders pickable chips + a free-text input; the next turn carries their reply.",
  "  • emit_worksheet(activity_id, lesson_id, lesson_title, worksheet) — deliver the final worksheet to the user. lesson_id should be null in this mode.",
  "",
  "How to behave:",
  "1. **Greet warmly** when the user opens the chat. If they say hi / hello / yo / hey or ask a meta question (\"what can you do\", \"what tools do you have\", \"how does this work\"), reply conversationally — DO NOT call emit_worksheet. Keep replies under ~50 words and end with a concrete example of what they can ask for.",
  "2. **Read the full conversation history** before responding. Remember preferences from earlier turns (difficulty, counts, language, topic) and don't re-ask things the user has already told you.",
  "3. **Use ask_user for choices.** When you genuinely need a clarification (topic, difficulty, MCQ count, language), call `ask_user` with concrete `options` (e.g. options=[\"Easy\",\"Medium\",\"Hard\"]) so the user gets a clickable picker. Don't write the question as plain markdown when a chip would be faster.",
  "4. **Sensible defaults if the user doesn't specify**: medium difficulty, 4 MCQs, 1 short-answer, 1 worked example, English. Mention them briefly and offer to tweak via `ask_user` — don't block.",
  "5. Be transparent in the worksheet's `intro` line that it is unsourced (no course-material grounding) so teachers know to verify before classroom use.",
  "6. **Worksheet schema (must match exactly inside emit_worksheet args.worksheet):**",
  "   {",
  "     \"title\": string,",
  "     \"intro\": string,",
  "     \"mcqs\": [ { \"question\": string, \"options\": [4 strings], \"correct_index\": 0|1|2|3, \"explanation\": string } ],",
  "     \"short_answers\": [ { \"prompt\": string, \"model_answer\": string } ],",
  "     \"worked_example\": { \"prompt\": string, \"steps\": [string], \"final_answer\": string } | null",
  "   }",
  "   Each MCQ has EXACTLY 4 options. correct_index is 0..3. mcqs must have at least 1 entry and at most 8.",
  "7. Call emit_worksheet ONCE per worksheet. activity_id can be any unique string. lesson_id is null. lesson_title is a short title for the worksheet topic.",
  "8. After emit_worksheet returns successfully, send a short confirmation message (one sentence, no markdown headers). The FE renders the worksheet card automatically from the tool args.",
  "",
  "Be concise, kind, and confident. Answer in the language the user wrote in.",
].join("\n");

// ─── Schemas for the emit_worksheet tool's input ─────────────────────
//
// The LLM emits the entire worksheet payload as args of a single tool
// call. We define the schema in zod so ChatOpenAI.bindTools can show
// the model an accurate JSON Schema, and so we can re-validate before
// committing to Supabase / streaming the worksheet to the FE.

const WorksheetMcqArgs = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).length(4),
  correct_index: z.number().int().min(0).max(3),
  explanation: z.string().default(""),
});

const WorksheetShortAnswerArgs = z.object({
  prompt: z.string().min(1),
  model_answer: z.string().default(""),
});

const WorksheetWorkedExampleArgs = z.object({
  prompt: z.string().default(""),
  steps: z.array(z.string()).default([]),
  final_answer: z.string().default(""),
});

const EmitWorksheetArgsSchema = z.object({
  activity_id: z
    .string()
    .min(1)
    .describe(
      "Unique id for this worksheet (any string; a UUID is recommended).",
    ),
  lesson_id: z
    .string()
    .nullable()
    .optional()
    .describe(
      "The lesson id this worksheet is grounded in. null/empty for off-syllabus worksheets.",
    ),
  lesson_title: z
    .string()
    .describe(
      "Title of the lesson (or a short topic title for off-syllabus worksheets).",
    ),
  worksheet: z
    .object({
      title: z.string(),
      intro: z.string().default(""),
      mcqs: z.array(WorksheetMcqArgs).min(1).max(8),
      short_answers: z.array(WorksheetShortAnswerArgs).default([]),
      worked_example: WorksheetWorkedExampleArgs.nullable().default(null),
    })
    .describe("The worksheet payload. Each MCQ has EXACTLY 4 options."),
});

type EmitWorksheetArgsType = z.infer<typeof EmitWorksheetArgsSchema>;

// ─── ask_user tool ────────────────────────────────────────────────────
//
// The agent calls `ask_user` to halt the loop and ask the user a
// targeted clarification question (e.g. "which lessons to ground in?",
// "how many MCQs?"). It's a pseudo-tool: the runtime never invokes it
// against a real function; instead the tools node intercepts the call
// and:
//   1. Sets `state.interrupt_payload` to an "ask" interrupt the FE
//      already knows how to render via AskCard (chips + free-text input).
//   2. Appends a synthetic ToolMessage so the LLM's tool-call /
//      tool-message pairing stays balanced (every tool_call needs a
//      matching ToolMessage or the model errors on the next turn).
//   3. The graph's conditional edge after `tools` halts on END instead
//      of looping back to `chat`, so we wait for the user's answer.
// When the user replies, the existing `resolveLatestAsk` machinery in
// graph.service.ts fills `answer.text` and the next chat turn sees
// the answered question in context.
const AskUserArgsSchema = z.object({
  question: z
    .string()
    .min(1)
    .describe("The clarifying question to ask the user, in their language."),
  options: z
    .array(z.string().min(1))
    .max(8)
    .default([])
    .describe(
      "Optional pickable answer chips. Keep them short (≤ 6 words). The user can also answer in free text.",
    ),
  allow_free_text: z
    .boolean()
    .default(true)
    .describe(
      "If false, force the user to pick one of the supplied options. Defaults to true.",
    ),
});

type AskUserArgsType = z.infer<typeof AskUserArgsSchema>;

// Dodge `DynamicStructuredTool`'s 4-generic inference (TS2589) by
// constructing the tool through a relaxed alias — same trick used in
// mcp-client.service.ts.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TOOL_CTOR = DynamicStructuredTool as unknown as new (input: any) => {
  name: string;
};

@Injectable()
export class ActivityAgentService {
  private readonly logger = new Logger(ActivityAgentService.name);

  constructor(
    private readonly llm: LlmConfigService,
    private readonly supa: SupabaseService,
    private readonly mcp: McpClientService,
  ) {}

  // ─── Chat node ──────────────────────────────────────────────────────
  /**
   * Run one chat turn. Streams LLM tokens to the FE via the existing
   * `assistant_text_token` custom event channel and returns an
   * AIMessage that may carry `tool_calls`. The conditional edge in
   * `activity.subgraph.ts` decides whether to loop into the tools node
   * or terminate.
   */
  async runChat(
    state: ActivityStateType,
    mode: "tooled" | "toolless",
  ): Promise<Partial<ActivityStateType>> {
    let tools: DynamicStructuredTool[];
    try {
      tools = await this.toolsFor(mode);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      this.logger.error(`Activity agent failed to load tools: ${msg}`);
      return {
        messages: [
          new AIMessage(
            `I couldn't load my tools right now (${msg}). Try again in a moment.`,
          ),
        ],
        phase: "chatting",
      };
    }

    const llm = this.llm
      .get("supervisor", { temperature: 0.4 })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .bindTools(tools as any);
    const llmModel = this.llm.rawConfig("supervisor").model;

    const systemPrompt =
      mode === "tooled"
        ? tooledSystemPrompt(state.bound_syllabus_thread_id)
        : TOOLLESS_SYSTEM_PROMPT;

    // Filter out any synthetic transition messages we used to prepend
    // for the old intake form. The new agent reads the full
    // conversation history as-is so it can plan tool sequences itself
    // (the user explicitly asked for this).
    const history = state.messages;
    const messages: BaseMessage[] = [
      new SystemMessage(systemPrompt),
      ...history,
    ];

    // Stream tokens AND tool-call arg deltas for live chat-pane
    // updates. The helper dispatches `assistant_text_token` for text
    // content (chat.controller forwards that to v5 text frames + a
    // mirrored `assistant_text_delta` typed slice for follower tabs)
    // and `tool_call_start` / `tool_call_arg_delta` / `tool_call_end`
    // for each tool call ChatOpenAI emits, so the FE can render args
    // growing live instead of waiting on the spinner. Returns the
    // combined `AIMessageChunk` so `tool_calls` (rebuilt from the
    // `tool_call_chunks` stream) is available verbatim for the final
    // AIMessage.
    let combined: AIMessageChunk | undefined;
    try {
      combined = await streamLlmAndExtractToolCalls(llm, messages, {
        node: "chat",
        tier: "supervisor",
        model: llmModel,
      });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      this.logger.error(`Activity chat LLM failed: ${msg}`);
      return {
        messages: [
          new AIMessage(`Sorry — I hit an LLM error: ${msg}. Try again.`),
        ],
        phase: "chatting",
      };
    }

    if (!combined) {
      return {
        messages: [new AIMessage("(no response)")],
        phase: "chatting",
      };
    }

    // Build the final AIMessage. Carrying the chunk's `tool_calls`
    // verbatim preserves ids that the tools node needs to attach the
    // resulting ToolMessages to.
    const finalMessage = new AIMessage({
      content: combined.content,
      tool_calls: combined.tool_calls ?? [],
    });
    const hasToolCalls = (finalMessage.tool_calls?.length ?? 0) > 0;
    return {
      messages: [finalMessage],
      phase: hasToolCalls ? "writing" : "chatting",
      interrupt_payload: null,
    };
  }

  // ─── Tools node ─────────────────────────────────────────────────────
  /**
   * Execute every tool call the prior chat turn requested, in order,
   * dispatching `activity_tool_call` events around each call so the FE
   * sees per-call status flips live. `emit_worksheet` is intercepted
   * here (the LLM never invokes a runtime function for it — we
   * validate the args, persist the worksheet to Supabase, and append
   * an `activity_worksheets` emission for the FE).
   */
  async runTools(
    state: ActivityStateType,
    mode: "tooled" | "toolless",
  ): Promise<Partial<ActivityStateType>> {
    const messages = state.messages;
    const last = messages[messages.length - 1];
    if (!last || !isAIMessage(last) || !(last.tool_calls?.length ?? 0)) {
      return {};
    }

    let tools: DynamicStructuredTool[];
    try {
      tools = await this.toolsFor(mode);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      this.logger.error(`Activity tools node failed to load tools: ${msg}`);
      const failures: ToolMessage[] = (last.tool_calls ?? []).map(
        (call) =>
          new ToolMessage({
            content: `error: ${msg}`,
            tool_call_id: call.id ?? uuidv4(),
          }),
      );
      return { messages: failures, phase: "chatting" };
    }

    const trace: ActivityToolCall[] = [...(state.activity_tool_calls ?? [])];
    const newMessages: BaseMessage[] = [];
    let worksheetEmission: ActivityWorksheetEmission | null = null;
    let manifestAddition: ActivityManifestItem | null = null;
    let askInterrupt: AgentInterrupt | null = null;
    // Index of the AIMessage that produced these tool calls inside
    // `state.messages`. The FE matches each `activity_worksheets`
    // entry to its anchor turn via this index.
    const anchorIdx = messages.length - 1;

    for (const call of last.tool_calls ?? []) {
      const traceEntry: ActivityToolCall = {
        id: call.id ?? `t-${trace.length}`,
        name: call.name,
        args: (call.args ?? {}) as Record<string, unknown>,
        status: "calling",
        result_preview: null,
        error: null,
        started_at: new Date().toISOString(),
        ended_at: null,
        // Pin every tool call to the AIMessage that issued it so the
        // FE renders the chip inline under that turn (BEENET-style
        // chronology) instead of aggregating all calls at the tail.
        anchor_msg_index: anchorIdx,
      };
      trace.push(traceEntry);
      await this.dispatchToolCallTrace(trace);
      const startedAtMs = Date.now();

      try {
        if (call.name === "emit_worksheet") {
          const handled = await this.handleEmitWorksheet(
            state,
            call,
            anchorIdx,
          );
          worksheetEmission = handled.emission;
          manifestAddition = handled.manifest;
          traceEntry.status = "complete";
          traceEntry.result_preview = handled.preview;
          traceEntry.args = handled.normalizedArgs;
          traceEntry.ended_at = new Date().toISOString();
          newMessages.push(
            new ToolMessage({
              content: handled.toolMessage,
              tool_call_id: traceEntry.id,
            }),
          );
        } else if (call.name === "ask_user") {
          const handled = this.handleAskUser(call);
          askInterrupt = handled.interrupt;
          traceEntry.status = "complete";
          traceEntry.result_preview = handled.preview;
          traceEntry.args = handled.normalizedArgs;
          traceEntry.ended_at = new Date().toISOString();
          newMessages.push(
            new ToolMessage({
              content: handled.toolMessage,
              tool_call_id: traceEntry.id,
            }),
          );
        } else {
          const tool = tools.find((t) => t.name === call.name);
          if (!tool) {
            throw new Error(`Unknown tool: ${call.name}`);
          }
          // tools.invoke: DynamicStructuredTool returns a string per
          // the LangChain tool contract. The MCP routed tools in
          // mcp-client.service.ts already serialise objects to JSON
          // before returning.
          const result = await tool.invoke(
            (call.args ?? {}) as Record<string, unknown>,
          );
          const resultString =
            typeof result === "string" ? result : JSON.stringify(result);
          traceEntry.status = "complete";
          traceEntry.result_preview = previewToolResult(call.name, result);
          traceEntry.ended_at = new Date().toISOString();
          newMessages.push(
            new ToolMessage({
              content: resultString,
              tool_call_id: traceEntry.id,
            }),
          );
        }
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        this.logger.warn(`Activity tool ${call.name} failed: ${msg}`);
        traceEntry.status = "error";
        traceEntry.error = msg;
        traceEntry.ended_at = new Date().toISOString();
        newMessages.push(
          new ToolMessage({
            content: `error: ${msg}`,
            tool_call_id: traceEntry.id,
          }),
        );
      }
      await this.dispatchToolCallTrace(trace);
      // Per-call result envelope. Mirrored to the Redis stream by the
      // chat controller so follower tabs / replay reconstruct the
      // exact "calling → ok|error" timing without parsing the
      // snapshot blob. Decoupled from the activity_tool_calls
      // snapshot deliberately — every code path that runs tools can
      // emit `tool_result` without owning the per-thread trace shape.
      await this.dispatchToolResult({
        id: traceEntry.id,
        name: traceEntry.name,
        status: traceEntry.status === "error" ? "error" : "ok",
        preview: traceEntry.result_preview,
        duration_ms: Date.now() - startedAtMs,
        error: traceEntry.error,
      });
    }

    const patch: Partial<ActivityStateType> = {
      messages: newMessages,
      activity_tool_calls: trace,
      phase: askInterrupt ? "asking" : "writing",
    };
    if (worksheetEmission) {
      patch.activity_worksheets = [
        ...(state.activity_worksheets ?? []),
        worksheetEmission,
      ];
    }
    if (manifestAddition) {
      patch.activity_manifest = [
        ...(state.activity_manifest ?? []),
        manifestAddition,
      ];
    }
    if (askInterrupt) {
      patch.interrupt_payload = askInterrupt;
      patch.interrupt_history = [
        ...(state.interrupt_history ?? []),
        askInterrupt,
      ];
    }
    return patch;
  }

  // ─── ask_user handling ──────────────────────────────────────────────
  private handleAskUser(call: { id?: string; name: string; args?: unknown }): {
    interrupt: AgentInterrupt;
    preview: string;
    toolMessage: string;
    normalizedArgs: Record<string, unknown>;
  } {
    const parsed = AskUserArgsSchema.safeParse(call.args);
    if (!parsed.success) {
      throw new Error(
        `ask_user args invalid: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    const args: AskUserArgsType = parsed.data;
    const suggestionEntries = (args.options ?? []).map((opt, i) => ({
      id: `opt-${i}`,
      value: opt,
      label: opt,
    }));
    const interrupt: AgentInterrupt = {
      id: uuidv4(),
      kind: "ask",
      question: args.question,
      suggestions: suggestionEntries,
      allow_free_text: args.allow_free_text ?? true,
      answer: null,
      intake: null,
      intake_answer: null,
      activity_intake: null,
      activity_intake_answer: null,
    };
    const preview = `asked: "${args.question.slice(0, 60)}${args.question.length > 60 ? "…" : ""}"`;
    return {
      interrupt,
      preview,
      toolMessage:
        "asked the user; awaiting their reply (rendered as an inline question card).",
      normalizedArgs: {
        question: args.question,
        options: args.options ?? [],
        allow_free_text: args.allow_free_text ?? true,
      },
    };
  }

  // ─── emit_worksheet handling ────────────────────────────────────────
  private async handleEmitWorksheet(
    state: ActivityStateType,
    call: { id?: string; name: string; args?: unknown },
    anchorIdx: number,
  ): Promise<{
    emission: ActivityWorksheetEmission;
    manifest: ActivityManifestItem;
    preview: string;
    toolMessage: string;
    normalizedArgs: Record<string, unknown>;
  }> {
    const parsed = EmitWorksheetArgsSchema.safeParse(call.args);
    if (!parsed.success) {
      throw new Error(
        `emit_worksheet args invalid: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    const args = parsed.data;
    // The persistence schema (`ActivityWorksheetEmission` in shared)
    // requires UUIDs for activity_id / lesson_id. The LLM is asked to
    // provide a UUID but we never trust user-controlled identifiers
    // unconditionally — generate one server-side if the model didn't
    // supply a valid UUID, and null out non-UUID lesson ids so the FE
    // schema parser doesn't reject the emission.
    const isUuid = (s: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
    const activityId =
      args.activity_id && isUuid(args.activity_id) ? args.activity_id : uuidv4();
    const lessonId =
      args.lesson_id && args.lesson_id.length > 0 && isUuid(args.lesson_id)
        ? args.lesson_id
        : null;
    const worksheet = this.coerceWorksheet(args);

    const insert = await this.supa.client.from("activities").upsert(
      {
        id: activityId,
        thread_id: state.thread_id,
        lesson_id: lessonId,
        kind: "worksheet",
        prompt: this.latestHumanText(state.messages) || worksheet.title,
        lesson_title: args.lesson_title,
        content: worksheet,
      },
      { onConflict: "id" },
    );
    if (insert.error) {
      throw new Error(
        `failed to commit activity row: ${insert.error.message}`,
      );
    }

    const emission: ActivityWorksheetEmission = {
      activity_id: activityId,
      lesson_id: lessonId,
      lesson_title: args.lesson_title,
      anchor_msg_index: anchorIdx,
      worksheet,
    };
    const manifest: ActivityManifestItem = {
      activity_id: activityId,
      prompt:
        this.latestHumanText(state.messages) || worksheet.title || args.lesson_title,
      lesson_title: args.lesson_title,
      status: "ready",
      error: null,
    };
    const preview = `worksheet "${worksheet.title}" (${worksheet.mcqs.length} MCQ, ${worksheet.short_answers.length} SA)`;
    const normalizedArgs: Record<string, unknown> = {
      activity_id: activityId,
      lesson_id: lessonId,
      lesson_title: args.lesson_title,
      worksheet,
    };
    return {
      emission,
      manifest,
      preview,
      toolMessage: `worksheet emitted (${activityId}). The user can see the rendered card inline; do not paste the worksheet text — just confirm briefly.`,
      normalizedArgs,
    };
  }

  /**
   * Coerce LLM output into the canonical `Worksheet` zod schema. The
   * tool input schema we ship to the LLM is permissive (defaults
   * arrays to empty, allows null worked_example) so we can clean up
   * minor shape drift before the FE consumes it.
   */
  private coerceWorksheet(args: EmitWorksheetArgsType): Worksheet {
    const ws = args.worksheet;
    const mcqs = ws.mcqs.map((m) => {
      const opts = (m.options ?? []).slice(0, 4);
      while (opts.length < 4) opts.push("(distractor)");
      return WorksheetMcq.parse({
        question: String(m.question ?? ""),
        options: opts.map(String),
        correct_index: Math.max(0, Math.min(3, Math.floor(m.correct_index ?? 0))),
        explanation: String(m.explanation ?? ""),
      });
    });
    const short_answers = (ws.short_answers ?? []).map((s) =>
      WorksheetShortAnswer.parse({
        prompt: String(s.prompt ?? ""),
        model_answer: String(s.model_answer ?? ""),
      }),
    );
    const we = ws.worked_example;
    const worked_example: WorksheetWorkedExample = WorksheetWorkedExample.parse({
      prompt: we?.prompt ?? "",
      steps: Array.isArray(we?.steps) ? we!.steps.map(String) : [],
      final_answer: we?.final_answer ?? "",
    });
    return Worksheet.parse({
      title: String(ws.title ?? args.lesson_title ?? "Worksheet"),
      intro: String(ws.intro ?? ""),
      mcqs,
      short_answers,
      worked_example,
    });
  }

  // ─── Tool inventory ─────────────────────────────────────────────────
  /**
   * Build the tool list bound to the LLM for a given mode. The
   * `emit_worksheet` tool is universal (toolless still needs it to
   * deliver a worksheet); MCP tools are only added in tooled mode.
   *
   * We intentionally do NOT bind a runtime `func` for emit_worksheet
   * to anything meaningful — the tools node intercepts the call and
   * runs `handleEmitWorksheet` directly. Tool.invoke is only ever
   * called for MCP tools, which use the routed-through-callTool
   * implementation in `mcp-client.service.ts`.
   */
  async toolsFor(mode: "tooled" | "toolless"): Promise<DynamicStructuredTool[]> {
    const tools: DynamicStructuredTool[] = [
      this.emitWorksheetTool(),
      this.askUserTool(),
    ];
    if (mode === "tooled") {
      const mcpTools = await this.mcp.getToolsRoutedThroughCallTool();
      tools.push(...mcpTools);
    }
    return tools;
  }

  private emitWorksheetTool(): DynamicStructuredTool {
    const tool = new TOOL_CTOR({
      name: "emit_worksheet",
      description:
        "Deliver the final worksheet to the user. Call this ONCE when the worksheet content is ready. The frontend extracts the worksheet JSON from this tool's args and renders it inline in chat — do NOT paste the worksheet text into your reply.",
      schema: EmitWorksheetArgsSchema as ZodTypeAny,
      func: async () => {
        // Unreachable: runTools intercepts emit_worksheet calls before
        // delegating to tool.invoke. Returning a placeholder string is
        // defensive.
        return "(handled internally)";
      },
    });
    return tool as unknown as DynamicStructuredTool;
  }

  private askUserTool(): DynamicStructuredTool {
    const tool = new TOOL_CTOR({
      name: "ask_user",
      description:
        "Halt and ask the user a clarifying question (e.g. which lessons to ground the worksheet in, how many MCQs they want, target difficulty). The frontend renders the question with optional pickable chips + a free-text input. Use this whenever you need the user's input to proceed (don't write the question as plain prose — use this tool so the FE can render an interactive picker). Wait for the user's answer; the next turn will continue the conversation with their reply.",
      schema: AskUserArgsSchema as ZodTypeAny,
      func: async () => {
        // Unreachable: runTools intercepts ask_user calls before delegating
        // to tool.invoke. The actual semantics live in handleAskUser.
        return "(handled internally)";
      },
    });
    return tool as unknown as DynamicStructuredTool;
  }

  // ─── Custom-event helpers ───────────────────────────────────────────
  private async dispatchToolCallTrace(
    trace: ActivityToolCall[],
  ): Promise<void> {
    try {
      await dispatchCustomEvent("activity_tool_call", {
        activity_tool_calls: trace.map((c) => ({ ...c })),
      });
    } catch (err) {
      this.logger.warn(
        `dispatchCustomEvent(activity_tool_call) failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Generic, per-call tool-result dispatch. The legacy
   * `activity_tool_call` envelope ships a snapshot of the entire
   * trace on every call; this one ships a single result payload
   * shaped like the wire `tool_result` slice so non-activity code
   * paths can use the same envelope. Both are appended for now —
   * the snapshot drives the existing chip rendering, the per-call
   * shape drives the future BEENET-style streaming chip UI.
   */
  private async dispatchToolResult(payload: {
    id: string;
    name: string;
    status: "ok" | "error";
    preview: string | null;
    duration_ms: number | null;
    error: string | null;
  }): Promise<void> {
    try {
      await dispatchCustomEvent("tool_result", payload);
    } catch (err) {
      this.logger.warn(
        `dispatchCustomEvent(tool_result) failed: ${(err as Error).message}`,
      );
    }
  }

  // ─── Misc helpers ───────────────────────────────────────────────────
  private latestHumanText(messages: BaseMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      const type = m._getType?.() ?? "";
      if (type === "human" && typeof m.content === "string") {
        return m.content;
      }
    }
    return "";
  }
}

// ─── Tool-call result preview helper ─────────────────────────────────
function previewToolResult(name: string, result: unknown): string {
  if (name === "list_lessons_for_thread") {
    if (Array.isArray(result)) return `${result.length} lessons`;
    if (typeof result === "string") {
      try {
        const parsed = JSON.parse(result);
        if (Array.isArray(parsed)) return `${parsed.length} lessons`;
      } catch {
        /* fall through */
      }
    }
  }
  if (name === "get_lesson") {
    let payload: unknown = result;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        /* fall through */
      }
    }
    if (Array.isArray(payload) && payload.length === 1) {
      payload = payload[0];
    }
    if (payload && typeof payload === "object") {
      const obj = payload as Record<string, unknown>;
      const title = typeof obj.title === "string" ? obj.title : "";
      const len = typeof obj.content === "string" ? obj.content.length : 0;
      return title ? `lesson "${title}" (${len} chars)` : `${len} chars`;
    }
  }
  if (typeof result === "string") return result.slice(0, 80);
  try {
    return JSON.stringify(result).slice(0, 80);
  } catch {
    return "(opaque)";
  }
}

/**
 * Shared schemas between apps/api and apps/web.
 *
 * The agent state is partitioned into named slices. Each slice is streamed
 * to the frontend as a typed Vercel AI SDK data part (kind + value), so the
 * frontend can mount one card per slice and update them in place.
 *
 * Heavy text (scraped pages, lesson markdown) NEVER lives in this shape —
 * it stays in Redis or in Supabase rows accessed via Realtime.
 */
import { z } from "zod";

// ─── Pedagogical contract primitives ────────────────────────────────────────
//
// Defined up front because LessonRow / SyllabusRow / PlannedLesson all
// reference these. The contract is the structured agreement between the
// supervisor (which designs the syllabus) and the writer/critic (which
// authors and reviews each lesson). All fields are OPTIONAL on the wire so
// v1 supervisor JSON, v1 saved checkpoints, and v1 DB rows continue to
// parse; the supervisor v2 prompt fills them, and downstream nodes treat
// missing fields gracefully.
export const AudienceLevel = z.enum([
  "school",
  "undergrad",
  "grad",
  "professional",
]);
export type AudienceLevel = z.infer<typeof AudienceLevel>;

export const Audience = z.object({
  level: AudienceLevel.default("undergrad"),
  prior_knowledge: z.array(z.string()).default([]),
  language: z.string().default("English"),
});
export type Audience = z.infer<typeof Audience>;

export const Scope = z.object({
  duration_hours: z.number().nonnegative().default(0),
  target_outcome: z.string().default(""),
  constraints: z.array(z.string()).default([]),
});
export type Scope = z.infer<typeof Scope>;

export const PedagogyStyle = z.enum([
  "lecture",
  "lab",
  "flipped",
  "self_study",
]);
export type PedagogyStyle = z.infer<typeof PedagogyStyle>;

export const AssessmentMode = z.enum(["formative", "summative", "mixed"]);
export type AssessmentMode = z.infer<typeof AssessmentMode>;

export const Pedagogy = z.object({
  style: PedagogyStyle.default("self_study"),
  assessment: AssessmentMode.default("formative"),
  differentiation: z.boolean().default(false),
});
export type Pedagogy = z.infer<typeof Pedagogy>;

// Bloom's revised taxonomy levels (Anderson & Krathwohl, 2001). Used by the
// supervisor to grade each learning objective and by the critic to verify
// that each chapter contains at least one lesson at "apply" or higher
// (otherwise the chapter is a lecture, not learning).
export const BloomLevel = z.enum([
  "remember",
  "understand",
  "apply",
  "analyze",
  "evaluate",
  "create",
]);
export type BloomLevel = z.infer<typeof BloomLevel>;

export const LearningObjective = z.object({
  text: z.string().min(1),
  bloom_level: BloomLevel.default("understand"),
});
export type LearningObjective = z.infer<typeof LearningObjective>;

// ─── Phase (high-level agent state) ────────────────────────────────────────
export const AgentPhase = z.enum([
  "idle",
  "chatting",
  "researching",
  "planning",
  "writing",
  "asking",
]);
export type AgentPhase = z.infer<typeof AgentPhase>;

// ─── Research plan (search subgraph, Perplexity-style live card) ────────────
export const ResearchStepStatus = z.enum([
  "pending",
  "searching_urls",
  "picking_candidates",
  "scraping",
  "summarizing",
  "done",
  "failed",
]);
export type ResearchStepStatus = z.infer<typeof ResearchStepStatus>;

// Coarse source category the picker tags each URL with. Mirrors the
// `SourceType` enum the search subgraph uses internally — the FE
// renders a `[curriculum]` / `[textbook]` / … chip per picked source
// in the research card. Kept as a string union here (not a Zod enum)
// because: (a) old checkpoints / event-log rows persisted before this
// field was added carry no `source_type` at all, (b) future picker
// versions might add new categories that we don't want to hard-fail
// the wire parse on. The FE falls back to "other" for unknown values.
export const ResearchSourceType = z.enum([
  "curriculum",
  "textbook",
  "paper",
  "course",
  "official_docs",
  "reference",
  "other",
]);
export type ResearchSourceType = z.infer<typeof ResearchSourceType>;

// One picked source the search subgraph kept after the picker stage.
// Emitted alongside `picked_count` so the FE can render favicons +
// 2-line previews (audit §3.1) without holding the full scraped body.
// `snippet` is the Serper-result snippet, NOT the scraped body — keeps
// the wire payload small (≤200 chars per source) while still giving
// the user a glanceable preview of why each URL was picked.
export const ResearchPickedSource = z.object({
  url: z.string(),
  title: z.string(),
  source_type: ResearchSourceType.default("other"),
  snippet: z.string().default(""),
});
export type ResearchPickedSource = z.infer<typeof ResearchPickedSource>;

export const ResearchStep = z.object({
  id: z.string(),
  title: z.string(),
  queries: z.array(z.string()).default([]),
  status: ResearchStepStatus,
  picked_count: z.number().int().nonnegative().default(0),
  scraped_count: z.number().int().nonnegative().default(0),
  // The actual sources the picker kept. `[]` for steps that never
  // reached the pick stage (failed serper, etc.) and for legacy
  // checkpoints that ran before this field existed. Audit §3.1.
  picked: z.array(ResearchPickedSource).default([]),
  // Transient marker set when this step was emitted as a draft from
  // the supervisor's streaming JSON envelope (before the search
  // subgraph has actually run). The FE renders draft rows with a
  // shimmer / pulse to mirror Cursor-style live edit streaming. The
  // eventual `on_chain_end` snapshot overwrites the draft via the
  // chat controller's `emit()` dedupe and the marker disappears.
  __draft: z.boolean().optional(),
});
export type ResearchStep = z.infer<typeof ResearchStep>;

export const ResearchPlan = z.object({
  goal: z.string(),
  steps: z.array(ResearchStep).default([]),
});
export type ResearchPlan = z.infer<typeof ResearchPlan>;

// ─── Todo plan (command subgraph — per-lesson single-shot writer / critic gate) ─
export const TodoStepStatus = z.enum([
  "pending",
  "writing",
  "critiquing",
  "accepted",
  "rejected",
  "failed",
]);
export type TodoStepStatus = z.infer<typeof TodoStepStatus>;

export const TodoStep = z.object({
  id: z.string(), // equals the lesson UUID — same id throughout the pipeline
  chapter_ref: z.string(),
  name: z.string(),
  status: TodoStepStatus,
  attempts: z.number().int().nonnegative().default(0),
  // See `ResearchStep.__draft` — same semantics, set when this step
  // was emitted from the supervisor's streaming envelope before the
  // command subgraph allocated real lesson UUIDs.
  __draft: z.boolean().optional(),
});
export type TodoStep = z.infer<typeof TodoStep>;

export const TodoPlan = z.object({
  steps: z.array(TodoStep).default([]),
  // Mirrors `TodoStep.__draft` at the plan level so the FE can render
  // the whole card with a shimmer until the real plan lands.
  __draft: z.boolean().optional(),
});
export type TodoPlan = z.infer<typeof TodoPlan>;

// ─── Critic issue (severity-aware) ─────────────────────────────────────────
//
// Mirrors the internal critic v2 output shape from
// apps/api/src/graph/command/command.subgraph.ts so the FE can render
// the same severity / category metadata the writer / critic gate reasons
// about. Audit §2.7 + §5.4: we now persist the full structured issue
// set on the lesson row (not just block-severity formatted strings),
// which lets the lesson detail viewer colour-code by severity and
// label by category.
export const CriticIssueSeverity = z.enum(["block", "warn", "nit"]);
export type CriticIssueSeverity = z.infer<typeof CriticIssueSeverity>;

export const CriticIssueCategory = z.enum([
  "lo_alignment",
  "grounding",
  "language",
  "pedagogy",
  "structure",
  "duplication",
  "wording",
  "leakage",
  "other",
]);
export type CriticIssueCategory = z.infer<typeof CriticIssueCategory>;

export const CriticIssue = z.object({
  severity: CriticIssueSeverity,
  category: CriticIssueCategory,
  detail: z.string().min(1),
});
export type CriticIssue = z.infer<typeof CriticIssue>;

// ─── Manifest (committed-row mirror; FileTree fast-renders from this) ───────
export const ManifestItemStatus = z.enum(["pending", "writing", "done", "failed"]);
export type ManifestItemStatus = z.infer<typeof ManifestItemStatus>;

export const ManifestItem = z.object({
  id: z.string(), // lesson UUID
  title: z.string(),
  chapter_title: z.string().optional(),
  status: ManifestItemStatus,
  db_id: z.string().nullable().default(null),
  // Deprecated — the writer/critic gate no longer surfaces revision
  // findings to the FE. Always `false` / `[]` on newly-committed rows;
  // kept on the type for backward-compat with persisted state from
  // pre-zero-trace runs (the FE no longer renders any UI for them).
  review_required: z.boolean().optional().default(false),
  block_issues: z.array(z.string()).optional().default([]),
  critic_issues: z.array(CriticIssue).optional().default([]),
  /**
   * UUIDs of earlier lessons this one explicitly builds on. Mirrors
   * `PlannedLesson.depends_on` and `LessonRow.depends_on`, surfaced on
   * the manifest so the FileTree can render a "depends on …" line
   * under each lesson title without waiting for the snapshot fetch.
   * Empty when the supervisor allocated no deps (the common case).
   */
  depends_on: z.array(z.string()).optional().default([]),
  // See `ResearchStep.__draft` — set on rows emitted from the
  // supervisor's streaming envelope before any DB row exists.
  __draft: z.boolean().optional(),
});
export type ManifestItem = z.infer<typeof ManifestItem>;

// ─── Interrupt (ask_user tool) ──────────────────────────────────────────────
//
// The supervisor produces a structured question with optional suggestions.
// Exactly one suggestion may be flagged `recommended`; the FE shows a tag.
// `allow_free_text` lets the user type their own answer in addition to or
// instead of picking a suggestion. Once answered, `answer` is filled in
// and the entry is moved into `interrupt_history` so the chat keeps a
// permanent Q&A record.
export const AskSuggestion = z.object({
  id: z.string(),
  value: z.string().min(1),
  label: z.string().optional(),
  recommended: z.boolean().optional(),
});
export type AskSuggestion = z.infer<typeof AskSuggestion>;

export const AskAnswer = z.object({
  text: z.string(),
  suggestion_id: z.string().nullable().default(null),
  source: z.enum(["suggestion", "free_text"]),
  answered_at: z.string(),
});
export type AskAnswer = z.infer<typeof AskAnswer>;

// ─── Intake form (kind = "intake_form" interrupts) ────────────────────────────
//
// On the first turn, when the user's message is missing the load-bearing
// pedagogical inputs (audience, time budget, language, target outcome, prior
// knowledge), the supervisor emits an `intake_form` interrupt instead of a
// freeform `ask`. The FE renders a structured form (radios / chips / number
// input) so the user submits a typed JSON payload instead of prose, which:
//   • removes the natural-language parsing brittleness for non-English replies,
//   • lets the API validate (`duration_hours > 0` etc.) before resuming the graph,
//   • surfaces the load-bearing inputs as a deliberate UX moment instead of
//     just-another-question.
//
// `IntakeFormSpec.defaults` lets the supervisor pre-fill any field it inferred
// from the user's first message, so the form is editable not blank.
export const IntakeFormField = z.enum([
  "audience_level",
  "prior_knowledge",
  "duration_hours",
  "language",
  "target_outcome",
]);
export type IntakeFormField = z.infer<typeof IntakeFormField>;

export const IntakeFormSpec = z.object({
  fields: z
    .array(IntakeFormField)
    .min(1)
    .default([
      "audience_level",
      "prior_knowledge",
      "duration_hours",
      "language",
      "target_outcome",
    ]),
  defaults: z
    .object({
      audience_level: AudienceLevel.optional(),
      prior_knowledge: z.array(z.string()).optional(),
      duration_hours: z.number().optional(),
      language: z.string().optional(),
      target_outcome: z.string().optional(),
    })
    .default({}),
});
export type IntakeFormSpec = z.infer<typeof IntakeFormSpec>;

export const IntakeFormAnswer = z.object({
  audience_level: AudienceLevel,
  prior_knowledge: z.array(z.string()).default([]),
  duration_hours: z.number().positive(),
  language: z.string().min(1),
  target_outcome: z.string().default(""),
  answered_at: z.string(),
});
export type IntakeFormAnswer = z.infer<typeof IntakeFormAnswer>;

// ─── Activity intake form (kind = "activity_intake" interrupts) ─────────────
//
// The activity-generator agents (tooled and toolless) emit an
// `activity_intake` interrupt to pin down worksheet generation parameters
// before they actually generate. Same envelope/UX pattern as the syllabus
// `intake_form` (typed JSON resume payload, validated server-side, persists
// in `interrupt_history` for the Q&A trail) but a different field set:
//
//   - lesson_ids:             which lesson(s) to ground in (tooled-only;
//                             toolless intake omits this field).
//   - difficulty:             easy | medium | hard.
//   - mcq_count:              1..8 multiple-choice questions.
//   - short_answer_count:     0..3 short-answer prompts.
//   - include_worked_example: whether to attach a worked example.
//   - language:               output language (defaults to user's chat language).
//
// The tooled agent runs an MCP `list_lessons_for_thread` round before
// emitting the intake so it can populate `lessons_menu` with the actual
// lesson titles the user can pick from. The toolless agent never sets
// `lessons_menu` and the FE renders the form without the lesson picker.
export const ActivityDifficulty = z.enum(["easy", "medium", "hard"]);
export type ActivityDifficulty = z.infer<typeof ActivityDifficulty>;

export const ActivityIntakeFormField = z.enum([
  "lesson_ids",
  "difficulty",
  "mcq_count",
  "short_answer_count",
  "include_worked_example",
  "language",
]);
export type ActivityIntakeFormField = z.infer<typeof ActivityIntakeFormField>;

export const ActivityIntakeLessonOption = z.object({
  id: z.string(),
  title: z.string(),
  chapter_title: z.string().default(""),
});
export type ActivityIntakeLessonOption = z.infer<
  typeof ActivityIntakeLessonOption
>;

export const ActivityIntakeFormSpec = z.object({
  fields: z
    .array(ActivityIntakeFormField)
    .min(1)
    .default([
      "difficulty",
      "mcq_count",
      "short_answer_count",
      "include_worked_example",
      "language",
    ]),
  defaults: z
    .object({
      lesson_ids: z.array(z.string()).optional(),
      difficulty: ActivityDifficulty.optional(),
      mcq_count: z.number().int().optional(),
      short_answer_count: z.number().int().optional(),
      include_worked_example: z.boolean().optional(),
      language: z.string().optional(),
    })
    .default({}),
  // Only populated by the tooled agent after a `list_lessons_for_thread`
  // round-trip so the FE can render a real lesson picker. Toolless intake
  // leaves this empty and hides the lesson_ids field.
  lessons_menu: z.array(ActivityIntakeLessonOption).default([]),
});
export type ActivityIntakeFormSpec = z.infer<typeof ActivityIntakeFormSpec>;

export const ActivityWorksheetEmission = z.object({
  activity_id: z.string().uuid(),
  lesson_id: z.string().uuid().nullable(),
  lesson_title: z.string(),
  anchor_msg_index: z.number().int().nullable().default(null),
  // Worksheet payload. Stored as `z.unknown()` here to avoid a forward
  // reference to the Worksheet schema (defined further down in this
  // file). Consumers should re-validate via `Worksheet.safeParse`
  // before rendering — the wire path is replace-on-write so a stale
  // shape won't bleed into other turns.
  worksheet: z.unknown(),
});
export type ActivityWorksheetEmission = z.infer<
  typeof ActivityWorksheetEmission
>;

export const ActivityIntakeFormAnswer = z.object({
  // Empty array on toolless threads (no lesson grounding); 1..N lesson ids
  // on tooled threads. The agent picks ONE to ground the next worksheet in
  // when the user selected multiple — additional lessons stay queued for
  // follow-up turns.
  lesson_ids: z.array(z.string()).default([]),
  difficulty: ActivityDifficulty.default("medium"),
  mcq_count: z.number().int().min(1).max(8).default(4),
  short_answer_count: z.number().int().min(0).max(3).default(1),
  include_worked_example: z.boolean().default(true),
  language: z.string().min(1).default("English"),
  answered_at: z.string(),
});
export type ActivityIntakeFormAnswer = z.infer<typeof ActivityIntakeFormAnswer>;

// AgentInterrupt is a tagged union of three kinds:
//   - "ask"             : freeform question with suggestions (supervisor /
//                          activity-generator clarification turns).
//   - "intake_form"     : structured pre-research intake on the syllabus side.
//   - "activity_intake" : structured pre-generation intake on the activity side.
// Kept as a single object with optional fields rather than a Zod
// discriminated union so the FE / DB / replay code that already destructures
// `.id` / `.question` / `.answer` keeps working unchanged. Old (kind-less)
// rows in the checkpointer / event log default to `kind: "ask"`.
export const AgentInterrupt = z.object({
  id: z.string(),
  kind: z.enum(["ask", "intake_form", "activity_intake"]).default("ask"),
  question: z.string(),
  suggestions: z.array(AskSuggestion).default([]),
  allow_free_text: z.boolean().default(true),
  answer: AskAnswer.nullable().default(null),
  intake: IntakeFormSpec.nullable().default(null),
  intake_answer: IntakeFormAnswer.nullable().default(null),
  activity_intake: ActivityIntakeFormSpec.nullable().default(null),
  activity_intake_answer: ActivityIntakeFormAnswer.nullable().default(null),
  // See `ResearchStep.__draft` — set when the interrupt was emitted
  // mid-stream from the supervisor's JSON envelope. Real interrupts
  // (the ones that actually pause the graph for user input) never
  // carry this marker; the on_chain_end snapshot drops it.
  __draft: z.boolean().optional(),
});
export type AgentInterrupt = z.infer<typeof AgentInterrupt>;

// ─── Run lifecycle (mirror of the latest agent_runs row) ────────────────────
//
// Surfaces server-driven lifecycle to the FE so the chat UI can:
//  - Distinguish "agent is still working server-side" from "this tab's SSE
//    stream is idle" (the user reloaded mid-run, or another tab is driving),
//  - Show a clear failed/interrupted state when a run dies after the tab
//    closed — today the FE only sees `phase` from the LangGraph checkpointer,
//    which holds whatever value was last set and is never reverted on crash.
//  - Gate the input box on actual run state, not just the local SSE flag.
export const RunStatus = z.enum([
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const RunSnapshot = z.object({
  id: z.string().uuid(),
  thread_id: z.string().uuid(),
  status: RunStatus,
  user_message: z.string().nullable().default(null),
  started_at: z.string().nullable().default(null),
  finished_at: z.string().nullable().default(null),
  last_heartbeat: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  created_at: z.string(),
});
export type RunSnapshot = z.infer<typeof RunSnapshot>;

// ─── Wire format: typed Vercel AI SDK data parts ────────────────────────────
export const DataPartKind = z.enum([
  "phase",
  "research_plan",
  "todo_plan",
  "manifest",
  "activity_manifest",
  "activity_tool_calls",
  "activity_progress",
  "activity_worksheets",
  "interrupt",
  "interrupt_history",
  "run",
  "research_anchor_msg_index",
  "todo_anchor_msg_index",
  // Live LLM token / tool-call streaming foundation. These are
  // delta-style kinds: each event is unique (not a snapshot), and
  // they're appended to the Redis stream + Postgres `agent_events`
  // log so a follower tab / new-device join can replay the live
  // typing of a still-running turn — closing the "I see the AskCard
  // but the prose preceding it is missing" gap.
  //
  //  - `assistant_text_delta`: one token (or batch of characters) of
  //    a streaming assistant turn, keyed by `blockId` so multi-bubble
  //    runs don't merge into one block on followers. The active POST
  //    tab still consumes text via the v5 `text-delta` frame; this
  //    slice is what followers + replay use.
  //
  //  - `tool_call_start` / `tool_call_arg_delta` / `tool_call_end`:
  //    the OpenAI tool-call streaming envelope, mirrored as typed
  //    slices so the FE can render args growing live. `tool_call_end`
  //    carries the parsed args object (LangChain has reconstructed
  //    them by then), not raw JSON — that's what every consumer
  //    actually wants.
  //
  //  - `tool_result`: emitted by the tools node (or any LLM-driven
  //    code path that runs tools) once a call completes. Carries
  //    `status: "ok" | "error"`, an optional `preview`, and a
  //    `duration_ms`. Decoupled from the snapshot-style
  //    `activity_tool_calls` slice so non-activity code paths can
  //    use the same wire shape.
  "assistant_text_delta",
  "tool_call_start",
  "tool_call_arg_delta",
  "tool_call_end",
  "tool_result",
  // Deep-agent canvas slices (subagent panel + VFS visualizer).
  //
  //  - `vfs_update`: delta-style update to the deepagents virtual
  //    filesystem (`Record<path, content | null>`). The FE merges
  //    these into a local snapshot to render the file tree. `null`
  //    content means the file was deleted. Emitted whenever a
  //    `write_file` / `edit_file` tool runs in the supervisor or any
  //    subagent. Persisted in the event log so replay reconstructs
  //    the live VFS history; `/state` hydration uses
  //    `agent.getState()` directly for the durable snapshot.
  //
  //  - `subagent_run`: snapshot-style entry per `task()` dispatch.
  //    Carries the subagent name, the supervisor's task description,
  //    status (running/ok/error), the final output once finished, and
  //    duration. The FE replaces by `call_id` so a single task() goes
  //    through `running` → `ok|error` cleanly. Lets the canvas show
  //    "what subagents have run" without needing the full per-token
  //    transcript.
  //
  //  - `subagent_text_delta`: live per-token thinking from a subagent
  //    LLM call. Routed by `call_id` to the matching subagent row
  //    in the canvas — NEVER fed to the supervisor's chat bubble
  //    (the chat must remain supervisor-only). Transient: persisted
  //    to Redis Streams for in-flight resume but NOT to the durable
  //    Postgres event log, because the canvas hydrates each row's
  //    final answer from the `subagent_run` snapshot on reload —
  //    persisting per-token deltas would be pure write amplification.
  //
  //  - `subagent_tool_call`: snapshot-style entry per nested tool
  //    call inside a running subagent (e.g. the writer's
  //    `create_lesson`, the researcher's `web_search`). Linked to a
  //    parent `subagent_run` via `call_id`, keyed by
  //    `tool_call_id` so the FE replaces in place as the call walks
  //    `running` → `ok|error`. Persisted to the durable event log so
  //    reload replays the full nested tool-call trace inside each
  //    canvas SubagentRunRow.
  "vfs_update",
  "subagent_run",
  "subagent_text_delta",
  "subagent_tool_call",
  // Per-LLM-call token / cost telemetry. One event per chat-model
  // invocation (supervisor turn, subagent step, classification call,
  // …) carrying `input_tokens` / `output_tokens` / `total_tokens` and
  // identifying metadata (`node`, `tier`, `model`, `run_id`). The
  // event is durably persisted to `agent_events` so the eval CLI in
  // `apps/eval/` can compute per-agent token + cost numbers from the
  // event log instead of having to re-run agents to measure them.
  // The FE doesn't render this slice today — it lands in the event
  // log only.
  "llm_usage",
]);
export type DataPartKind = z.infer<typeof DataPartKind>;

// ─── Streaming envelope schemas ─────────────────────────────────────────────
//
// Schemas for the delta-style kinds above. They're not snapshots, so
// they don't fit the "replace the latest value per kind" model the
// older slices use — the FE accumulates them per `blockId` (text)
// or per tool-call `id` (tool calls).

export const AssistantTextDelta = z.object({
  blockId: z.string(),
  // LangGraph node name that produced this token. Followers can use
  // it to route deltas to the right "live" bubble when a single turn
  // walks through multiple chat-text nodes.
  node: z.string(),
  delta: z.string(),
});
export type AssistantTextDelta = z.infer<typeof AssistantTextDelta>;

export const ToolCallStart = z.object({
  // OpenAI tool-call id — globally unique within a run.
  id: z.string(),
  name: z.string(),
  // LangGraph node that issued this call (e.g. `chat`, `decide`).
  node: z.string(),
  // 0-based index of this call within the AIMessage's `tool_calls`
  // array. ChatOpenAI emits `tool_call_chunks` carrying `index` so
  // we can multiplex multiple parallel calls correctly.
  call_index: z.number().int().nonnegative(),
});
export type ToolCallStart = z.infer<typeof ToolCallStart>;

export const ToolCallArgDelta = z.object({
  id: z.string(),
  // Raw argument JSON delta as emitted by ChatOpenAI's
  // `tool_call_chunks`. Concatenating all deltas for a given `id`
  // reproduces the eventual `tool_call_end.args` JSON. The FE renders
  // these progressively (e.g. "args: {\"lesson_id\": \"abc-123\"}…").
  delta: z.string(),
});
export type ToolCallArgDelta = z.infer<typeof ToolCallArgDelta>;

export const ToolCallEnd = z.object({
  id: z.string(),
  // Parsed (final) args object. ChatOpenAI's `AIMessageChunk.concat`
  // reconstructs the JSON server-side; this is the canonical view
  // every consumer wants.
  args: z.record(z.unknown()),
});
export type ToolCallEnd = z.infer<typeof ToolCallEnd>;

export const ToolResult = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["ok", "error"]),
  // Short, human-readable summary of the result (≤80 chars). The FE
  // shows this on the chip without having to parse JSON.
  preview: z.string().nullable().default(null),
  duration_ms: z.number().int().nonnegative().nullable().default(null),
  error: z.string().nullable().default(null),
});
export type ToolResult = z.infer<typeof ToolResult>;

/**
 * Delta payload for the deepagents virtual filesystem. Keys are
 * absolute file paths inside the VFS (e.g. `/pedagogy_plan.md`,
 * `/lessons/abc-123.md`). Values are the full new contents — when
 * `null`, the file was deleted on this update. The FE merges this
 * into a local `Record<path, string>` snapshot.
 *
 * Optional `subagent_call_id` tags the originating subagent so the
 * canvas can attribute file changes to the agent that wrote them.
 */
export const VfsUpdate = z.object({
  files: z.record(z.string(), z.string().nullable()),
  subagent_call_id: z.string().nullable().default(null),
});
export type VfsUpdate = z.infer<typeof VfsUpdate>;

/**
 * Live per-token text from one subagent's LLM call.
 *
 * Routed by `call_id` to the matching subagent row in the canvas —
 * the FE accumulates these deltas in a per-call buffer and renders
 * a "thinking…" preview while the run is in flight. Cleared from
 * the buffer on `subagent_run.status === "ok"|"error"` so the
 * final synthesised output (carried on the snapshot) takes over.
 *
 * `block_id` exists for parity with `AssistantTextDelta` — multiple
 * sequential text blocks can show up inside a single subagent run
 * (e.g. a thought block then a tool-call rationale block), and
 * each gets its own block id. The FE is free to treat them as one
 * concatenated stream until we have a real reason to separate them.
 */
export const SubagentTextDelta = z.object({
  call_id: z.string(),
  block_id: z.string(),
  delta: z.string(),
});
export type SubagentTextDelta = z.infer<typeof SubagentTextDelta>;

/**
 * One subagent task() invocation, surfaced to the canvas.
 *
 * Replace-by-`call_id` semantics: as the run progresses, the same
 * `call_id` is re-emitted with status transitioning `running` →
 * `ok|error`. The FE keeps the latest snapshot per `call_id` and
 * orders by `started_at` for the activity panel.
 *
 * `output` is the subagent's final synthesised answer (returned to
 * the supervisor) — full text, not the 80-char chip preview the
 * `task` tool's `tool_result` carries.
 */
export const SubagentRun = z.object({
  // Same as the supervisor's tool_call_id for this `task` call —
  // globally unique within the run.
  call_id: z.string(),
  // deepagents `subagent_type` literal (e.g. `pedagogy_planner`).
  name: z.string(),
  // The supervisor's `task(description=…)` argument verbatim. The FE
  // renders this as the run's headline so users see "what was
  // delegated".
  description: z.string(),
  status: z.enum(["running", "ok", "error"]),
  // ISO-8601 timestamp the supervisor dispatched the task.
  started_at: z.string(),
  // ISO-8601 timestamp the subagent's task tool returned. Null while
  // still running.
  ended_at: z.string().nullable().default(null),
  // Final output string returned to the supervisor. Null while
  // running. Non-null on terminal status — empty string is a valid
  // output (some subagents reply with the artifact tag only).
  output: z.string().nullable().default(null),
  // Wall-clock duration in milliseconds. Null while running.
  duration_ms: z.number().int().nonnegative().nullable().default(null),
  // Optional error detail when status === "error".
  error: z.string().nullable().default(null),
});
export type SubagentRun = z.infer<typeof SubagentRun>;

/**
 * One nested tool call inside a running subagent (e.g. the writer
 * subagent calling `create_lesson`, or the researcher calling
 * `web_search`). Surfaced inside the canvas's matching SubagentRunRow
 * — never spliced into the supervisor's chat bubble.
 *
 * Replace-by-`tool_call_id` semantics: as the subagent's tool call
 * progresses, the same `tool_call_id` is re-emitted with status
 * transitioning `running` → `ok|error`. The FE keeps the latest
 * snapshot per id and groups by `call_id` (the parent task() id) for
 * the row's render order.
 *
 * `output` is a stringified preview of the tool's result (truncated
 * server-side to keep snapshots compact); the durable artifact (e.g.
 * the syllabus row in Supabase) is still authoritative.
 */
export const SubagentToolCall = z.object({
  // Parent `task()` callId — same value as the matching SubagentRun.
  // Lets the canvas group nested tool calls under their subagent row.
  call_id: z.string(),
  // OpenAI tool-call id of the nested call itself. Globally unique
  // within the run; the snapshot key.
  tool_call_id: z.string(),
  // Tool name, e.g. `create_lesson`, `web_search`, `web_fetch`,
  // `write_file`. Drives the chip icon + label.
  name: z.string(),
  // Tool args as the runner saw them. `{}` if the tool was called
  // with no arguments (some tools take only a side-effecting context).
  args: z.record(z.unknown()),
  status: z.enum(["running", "ok", "error"]),
  // ISO-8601 timestamps (matches SubagentRun).
  started_at: z.string(),
  ended_at: z.string().nullable().default(null),
  duration_ms: z.number().int().nonnegative().nullable().default(null),
  // Stringified preview of the tool result, truncated to a few KB so
  // the canvas snapshot stays small. Null while running. Empty string
  // is a valid output (some tools return only side effects).
  output: z.string().nullable().default(null),
  // Optional error detail when status === "error".
  error: z.string().nullable().default(null),
});
export type SubagentToolCall = z.infer<typeof SubagentToolCall>;

/**
 * Per-LLM-call token usage event. Emitted exactly once per chat-model
 * invocation (one supervisor LLM step, one subagent LLM step, one
 * classification call, …). The eval CLI in `apps/eval/` aggregates
 * these rows out of `agent_events` to compute per-agent tokens + cost.
 *
 * `node` is the LangGraph node name (e.g. `supervisor`, `chat`,
 * `decide`, `command:writer`, `deepagent_supervisor`,
 * `deepagent_subagent:writer`) — same shape used by the existing
 * `assistant_text_delta` slice's `node` field. `tier` is the
 * `LlmConfigService` tier (`supervisor`/`writer`/`critic`/`utility`)
 * so we can attribute costs per tier even when the same model id is
 * shared across tiers. `model` is the wire model id (e.g.
 * `gpt-4o-mini`, `hf:zai-org/GLM-4.6`) for cross-checking against
 * provider invoices. `run_id` is the LangChain runId of the LLM
 * invocation — distinct per call, so two identical-payload events
 * never deduplicate against each other in the snapshot emitter.
 *
 * Token fields mirror LangChain's `UsageMetadata` shape verbatim.
 * Providers that don't return usage land here as null on all three
 * fields — the eval CLI treats those rows as "unknown cost" and
 * surfaces a per-agent missing-data percentage.
 */
export const LlmUsage = z.object({
  run_id: z.string(),
  node: z.string(),
  tier: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  input_tokens: z.number().int().nonnegative().nullable().default(null),
  output_tokens: z.number().int().nonnegative().nullable().default(null),
  total_tokens: z.number().int().nonnegative().nullable().default(null),
});
export type LlmUsage = z.infer<typeof LlmUsage>;

/**
 * One snapshot per slice. The frontend keeps the latest snapshot keyed by
 * `kind` and re-renders when a new one arrives. We never send partial
 * patches — full snapshots make reasoning trivial and surprise-free.
 *
 * `*_anchor_msg_index` carries the index in `state.messages` of the
 * AIMessage that triggered the corresponding card (Research / Todo).
 * The FE places the card directly under that message in the transcript
 * — same source of truth in live streams and in `/state` hydration, so
 * reload puts the cards back where they belong instead of at the tail.
 */
export const DataPart = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("phase"), value: AgentPhase }),
  z.object({ kind: z.literal("research_plan"), value: ResearchPlan.nullable() }),
  z.object({ kind: z.literal("todo_plan"), value: TodoPlan.nullable() }),
  z.object({ kind: z.literal("manifest"), value: z.array(ManifestItem) }),
  // Activity-generator manifest. Lazily declared as `z.array(...)` here
  // because the schema is defined at the bottom of this file; using
  // `ActivityManifestItem` directly would forward-reference. The
  // discriminated union still narrows correctly on the literal.
  z.object({
    kind: z.literal("activity_manifest"),
    value: z.array(
      z.object({
        activity_id: z.string().uuid(),
        prompt: z.string(),
        lesson_title: z.string(),
        status: z.enum(["drafting", "ready", "failed"]),
        error: z.string().nullable().default(null),
      }),
    ),
  }),
  // Activity-tooled MCP tool-call timeline. Each entry is one tool round-trip
  // (list_lessons_for_thread / get_lesson). Streamed live from inside the
  // generate node via dispatchCustomEvent so the FE can render a per-call
  // "calling … done" timeline as the LLM works through the lesson menu.
  z.object({
    kind: z.literal("activity_tool_calls"),
    value: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        args: z.record(z.unknown()),
        status: z.enum(["calling", "complete", "error"]),
        result_preview: z.string().nullable().default(null),
        error: z.string().nullable().default(null),
        started_at: z.string(),
        ended_at: z.string().nullable().default(null),
        // Index into the run's `state.messages` of the AIMessage that
        // issued this tool call — the FE uses it to render each chip
        // inline under that turn (BEENET-style chronology). Null for
        // legacy entries persisted before this field existed; the FE
        // falls back to a tail render so chips are never dropped.
        anchor_msg_index: z.number().int().nullable().default(null),
      }),
    ),
  }),
  // Activity-generator live progress while the structured-output JSON
  // pass is streaming. The agent service streams tokens from the
  // writer LLM, walks the partial buffer to count complete
  // `mcqs[i]` / `short_answers[i]` entries (and whether the
  // worked_example final_answer has landed), and dispatches this
  // patch on every change. Transient — null when no draft is
  // actively streaming. Doesn't survive reload (the worksheet
  // itself is the source of truth once `ready`).
  z.object({
    kind: z.literal("activity_progress"),
    value: z
      .object({
        activity_id: z.string().uuid(),
        mcqs_done: z.number().int().nonnegative(),
        mcqs_total: z.number().int().nonnegative(),
        short_answers_done: z.number().int().nonnegative(),
        short_answers_total: z.number().int().nonnegative(),
        worked_example_done: z.boolean(),
        worked_example_expected: z.boolean(),
      })
      .nullable(),
  }),
  // Activity-generator worksheet emissions. Each entry is one
  // `emit_worksheet` tool call the agent has produced in this thread.
  // Replace-on-write (full array each turn) so the FE always renders
  // from the source-of-truth tool args, not from Supabase. The DB row
  // is still upserted server-side as a side effect for cold reload of
  // the right-pane feed and for cross-tab visibility — but the inline
  // chat-pane rendering ALWAYS prefers the tool-args copy here.
  z.object({
    kind: z.literal("activity_worksheets"),
    value: z.array(
      // Forward-declare via z.lazy-ish inline shape because Worksheet
      // is defined further down in this file. The Worksheet content
      // is a recursive structure; passthrough-typed here so the FE
      // can render it via `Worksheet.parse()` after the wire decode.
      z.object({
        activity_id: z.string().uuid(),
        lesson_id: z.string().uuid().nullable(),
        lesson_title: z.string(),
        anchor_msg_index: z.number().int().nullable().default(null),
        // Worksheet shape — kept as `z.unknown()` here to avoid the
        // forward-reference cycle. The FE re-parses it via
        // Worksheet.safeParse before rendering.
        worksheet: z.unknown(),
      }),
    ),
  }),
  z.object({ kind: z.literal("interrupt"), value: AgentInterrupt.nullable() }),
  z.object({
    kind: z.literal("interrupt_history"),
    value: z.array(AgentInterrupt),
  }),
  z.object({ kind: z.literal("run"), value: RunSnapshot.nullable() }),
  z.object({
    kind: z.literal("research_anchor_msg_index"),
    value: z.number().int().nullable(),
  }),
  z.object({
    kind: z.literal("todo_anchor_msg_index"),
    value: z.number().int().nullable(),
  }),
  // Streaming foundation — see DataPartKind comments above.
  z.object({ kind: z.literal("assistant_text_delta"), value: AssistantTextDelta }),
  z.object({ kind: z.literal("tool_call_start"), value: ToolCallStart }),
  z.object({ kind: z.literal("tool_call_arg_delta"), value: ToolCallArgDelta }),
  z.object({ kind: z.literal("tool_call_end"), value: ToolCallEnd }),
  z.object({ kind: z.literal("tool_result"), value: ToolResult }),
  z.object({ kind: z.literal("vfs_update"), value: VfsUpdate }),
  z.object({ kind: z.literal("subagent_run"), value: SubagentRun }),
  z.object({
    kind: z.literal("subagent_text_delta"),
    value: SubagentTextDelta,
  }),
  z.object({
    kind: z.literal("subagent_tool_call"),
    value: SubagentToolCall,
  }),
  z.object({ kind: z.literal("llm_usage"), value: LlmUsage }),
]);
export type DataPart = z.infer<typeof DataPart>;

/**
 * Type-only mirror of {@link DataPart}, keyed by `kind`, mapping each
 * to its `value` shape. Used on the web side as the `DATA_TYPES`
 * parameter for `UIMessage<METADATA, DATA_TYPES>` so the v5 `useChat`
 * hook's `onData(dataPart)` callback typechecks the `type` discriminator
 * (`data-${K}`) and the `data` payload against this map.
 *
 * Synthesized from the discriminated union above so the runtime Zod
 * surface and the static type surface never drift — adding a new kind
 * to `DataPartKind` + `DataPart` automatically extends this map.
 *
 * Two transport-only kinds piggy-back on the same wire format:
 *  - `_keepalive`: ~2 KB padding emitted on a 20s timer to keep
 *    HTTP/2 edges (Railway/Cloudflare/Fastly) from killing idle
 *    streams during long supervisor / writer LLM calls. Always
 *    server-marked `transient: true` so it never lands in
 *    `messages[].parts`.
 *  - `_cursor`: Redis stream entry id, emitted on the GET `/stream`
 *    replay path so the FE can persist the cursor and resume from
 *    the right offset on reconnect. Same `transient: true` flag —
 *    the chat pane's `onData` ignores it, the realtime hook routes
 *    it to sessionStorage.
 */
export type MpfeDataPartShapes = {
  [K in DataPartKind]: Extract<DataPart, { kind: K }>["value"];
} & {
  _keepalive: string;
  _cursor: { id: string };
};

// ─── DB row shapes (subset, used by snapshot endpoint + Realtime) ───────────
export const SyllabusRow = z.object({
  id: z.string().uuid(),
  thread_id: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  // Pedagogical contract columns (added in 0005). Stored as JSON in
  // Postgres; the API surfaces them as nested objects so the FE Viewer
  // can render audience / scope / pedagogy chips on the syllabus
  // overview page. Older rows have these as null and the FE falls back.
  //
  // Typed-but-loose: each field is the structured shape the supervisor
  // produces, but `.passthrough()` + `.nullable()` keeps us tolerant of
  // legacy rows that stored partial JSON (e.g. snapshots from before all
  // contract keys were finalized). The FE can read .level / .style /
  // .duration_hours directly without `as any` casts.
  audience: Audience.passthrough().nullable().optional(),
  scope: Scope.passthrough().nullable().optional(),
  pedagogy: Pedagogy.passthrough().nullable().optional(),
});
export type SyllabusRow = z.infer<typeof SyllabusRow>;

export const ChapterRow = z.object({
  id: z.string().uuid(),
  syllabus_id: z.string().uuid(),
  title: z.string(),
  order_index: z.number().int(),
  outcomes: z.array(z.string()).optional().default([]),
  prerequisites: z.array(z.string()).optional().default([]),
});
export type ChapterRow = z.infer<typeof ChapterRow>;

export const LessonRow = z.object({
  id: z.string().uuid(),
  chapter_id: z.string().uuid(),
  title: z.string(),
  content: z.string(),
  order_index: z.number().int(),
  // Pedagogical contract fields, surfaced for the Viewer's lesson header
  // (objectives chips, prerequisites recap, duration badge). Null for
  // pre-v2 rows.
  learning_objectives: z.array(LearningObjective).optional().default([]),
  prerequisites: z.array(z.string()).optional().default([]),
  key_terms: z.array(z.string()).optional().default([]),
  worked_example_seed: z.string().optional().default(""),
  assessment_idea: z.string().optional().default(""),
  duration_min: z.number().int().nonnegative().optional().default(0),
  review_required: z.boolean().optional().default(false),
  block_issues: z.array(z.string()).optional().default([]),
  // Full structured critic output (severity + category + detail) from
  // the final critic pass. Audit §2.7 — the legacy `block_issues` only
  // carried block-severity formatted strings; this exposes warn/nit
  // observations too so the lesson banner can group + colour-code.
  critic_issues: z.array(CriticIssue).optional().default([]),
  // UUIDs of earlier lessons this lesson explicitly builds on. Mirrors
  // `PlannedLesson.depends_on`, surfaced on the row so the FE Viewer
  // can render "Depends on …" chips that link back to the dep lessons.
  // Empty for pre-deps rows. See migration 0012.
  depends_on: z.array(z.string().uuid()).optional().default([]),
});
export type LessonRow = z.infer<typeof LessonRow>;

export const SyllabusSnapshot = z.object({
  thread_id: z.string().uuid(),
  syllabus: SyllabusRow.nullable(),
  chapters: z.array(
    ChapterRow.extend({
      lessons: z.array(LessonRow),
    }),
  ),
});
export type SyllabusSnapshot = z.infer<typeof SyllabusSnapshot>;

// ─── Unity + UnityActivity rows (post-merge entity model) ────────────────────
//
// The migration to "syllabus → unity → activity" (db migrations 0013/0014)
// renamed `chapters` to `unities` and merged `lessons` + `activities` into
// a single Activity row carrying both the markdown `body` (cours) AND the
// `worksheet` jsonb (questions). The legacy ChapterRow / LessonRow schemas
// above are kept verbatim so the existing api/web consumers keep compiling;
// new code (new controllers, new MCP shapes) uses these schemas instead.
//
// NOTE: The legacy `ActivityRow` schema lower in this file represents the
// pre-merge worksheet-only activity card. The post-merge cours+worksheet
// row is exported here as `UnitySchemaActivityRow` to avoid a name collision
// while the legacy worksheet rendering code keeps importing `ActivityRow`.
export const UnitySchemaUnityRow = z.object({
  id: z.string().uuid(),
  syllabus_id: z.string().uuid(),
  title: z.string(),
  order_index: z.number().int(),
  outcomes: z.array(z.string()).optional().default([]),
  prerequisites: z.array(z.string()).optional().default([]),
});
export type UnitySchemaUnityRow = z.infer<typeof UnitySchemaUnityRow>;

export const UnitySchemaActivityRow = z.object({
  id: z.string().uuid(),
  unity_id: z.string().uuid().nullable(),
  thread_id: z.string().uuid().nullable(),
  title: z.string(),
  order_index: z.number().int().optional().default(0),
  // Markdown cours body — the writer subagent fills this in.
  body: z.string().optional().default(""),
  // Worksheet jsonb — the activity_maker subagent fills this in via
  // update_activity_worksheet. May be null until the worksheet has
  // been authored.
  worksheet: z.unknown().nullable().optional(),
  // Pedagogical contract fields (mirrored from LessonRow during merge).
  learning_objectives: z.array(LearningObjective).optional().default([]),
  prerequisites: z.array(z.string()).optional().default([]),
  key_terms: z.array(z.string()).optional().default([]),
  worked_example_seed: z.string().optional().default(""),
  assessment_idea: z.string().optional().default(""),
  duration_min: z.number().int().nonnegative().optional().default(0),
  bloom_level: BloomLevel.nullable().optional(),
  review_required: z.boolean().optional().default(false),
  block_issues: z.array(z.string()).optional().default([]),
  critic_issues: z.array(CriticIssue).optional().default([]),
  depends_on: z.array(z.string().uuid()).optional().default([]),
});
export type UnitySchemaActivityRow = z.infer<typeof UnitySchemaActivityRow>;

export const UnitySnapshot = z.object({
  thread_id: z.string().uuid().nullable(),
  syllabus: SyllabusRow.nullable(),
  unities: z.array(
    UnitySchemaUnityRow.extend({
      activities: z.array(UnitySchemaActivityRow),
    }),
  ),
});
export type UnitySnapshot = z.infer<typeof UnitySnapshot>;

// ─── Threads list (for the /threads index page) ─────────────────────────────
//
// `last_run_status` is the status of the most recent agent_runs row for the
// thread, or null if no run has ever been started. `interrupted` is a UI-only
// rollup: an `agent_runs.status='paused'` row maps to it (the supervisor's
// `ask` action pauses the graph). `idle` (UI-only) is mapped from the absence
// of any agent_runs row at all.
export const ThreadListEntryStatus = z.enum([
  "idle",
  "running",
  "interrupted",
  "completed",
  "failed",
]);
export type ThreadListEntryStatus = z.infer<typeof ThreadListEntryStatus>;

export const ThreadListEntry = z.object({
  id: z.string().uuid(),
  created_at: z.string(),
  updated_at: z.string(),
  title: z.string().nullable(),
  last_user_message: z.string().nullable(),
  status: ThreadListEntryStatus,
  last_run_at: z.string().nullable(),
  last_run_error: z.string().nullable(),
  // Which agent this thread is bound to (added in 0007). Older clients
  // ignore the field; newer clients group / badge by it. Defaults to
  // "syllabus-generator" via the column default for rows created
  // before 0007. Inlined as an enum here (rather than referencing
  // `AgentKind`) because that schema is declared later in this file —
  // the values are kept in sync by code review.
  agent: z
    .enum([
      "syllabus-generator",
      "activity-generator-tooled",
      "activity-generator-toolless",
      "deepagent",
    ])
    .default("syllabus-generator"),
  // Only set on activity-generator-tooled threads.
  bound_syllabus_thread_id: z.string().uuid().nullable().default(null),
});
export type ThreadListEntry = z.infer<typeof ThreadListEntry>;

// ─── Threads list pagination ─────────────────────────────────────────────
//
// The /api/threads endpoint supports cursor-based pagination + per-agent +
// status + freetext filters so the FE can render large thread collections
// (100s of syllabus builds in a teacher's history) without a single heavy
// fetch. Counts are returned per-agent-kind so the UI can show badges
// even when only one kind is currently loaded.
//
// Cursor semantics: opaque base64 of `{updated_at, id}`. Monotonically
// decreasing by updated_at DESC, with `id` as the tiebreaker.

export const ThreadListCounts = z.object({
  "syllabus-generator": z.number().int().nonnegative(),
  "activity-generator-tooled": z.number().int().nonnegative(),
  "activity-generator-toolless": z.number().int().nonnegative(),
  "deepagent": z.number().int().nonnegative(),
});
export type ThreadListCounts = z.infer<typeof ThreadListCounts>;

export const ThreadListResponse = z.object({
  items: z.array(ThreadListEntry),
  next_cursor: z.string().nullable(),
  counts: ThreadListCounts,
});
export type ThreadListResponse = z.infer<typeof ThreadListResponse>;

// ─── Supervisor → Command plan (pre-allocated UUIDs for idempotency) ────────
export const PlannedLesson = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  brief: z.string().default(""),
  // ── pedagogical contract fields (optional for v1 backwards-compat) ────────
  learning_objectives: z.array(LearningObjective).optional().default([]),
  prerequisites: z.array(z.string()).optional().default([]),
  key_terms: z.array(z.string()).optional().default([]),
  worked_example_seed: z.string().optional().default(""),
  assessment_idea: z.string().optional().default(""),
  duration_min: z.number().int().nonnegative().optional().default(0),
  // Structured lesson-to-lesson dependencies. Each entry is the UUID of
  // an EARLIER lesson in the syllabus whose accepted body this lesson
  // builds on. Distinct from the free-text `prerequisites` array, which
  // remains for human-readable display in the lesson body. The supervisor
  // emits dependencies as 1-indexed (chapter, lesson) refs in the
  // decision payload; `buildPlan` resolves them to UUIDs once chapter /
  // lesson IDs are allocated. The writer receives the prereq lesson
  // bodies as additional context so cross-lesson references stay
  // grounded; the critic enforces the same coherence rule. The DAG must
  // be acyclic — refs to the same or later lessons are dropped at
  // resolution time.
  depends_on: z.array(z.string().uuid()).optional().default([]),
});
export type PlannedLesson = z.infer<typeof PlannedLesson>;

export const PlannedChapter = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  order_index: z.number().int().nonnegative(),
  lessons: z.array(PlannedLesson).min(1),
  // Chapter-level outcomes a learner should reach after completing all of
  // the chapter's lessons. Distinct from per-lesson learning objectives.
  outcomes: z.array(z.string()).optional().default([]),
  prerequisites: z.array(z.string()).optional().default([]),
});
export type PlannedChapter = z.infer<typeof PlannedChapter>;

export const SyllabusPlan = z.object({
  syllabus_id: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().default(""),
  chapters: z.array(PlannedChapter).min(1),
  // Pedagogical contract carried alongside the plan so every downstream
  // node has the same view of audience / scope / pedagogy.
  audience: Audience.optional(),
  scope: Scope.optional(),
  pedagogy: Pedagogy.optional(),
});
export type SyllabusPlan = z.infer<typeof SyllabusPlan>;

// ─── Multi-agent thread support (PR #55+) ───────────────────────────────────
//
// Each thread is bound at creation time to exactly one agent. The string
// value is also the route segment under /docs/agents/<slug> and the
// registry key the API uses to resolve the compiled LangGraph for that
// thread. Adding a new agent = appending here + registering its graph
// on the API + adding a /docs/agents/<slug> page on the FE.
//
// Default for legacy threads (no agent column) is "syllabus-generator"
// — see migration 0007.
export const AgentKind = z.enum([
  "syllabus-generator",
  "activity-generator-tooled",
  "activity-generator-toolless",
  // ── Deep Agent (PR #109) ────────────────────────────────────────────
  // Generic deepagents-based supervisor. Currently no subagents — the
  // first iteration just verifies token streaming end-to-end. See
  // packages/deep-agent for the runner and apps/api/src/chat for the
  // controller branch that routes deepagent threads to it.
  "deepagent",
]);
export type AgentKind = z.infer<typeof AgentKind>;

// ─── Worksheet activity (kind="worksheet") ──────────────────────────────────
//
// Schema for the structured payload produced by both activity agents.
// Identical shape between tooled and toolless so the FE renderer is
// shared — the *content* differs (grounded vs ungrounded), not the
// shape. Stored as JSON in `activities.content`.
export const WorksheetMcq = z.object({
  question: z.string().min(1),
  // Kept as exactly 4 to make the renderer's keyboard shortcuts (A/B/C/D)
  // deterministic. The agent prompt asks for 4 distractor-style options.
  options: z.array(z.string().min(1)).length(4),
  correct_index: z.number().int().min(0).max(3),
  // Short rationale shown after the user reveals the answer; ungrounded
  // worksheets often produce hallucinated rationales here, which is the
  // entire point of the toolless-vs-tooled comparison.
  explanation: z.string().default(""),
});
export type WorksheetMcq = z.infer<typeof WorksheetMcq>;

export const WorksheetShortAnswer = z.object({
  prompt: z.string().min(1),
  // The model's reference answer, shown after the learner submits or
  // toggles "show answer". Optional because some short-answer prompts
  // are intentionally open-ended (reflective).
  model_answer: z.string().default(""),
});
export type WorksheetShortAnswer = z.infer<typeof WorksheetShortAnswer>;

export const WorksheetWorkedExample = z.object({
  // Empty string is intentionally allowed so callers can ship a stub
  // worked-example when the user opts out via the intake form. The
  // renderer branches on `steps.length === 0` to suppress the card.
  prompt: z.string(),
  // Step-by-step solution. Each step is a single line; the renderer
  // numbers them. Empty array means "the agent decided not to break
  // it down" and the renderer falls back to showing only `final_answer`.
  steps: z.array(z.string().min(1)).default([]),
  final_answer: z.string().default(""),
});
export type WorksheetWorkedExample = z.infer<typeof WorksheetWorkedExample>;

export const Worksheet = z.object({
  // Title shown at the top of the activity card. Generated by the agent.
  title: z.string().min(1),
  // Optional one-line orientation paragraph.
  intro: z.string().default(""),
  // Bounds are wide here because the activity-intake form lets the user
  // choose how many of each question type to include (1..8 mcqs, 0..3
  // short answers, optional worked example). Tighter bounds are enforced
  // by the agent prompts per turn from the intake values.
  mcqs: z.array(WorksheetMcq).min(1).max(8),
  short_answers: z.array(WorksheetShortAnswer).max(3).default([]),
  // The worked example is opt-in via the intake form. When omitted the
  // worksheet still ships a stub WorksheetWorkedExample with empty steps
  // so existing renderers can branch on `steps.length === 0` without
  // null checks. Made optional so older rows / paths that produce a
  // worked example by default keep deserializing.
  worked_example: WorksheetWorkedExample.default({
    prompt: "",
    steps: [],
    final_answer: "",
  }),
});
export type Worksheet = z.infer<typeof Worksheet>;

// ─── Activity row (one card on a thread) ────────────────────────────────────
//
// Mirror of the `activities` Postgres row after migration 0007.
// `lesson_id` is non-null only for tooled-agent activities; toolless
// activities are not bound to any lesson. `lesson_title` is denormalized
// onto the row so the FE can render a meaningful card label even after
// the source lesson is deleted (which set-null'd the FK).
export const ActivityRow = z.object({
  id: z.string().uuid(),
  thread_id: z.string().uuid(),
  lesson_id: z.string().uuid().nullable(),
  kind: z.literal("worksheet"),
  prompt: z.string(),
  lesson_title: z.string(),
  content: Worksheet,
  created_at: z.string(),
  updated_at: z.string(),
});
export type ActivityRow = z.infer<typeof ActivityRow>;

// ─── Activity manifest (analogue of the lesson manifest) ────────────────────
//
// Streamed via the existing DataPart channel under a new `activity_manifest`
// kind so the FE can show "drafting…", "ready" badges per activity card
// without polling Supabase. Order is creation order; newest last.
export const ActivityManifestItem = z.object({
  activity_id: z.string().uuid(),
  prompt: z.string(),
  lesson_title: z.string(),
  status: z.enum(["drafting", "ready", "failed"]),
  // Surfaced when status === "failed" so the FE can show the error inline.
  error: z.string().nullable().default(null),
});
export type ActivityManifestItem = z.infer<typeof ActivityManifestItem>;

// ─── Activity tool-call timeline ────────────────────────────────────────────
//
// One entry per MCP tool round-trip the activity-tooled agent makes
// (list_lessons_for_thread, get_lesson). The FE renders these inline
// in the activity feed as "calling … done" rows so the user can see the
// grounding work the agent is doing. Streamed live via dispatchCustomEvent
// during the tool-call loop AND committed to the LangGraph checkpoint at
// the end of the turn so reload-mid-flight hydration shows the same trace.
// Live progress emitted by the activity-generator while the writer
// LLM is streaming JSON. See the `activity_progress` discriminator
// in `DataPart` for the wire shape; this re-exports it as a
// top-level Zod schema so the API can reuse the same type when
// dispatching the custom event.
export const ActivityGenerationProgress = z.object({
  activity_id: z.string().uuid(),
  mcqs_done: z.number().int().nonnegative(),
  mcqs_total: z.number().int().nonnegative(),
  short_answers_done: z.number().int().nonnegative(),
  short_answers_total: z.number().int().nonnegative(),
  worked_example_done: z.boolean(),
  worked_example_expected: z.boolean(),
});
export type ActivityGenerationProgress = z.infer<
  typeof ActivityGenerationProgress
>;

// ─── Artifact card (Deep Agent inline output cards) ──────────────────
//
// The Deep Agent supervisor embeds clickable "artifact cards" inside
// its final assistant text whenever a subagent finishes producing a
// committed resource (a syllabus, a worksheet, a single lesson). The
// supervisor writes a self-closing XML-ish tag the FE then parses out
// of the streamed assistant text and replaces with a clickable card
// component:
//
//     I've finished the syllabus.
//     <artifact kind="syllabus" id="abc-123" title="Database systems" />
//
// Bolt.new-style: the chat answer reads as plain prose with an
// embedded "deliverable" the user can click to open. The same shape
// works for syllabuses, lessons inside a syllabus, and worksheets;
// new artifact kinds drop in by extending the `kind` enum and the FE
// click handler.
//
// The schema is intentionally minimal — the FE looks the artifact up
// by id when the user clicks the card, rather than carrying the full
// payload through the chat stream. `title` is optional because the
// supervisor sometimes embeds the tag mid-build before titles are
// finalised; the FE falls back to "(untitled)" when absent.
export const ArtifactCardKind = z.enum([
  "syllabus",
  "worksheet",
  "lesson",
]);
export type ArtifactCardKind = z.infer<typeof ArtifactCardKind>;

export const ArtifactCard = z.object({
  kind: ArtifactCardKind,
  id: z.string().min(1),
  title: z.string().default(""),
});
export type ArtifactCard = z.infer<typeof ArtifactCard>;

export const ActivityToolCall = z.object({
  id: z.string(),
  name: z.string(),
  args: z.record(z.unknown()),
  status: z.enum(["calling", "complete", "error"]),
  result_preview: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  started_at: z.string(),
  ended_at: z.string().nullable().default(null),
  // Index into the run's `state.messages` array of the AIMessage that
  // issued this tool call. The FE uses it to render each tool-call
  // chip inline under the assistant turn that asked for it (rather
  // than aggregating every call in a single rail at the bottom of
  // the conversation). `null` for legacy entries persisted before
  // this field existed — the FE falls back to a tail render for
  // those so chips are never silently dropped.
  anchor_msg_index: z.number().int().nullable().default(null),
});
export type ActivityToolCall = z.infer<typeof ActivityToolCall>;

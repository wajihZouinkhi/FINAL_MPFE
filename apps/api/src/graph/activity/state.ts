import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import type {
  ActivityIntakeFormAnswer,
  ActivityIntakeLessonOption,
  ActivityManifestItem,
  ActivityToolCall,
  ActivityWorksheetEmission,
  AgentInterrupt,
  AgentPhase,
} from "@mpfe/shared";

/**
 * State shape shared by both activity-generator agents (tooled +
 * toolless). Both produce the same wire shape — the only difference is
 * whether the `decide` node has MCP tools available.
 *
 * The activity graph is decision-driven: each `decide` invocation
 * picks one action (intake / ask / tool / emit / reply) and either
 * pauses (intake / ask), loops (tool), or terminates (emit / reply).
 *
 * Heavy text (lesson markdown read from MCP, raw LLM responses) NEVER
 * lives here. The state carries:
 *   - messages              : chat history including the assistant's
 *                              `emit_worksheet` tool-call AIMessage at
 *                              the end of a successful turn.
 *   - phase                 : drives the FE phase chip in the chat header.
 *   - activity_manifest     : one row per worksheet generated in this
 *                              thread. Newest last. The FE feed renders
 *                              them in this order; on reload the
 *                              snapshot endpoint rebuilds it from the
 *                              activities table.
 *   - activity_tool_calls   : tooled-only per-MCP-tool-call timeline,
 *                              REPLACE-on-write (full array each turn).
 *   - thread_id             : copied in from the Postgres row by the API.
 *   - bound_syllabus_thread_id : tooled-only; the source syllabus thread
 *                              whose lessons the agent reads via MCP.
 *   - interrupt_payload     : pending ask / activity_intake while the
 *                              graph is paused on user input. Cleared
 *                              the moment the user resumes.
 *   - interrupt_history     : permanent Q&A trail for reload + replay.
 *   - activity_intake       : structured worksheet-generation parameters
 *                              from the latest answered intake. Persists
 *                              across turns so follow-ups ("make it
 *                              harder", "add 2 more MCQs") can mutate
 *                              just the relevant fields.
 *   - activity_lessons_menu : tooled-only cache of the lesson menu
 *                              fetched via list_lessons_for_thread, so
 *                              the agent doesn't refetch on every turn
 *                              and the intake card can show real titles.
 */
export const ActivityAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  phase: Annotation<AgentPhase>({
    reducer: (_prev, next) => next,
    default: () => "idle" as AgentPhase,
  }),
  activity_manifest: Annotation<ActivityManifestItem[]>({
    reducer: (_prev, next) => next,
    default: () => [] as ActivityManifestItem[],
  }),
  // Tooled-only: per-MCP-tool-call timeline accumulated during a single
  // generate turn. Replace-on-write (the node returns the full array
  // each turn) so the FE always sees a complete trace, not patches.
  activity_tool_calls: Annotation<ActivityToolCall[]>({
    reducer: (_prev, next) => next,
    default: () => [] as ActivityToolCall[],
  }),
  thread_id: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
  bound_syllabus_thread_id: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  // ─── Interactive control surface ─────────────────────────────────
  interrupt_payload: Annotation<AgentInterrupt | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  interrupt_history: Annotation<AgentInterrupt[]>({
    reducer: (_prev, next) => next,
    default: () => [] as AgentInterrupt[],
  }),
  activity_intake: Annotation<ActivityIntakeFormAnswer | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  activity_lessons_menu: Annotation<ActivityIntakeLessonOption[]>({
    reducer: (_prev, next) => next,
    default: () => [] as ActivityIntakeLessonOption[],
  }),
  // The user's actual topic prompt — captured the first time we see a
  // non-intake human message, then preserved across intake submissions
  // and reset_intake round-trips so the writer LLM always knows what
  // the worksheet should be about. Without this, the synthesized
  // "[Activity Intake] …" string is the only thing the LLM sees on the
  // post-submission turn, and intermediate meta-commands like
  // "edit settings" can poison a backward scan of message history.
  activity_topic: Annotation<string>({
    // Sticky: keep the existing value unless the new write supplies a
    // non-empty string. This way a later turn that doesn't touch the
    // topic (e.g. an `ask` interrupt opening) doesn't accidentally
    // wipe it.
    reducer: (prev, next) => (next && next.length > 0 ? next : prev),
    default: () => "",
  }),
  // Append-only history of `emit_worksheet` tool calls. The FE renders
  // worksheets inline in chat from this array (anchor_msg_index ties
  // each emission to the assistant message that produced it). The
  // accumulator reducer means turns that don't emit a worksheet leave
  // the list untouched, while turns that do append exactly one entry.
  activity_worksheets: Annotation<ActivityWorksheetEmission[]>({
    reducer: (prev, next) => next ?? prev,
    default: () => [] as ActivityWorksheetEmission[],
  }),
  // Internal routing flag set by `decide` and read by the conditional
  // edge after it. "tool" loops back into decide; everything else
  // terminates. Cleared on every decide entry so a stale flag from a
  // previous turn can never escape.
  next_route: Annotation<"tool" | "end" | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
});

export type ActivityStateType = typeof ActivityAnnotation.State;

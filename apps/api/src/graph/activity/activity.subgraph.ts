import { END, START, StateGraph } from "@langchain/langgraph";
import { isAIMessage } from "@langchain/core/messages";
import { ActivityAnnotation, ActivityStateType } from "./state";
import { ActivityAgentService } from "./activity-agent.service";

/**
 * Simple ReAct loop shared by both activity-generator agents
 * (`tooled` + `toolless`):
 *
 *     START → chat → (tool_calls?) → tools → chat → … → END
 *
 * The `chat` node runs the LLM with the FULL conversation history and
 * a small set of bound tools (MCP `list_lessons_for_thread` /
 * `get_lesson` for the tooled mode, plus the universal
 * `emit_worksheet` tool used to deliver the final worksheet payload).
 *
 * The `tools` node executes whatever tool calls the model produced and
 * dispatches `activity_tool_call` custom events around each call so
 * the FE can render the tool-call timeline live.
 *
 * The conditional edge after `chat` keeps looping until the model
 * returns an AIMessage with no tool calls (it's done) or there are no
 * messages at all (defensive). `recursionLimit` on the parent run
 * (configured in `GraphService.streamTurn`) caps the maximum loop
 * depth.
 */
export function buildActivityGraph(
  agent: ActivityAgentService,
  mode: "tooled" | "toolless",
) {
  return new StateGraph(ActivityAnnotation)
    .addNode("chat", async (s: ActivityStateType) => agent.runChat(s, mode))
    .addNode("tools", async (s: ActivityStateType) => agent.runTools(s, mode))
    .addEdge(START, "chat")
    .addConditionalEdges("chat", (s: ActivityStateType) => {
      const last = s.messages[s.messages.length - 1];
      const hasToolCalls =
        !!last && isAIMessage(last) && (last.tool_calls?.length ?? 0) > 0;
      return hasToolCalls ? "tools" : END;
    })
    .addConditionalEdges("tools", (s: ActivityStateType) => {
      // If the chat node's tools included an `ask_user`, the tools node
      // raised an `interrupt_payload` and we need to halt here so the
      // FE can render the question card and the user can answer. The
      // next /chat POST resumes the graph (clearing the interrupt) and
      // re-enters `chat` with the user's reply in history.
      if (s.interrupt_payload && !s.interrupt_payload.answer) return END;
      return "chat";
    });
}

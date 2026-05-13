"use client";

/**
 * Friendly card for the deepagents `write_todos` tool — the
 * supervisor and every subagent use it as their scratch checklist.
 *
 * The deepagents middleware schema is:
 *
 *   write_todos({ todos: Array<{ content: string;
 *                                 status: "pending" | "in_progress" | "completed" }> })
 *
 * Without a friendly card this lands in `GenericToolCard` and renders
 * as a JSON dump (`{"todos":[…]}`) — both during the live stream
 * (driver tab `tool_call_*` frames) and after a page reload (the
 * `supervisor_tool_calls` walked from the LangGraph checkpoint —
 * see chat.controller.ts `/state` and runner.ts
 * `getSupervisorToolCalls`). This card mirrors the legacy
 * syllabus-generator `<TodoCard/>` visual vocabulary (per-step icon
 * + status pill) so a deepagent reload looks like the live state, not
 * a debug log.
 *
 * Used at both densities: chat pane (chip) for the supervisor's
 * checklist + canvas SubagentRunRow (row, expanded) for a subagent's
 * own scratch list.
 */

import {
  CheckCircle2,
  Circle,
  ListTodo,
  Loader2,
} from "lucide-react";
import { ToolCardShell, type ToolCardDensity } from "./shell";
import { getArgs, type NormalizedToolCall } from "./normalize";

type TodoStatus = "pending" | "in_progress" | "completed";

interface Todo {
  content: string;
  status: TodoStatus;
}

export function WriteTodosCard({
  call,
  density,
  expanded,
}: {
  call: NormalizedToolCall;
  density: ToolCardDensity;
  expanded?: boolean;
}) {
  const todos = parseTodos(getArgs(call));
  const total = todos.length;
  const done = todos.filter((t) => t.status === "completed").length;
  const inProgress = todos.find((t) => t.status === "in_progress");
  // Headline: prefer the in-flight item ("Working on …") so the user
  // sees the current focus at a glance. Falls back to a count summary
  // when nothing is in flight (everything pending or everything done).
  const headline = inProgress
    ? truncate(inProgress.content, 64)
    : total === 0
      ? "Updated working plan"
      : done === total
        ? "All steps completed"
        : `${total} step${total === 1 ? "" : "s"} planned`;
  const subline =
    total > 0 ? `${done}/${total} completed` : null;
  // Render the full checklist via the shell's `body` slot. At chip
  // density the list is always visible (the chat pane is where the
  // user expects to see the planning surface live); at row density
  // the shell gates `body` behind the parent SubagentRunRow's
  // `expanded` flag so a collapsed nested checklist stays compact.
  const list = total > 0 ? <TodoList todos={todos} density={density} /> : null;
  return (
    <ToolCardShell
      call={call}
      density={density}
      icon={ListTodo}
      label={headline}
      subline={subline}
      expanded={expanded}
      body={list}
    />
  );
}

function TodoList({
  todos,
  density,
}: {
  todos: Todo[];
  density: ToolCardDensity;
}) {
  return (
    <ul className={density === "chip" ? "mt-1.5 space-y-1" : "space-y-1"}>
      {todos.map((t, i) => (
        <li
          key={i}
          className="flex items-start gap-1.5 rounded border border-[var(--border)]/70 bg-[var(--background)]/60 px-2 py-1 text-[11.5px] leading-snug"
        >
          <TodoStatusIcon status={t.status} />
          <span
            className={
              "min-w-0 flex-1 break-words text-[var(--foreground)]/90 " +
              (t.status === "completed"
                ? "line-through text-[var(--muted-foreground)]"
                : "")
            }
          >
            {t.content}
          </span>
        </li>
      ))}
    </ul>
  );
}

function TodoStatusIcon({ status }: { status: TodoStatus }) {
  switch (status) {
    case "completed":
      return (
        <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500 dark:text-emerald-400" />
      );
    case "in_progress":
      return (
        <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-[var(--primary)]" />
      );
    default:
      return (
        <Circle className="mt-0.5 h-3 w-3 shrink-0 text-[var(--muted-foreground)]" />
      );
  }
}

/**
 * Best-effort parse of the `write_todos` arg shape. The runtime guards
 * against a malformed `todos[]` (mid-stream `args_buffer`, future
 * schema drift, …) by returning an empty list — the card then falls
 * back to its generic headline so we never crash on an unknown shape.
 */
function parseTodos(args: Record<string, unknown> | null): Todo[] {
  if (!args) return [];
  const raw = args.todos;
  if (!Array.isArray(raw)) return [];
  const out: Todo[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const r = t as Record<string, unknown>;
    const content = typeof r.content === "string" ? r.content : null;
    if (!content) continue;
    const status: TodoStatus =
      r.status === "completed" || r.status === "in_progress"
        ? r.status
        : "pending";
    out.push({ content, status });
  }
  return out;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

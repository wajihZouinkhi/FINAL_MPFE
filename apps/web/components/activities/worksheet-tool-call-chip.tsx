"use client";

import { ChevronRight, FileText } from "lucide-react";
import type { AgentKind, Worksheet } from "@mpfe/shared";

/**
 * Compact "tool call" affordance rendered inline in the chat for each
 * `emit_worksheet` tool call. Inspired by Cursor's tool-call chips:
 * a small clickable card that names the tool ("Worksheet"), shows the
 * artifact title, and previews the metadata. Clicking opens the full
 * worksheet in the right-pane workbench.
 *
 * The full worksheet card is intentionally NOT rendered here — that
 * lives in the workbench. Mobile/narrow layouts get a separate inline
 * fallback in chat-pane.tsx (the chip is desktop-only).
 */
export function WorksheetToolCallChip({
  worksheet,
  lessonTitle,
  agent,
  selected,
  onSelect,
}: {
  worksheet: Worksheet;
  lessonTitle: string | null;
  agent: AgentKind;
  selected: boolean;
  onSelect: () => void;
}) {
  const grounded = agent === "activity-generator-tooled";
  const mcqCount = worksheet.mcqs.length;
  const saCount = worksheet.short_answers.length;
  const hasWorkedExample =
    worksheet.worked_example &&
    (worksheet.worked_example.steps.length > 0 ||
      Boolean(worksheet.worked_example.prompt?.trim()));

  const stats: string[] = [];
  if (mcqCount > 0) stats.push(`${mcqCount} MCQ`);
  if (saCount > 0) stats.push(`${saCount} SA`);
  if (hasWorkedExample) stats.push("1 worked");

  return (
    <button
      type="button"
      onClick={onSelect}
      className={
        "group relative flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition " +
        (selected
          ? "border-[var(--primary)] bg-[var(--primary)]/10 ring-1 ring-[var(--primary)]/40"
          : "border-[var(--border)] bg-[var(--card)]/85 backdrop-blur hover:border-[var(--primary)]/60 hover:bg-[var(--card)]")
      }
      aria-pressed={selected}
    >
      <span
        className={
          "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md ring-1 " +
          (grounded
            ? "bg-emerald-400/15 text-emerald-300 ring-emerald-400/30"
            : "bg-amber-400/15 text-amber-300 ring-amber-400/30")
        }
      >
        <FileText className="h-4 w-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <div className="flex items-center gap-1.5 text-[10.5px] font-mono uppercase tracking-wide text-[var(--muted-foreground)]">
          <span>emit_worksheet</span>
          <span
            className={
              "rounded-sm px-1 py-px text-[9.5px] " +
              (grounded
                ? "bg-emerald-400/15 text-emerald-300"
                : "bg-amber-400/15 text-amber-300")
            }
          >
            {grounded ? "MCP-grounded" : "no tools"}
          </span>
        </div>
        <span className="mt-0.5 truncate text-[13px] font-semibold text-[var(--foreground)]">
          {worksheet.title}
        </span>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[var(--muted-foreground)]">
          {lessonTitle ? (
            <span className="truncate">Lesson: {lessonTitle}</span>
          ) : null}
          {stats.length > 0 ? (
            <span className="font-mono">{stats.join(" \u00b7 ")}</span>
          ) : null}
        </div>
      </div>
      <ChevronRight
        className={
          "h-4 w-4 shrink-0 transition " +
          (selected
            ? "text-[var(--primary)]"
            : "text-[var(--muted-foreground)] group-hover:translate-x-0.5 group-hover:text-[var(--foreground)]")
        }
      />
    </button>
  );
}

"use client";

/**
 * Tool-call card router.
 *
 * Both the chat pane (`InlineLiveToolCalls` / unanchored-tail block)
 * and the canvas (`<SubagentRunRow>` nested tool calls) used to dump
 * `JSON.stringify(args)` into a `<pre>` for every tool that wasn't
 * `task` / `web_search`. That made the in-flight UX look like a
 * debug log instead of a workbench.
 *
 * This module routes each known tool name to a friendly per-tool
 * component (read_file → "Read /path", web_search → "Searched: …",
 * create_syllabus → click-to-open, …) and falls back to a generic
 * card for anything else. Both surfaces render through the same
 * `ToolCallCard` component with a `density` prop so the visual
 * vocabulary stays consistent.
 *
 * Usage:
 *
 *   ```tsx
 *   <LiveToolCallChipCard call={liveToolCall} />
 *   <SubagentToolCallRowCard call={subagentToolCall} expanded={open} />
 *   ```
 */

import type { LiveToolCall } from "../../../stores/agent-store";
import type { SubagentToolCall } from "@mpfe/shared";
import {
  normalizeLive,
  normalizeSubagent,
  type NormalizedToolCall,
} from "./normalize";
import {
  ReadFileCard,
  WriteFileCard,
  EditFileCard,
  LsCard,
} from "./vfs";
import { WebSearchCard, WebFetchCard } from "./web";
import {
  CreateSyllabusCard,
  CreateChapterCard,
  CreateLessonCard,
  CreateActivityCard,
  ListSyllabusesCard,
  ListChaptersCard,
  ListLessonsCard,
  ListLessonsForThreadCard,
  GetSyllabusCard,
  GetLessonCard,
} from "./mcp";
import { WriteTodosCard } from "./todos";
import { GenericToolCard } from "./generic";
import type { ToolCardDensity } from "./shell";

export type { ToolCardDensity, NormalizedToolCall };
export { normalizeLive, normalizeSubagent };

export function ToolCallCard({
  call,
  density,
  expanded,
}: {
  call: NormalizedToolCall;
  density: ToolCardDensity;
  expanded?: boolean;
}) {
  switch (call.name) {
    case "read_file":
      return <ReadFileCard call={call} density={density} expanded={expanded} />;
    case "write_file":
      return (
        <WriteFileCard call={call} density={density} expanded={expanded} />
      );
    case "edit_file":
      return <EditFileCard call={call} density={density} expanded={expanded} />;
    case "ls":
      return <LsCard call={call} density={density} expanded={expanded} />;
    case "web_search":
      return (
        <WebSearchCard call={call} density={density} expanded={expanded} />
      );
    case "web_fetch":
      return <WebFetchCard call={call} density={density} expanded={expanded} />;
    case "create_syllabus":
      return (
        <CreateSyllabusCard call={call} density={density} expanded={expanded} />
      );
    case "create_chapter":
      return (
        <CreateChapterCard call={call} density={density} expanded={expanded} />
      );
    case "create_lesson":
      return (
        <CreateLessonCard call={call} density={density} expanded={expanded} />
      );
    case "create_activity":
      return (
        <CreateActivityCard call={call} density={density} expanded={expanded} />
      );
    case "list_syllabuses":
      return (
        <ListSyllabusesCard call={call} density={density} expanded={expanded} />
      );
    case "list_chapters":
      return (
        <ListChaptersCard call={call} density={density} expanded={expanded} />
      );
    case "list_lessons":
      return (
        <ListLessonsCard call={call} density={density} expanded={expanded} />
      );
    case "list_lessons_for_thread":
      return (
        <ListLessonsForThreadCard
          call={call}
          density={density}
          expanded={expanded}
        />
      );
    case "get_syllabus":
      return (
        <GetSyllabusCard call={call} density={density} expanded={expanded} />
      );
    case "get_lesson":
      return (
        <GetLessonCard call={call} density={density} expanded={expanded} />
      );
    case "write_todos":
      return (
        <WriteTodosCard call={call} density={density} expanded={expanded} />
      );
    default:
      return (
        <GenericToolCard call={call} density={density} expanded={expanded} />
      );
  }
}

/**
 * Convenience wrapper for the chat pane chip density. Normalises the
 * supervisor's live tool call shape and delegates to `ToolCallCard`.
 */
export function LiveToolCallChipCard({ call }: { call: LiveToolCall }) {
  return <ToolCallCard call={normalizeLive(call)} density="chip" />;
}

/**
 * Convenience wrapper for the canvas SubagentRunRow nested tool call
 * row. Normalises the snapshot shape and delegates to `ToolCallCard`
 * with an `expanded` flag controlled by the parent row.
 */
export function SubagentToolCallRowCard({
  call,
  expanded,
}: {
  call: SubagentToolCall;
  expanded: boolean;
}) {
  return (
    <ToolCallCard
      call={normalizeSubagent(call)}
      density="row"
      expanded={expanded}
    />
  );
}

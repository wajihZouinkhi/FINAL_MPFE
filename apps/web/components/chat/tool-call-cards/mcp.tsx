"use client";

/**
 * MCP create_* cards. The deep-agent supervisor + writer + activity
 * maker call into the in-process MCP server (`apps/mcp-supabase`)
 * via the `mpfe-deep-agent` MCP client to mint authoritative rows
 * in Supabase: syllabuses → chapters → lessons, plus standalone
 * activities. Each tool's args carry the user-visible title we
 * surface as the card's headline; for syllabus + activity (the two
 * tools that have an in-canvas viewer) the card is clickable and
 * focuses the canvas Artifact tab.
 *
 * Note: opening the artifact viewer specifically requires the FE to
 * know the canonical artifact id — these cards only know the
 * `create_*` call's args, not the resulting `<artifact …/>` chip
 * the supervisor will eventually emit. So we focus the canvas tab
 * on click but rely on `active_artifact` already being set (the
 * supervisor emits the chip soon after the create_* call returns,
 * and that's what populates `active_artifact`). On a fresh `ok`
 * with no active artifact yet, the click flips the canvas tab and
 * lands on the Files / Subagents fallback — still better than the
 * silent no-op the previous JSON dump gave.
 */

import {
  BookOpen,
  GraduationCap,
  Layers,
  NotebookPen,
  Eye,
  ListTree,
} from "lucide-react";
import { ToolCardShell, type ToolCardDensity } from "./shell";
import {
  formatBytes,
  getArgs,
  type NormalizedToolCall,
} from "./normalize";
import { useAgentStore } from "../../../stores/agent-store";

interface McpCardProps {
  call: NormalizedToolCall;
  density: ToolCardDensity;
  expanded?: boolean;
}

export function CreateSyllabusCard({ call, density, expanded }: McpCardProps) {
  const args = getArgs(call) ?? {};
  const title = typeof args.title === "string" ? args.title : "(untitled)";
  const audience = typeof args.audience === "string" ? args.audience : null;
  const requestCanvasFocus = useAgentStore((s) => s.requestCanvasFocus);
  // Click-to-focus only matters in chip density (chat). In row
  // density we're already inside the canvas — flipping a tab there
  // would be confusing, so we skip the affordance.
  const onClick =
    density === "chip" && call.status === "ok"
      ? () => requestCanvasFocus({ kind: "artifact" })
      : undefined;
  return (
    <ToolCardShell
      call={call}
      density={density}
      icon={BookOpen}
      label={
        <>
          Created syllabus{" "}
          <span className="font-semibold">&ldquo;{title}&rdquo;</span>
        </>
      }
      subline={audience ? `Audience: ${audience}` : null}
      onClick={onClick}
      expanded={expanded}
    />
  );
}

export function CreateChapterCard({ call, density, expanded }: McpCardProps) {
  const args = getArgs(call) ?? {};
  const title = typeof args.title === "string" ? args.title : "(untitled)";
  const syllabusId =
    typeof args.syllabus_id === "string" ? args.syllabus_id : null;
  return (
    <ToolCardShell
      call={call}
      density={density}
      icon={Layers}
      label={
        <>
          Added chapter{" "}
          <span className="font-semibold">&ldquo;{title}&rdquo;</span>
        </>
      }
      subline={
        syllabusId
          ? `to syllabus ${syllabusId.slice(0, 8)}…`
          : null
      }
      expanded={expanded}
    />
  );
}

// ────────────────────────────────────────────────────────────────────
// Read-side MCP cards. The supervisor + subagents poll the database
// during a turn (`list_chapters` after a `create_chapter` to verify
// it landed, `get_lesson` to fetch a draft body before critiquing,
// …). The tool result is the canonical state the agent uses to
// decide next steps, so surfacing it as a `result: …` footer in the
// chip is a real UX win — previously these tools rendered as a
// JSON arg dump with no output, which read as a debug log.
// ────────────────────────────────────────────────────────────────────

export function ListSyllabusesCard({ call, density, expanded }: McpCardProps) {
  const args = getArgs(call) ?? {};
  const threadId =
    typeof args.thread_id === "string" ? args.thread_id : null;
  return (
    <ToolCardShell
      call={call}
      density={density}
      icon={ListTree}
      label="Listed syllabuses"
      subline={threadId ? `thread ${threadId.slice(0, 8)}…` : null}
      expanded={expanded}
      result={previewToText(call)}
    />
  );
}

export function ListChaptersCard({ call, density, expanded }: McpCardProps) {
  const args = getArgs(call) ?? {};
  const syllabusId =
    typeof args.syllabus_id === "string" ? args.syllabus_id : null;
  return (
    <ToolCardShell
      call={call}
      density={density}
      icon={ListTree}
      label="Listed chapters"
      subline={
        syllabusId ? `syllabus ${syllabusId.slice(0, 8)}…` : null
      }
      expanded={expanded}
      result={previewToText(call)}
    />
  );
}

export function ListLessonsCard({ call, density, expanded }: McpCardProps) {
  const args = getArgs(call) ?? {};
  const chapterId =
    typeof args.chapter_id === "string" ? args.chapter_id : null;
  return (
    <ToolCardShell
      call={call}
      density={density}
      icon={ListTree}
      label="Listed lessons"
      subline={chapterId ? `chapter ${chapterId.slice(0, 8)}…` : null}
      expanded={expanded}
      result={previewToText(call)}
    />
  );
}

export function ListLessonsForThreadCard({
  call,
  density,
  expanded,
}: McpCardProps) {
  const args = getArgs(call) ?? {};
  const threadId =
    typeof args.thread_id === "string" ? args.thread_id : null;
  return (
    <ToolCardShell
      call={call}
      density={density}
      icon={ListTree}
      label="Listed all lessons in thread"
      subline={threadId ? `thread ${threadId.slice(0, 8)}…` : null}
      expanded={expanded}
      result={previewToText(call)}
    />
  );
}

export function GetSyllabusCard({ call, density, expanded }: McpCardProps) {
  const args = getArgs(call) ?? {};
  const syllabusId =
    typeof args.syllabus_id === "string" ? args.syllabus_id : null;
  return (
    <ToolCardShell
      call={call}
      density={density}
      icon={Eye}
      label="Read syllabus"
      subline={
        syllabusId
          ? <code className="font-mono">{syllabusId.slice(0, 8)}…</code>
          : null
      }
      expanded={expanded}
      result={previewToText(call)}
    />
  );
}

export function GetLessonCard({ call, density, expanded }: McpCardProps) {
  const args = getArgs(call) ?? {};
  const lessonId =
    typeof args.lesson_id === "string" ? args.lesson_id : null;
  return (
    <ToolCardShell
      call={call}
      density={density}
      icon={Eye}
      label="Read lesson"
      subline={
        lessonId
          ? <code className="font-mono">{lessonId.slice(0, 8)}…</code>
          : null
      }
      expanded={expanded}
      result={previewToText(call)}
    />
  );
}

/**
 * Render the tool's stringified preview as the chip's `result:`
 * footer. `null` while in flight or before a closing ToolMessage
 * exists — the shell hides the slot until status flips to `ok`.
 */
function previewToText(call: NormalizedToolCall) {
  if (!call.output) return null;
  return <span>{call.output}</span>;
}

export function CreateLessonCard({ call, density, expanded }: McpCardProps) {
  const args = getArgs(call) ?? {};
  // The mpfe MCP schemas have evolved across PRs — sometimes the
  // title arg is `title`, sometimes `lesson_title`. Try both so the
  // card works regardless of which version the runner emitted.
  const title =
    typeof args.title === "string"
      ? args.title
      : typeof args.lesson_title === "string"
        ? args.lesson_title
        : "(untitled)";
  const chapterId =
    typeof args.chapter_id === "string" ? args.chapter_id : null;
  const content = typeof args.content === "string" ? args.content : "";
  const sizeLabel = content ? formatBytes(content.length) : null;
  const subline =
    [
      chapterId ? `chapter ${chapterId.slice(0, 8)}…` : null,
      sizeLabel,
    ]
      .filter(Boolean)
      .join(" · ") || null;
  return (
    <ToolCardShell
      call={call}
      density={density}
      icon={NotebookPen}
      label={
        <>
          Created lesson{" "}
          <span className="font-semibold">&ldquo;{title}&rdquo;</span>
        </>
      }
      subline={subline}
      expanded={expanded}
      details={
        content ? (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--muted)]/40 p-1.5 font-mono text-[10.5px] leading-snug text-[var(--foreground)]/80">
            {content}
          </pre>
        ) : null
      }
    />
  );
}

export function CreateActivityCard({ call, density, expanded }: McpCardProps) {
  const args = getArgs(call) ?? {};
  const title =
    typeof args.title === "string"
      ? args.title
      : typeof args.name === "string"
        ? args.name
        : "(untitled)";
  const requestCanvasFocus = useAgentStore((s) => s.requestCanvasFocus);
  const onClick =
    density === "chip" && call.status === "ok"
      ? () => requestCanvasFocus({ kind: "artifact" })
      : undefined;
  return (
    <ToolCardShell
      call={call}
      density={density}
      icon={GraduationCap}
      label={
        <>
          Created activity{" "}
          <span className="font-semibold">&ldquo;{title}&rdquo;</span>
        </>
      }
      onClick={onClick}
      expanded={expanded}
    />
  );
}

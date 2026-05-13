"use client";

/**
 * VFS tool cards. The deep-agent virtual filesystem lives entirely
 * in-memory inside `useAgentStore.vfs` and is what the supervisor +
 * subagents read/write through. The tools the runner registers for
 * VFS access are deepagents builtins:
 *
 *   - `read_file(file_path, offset?, limit?)`
 *   - `write_file(file_path, content)`
 *   - `edit_file(file_path, old_string, new_string)` (str_replace)
 *   - `ls()`
 *
 * Each card surfaces the most identifying arg (the path + optional
 * line range) inline and, for canvas-row density, the full content /
 * diff in the expanded body.
 */

import { FileText, FilePlus, Pencil, FolderOpen } from "lucide-react";
import { ToolCardShell, type ToolCardDensity } from "./shell";
import { getArgs, formatBytes, type NormalizedToolCall } from "./normalize";

interface VfsCardProps {
  call: NormalizedToolCall;
  density: ToolCardDensity;
  expanded?: boolean;
}

export function ReadFileCard({ call, density, expanded }: VfsCardProps) {
  const args = getArgs(call) ?? {};
  const filePath = typeof args.file_path === "string" ? args.file_path : "?";
  const offset = typeof args.offset === "number" ? args.offset : null;
  const limit = typeof args.limit === "number" ? args.limit : null;
  // deepagents `read_file` uses 0-indexed offsets inclusive of `limit`
  // lines starting at `offset`. Render as 1-indexed line numbers to
  // match how editors and humans talk about line ranges.
  const range =
    offset !== null && limit !== null
      ? `lines ${offset + 1}–${offset + limit}`
      : offset !== null
        ? `from line ${offset + 1}`
        : limit !== null
          ? `first ${limit} lines`
          : null;
  return (
    <ToolCardShell
      call={call}
      density={density}
      icon={FileText}
      label={
        <>
          Read <code className="font-mono">{filePath}</code>
        </>
      }
      subline={range}
      expanded={expanded}
      details={
        call.output ? (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--muted)]/40 p-1.5 font-mono text-[10.5px] leading-snug text-[var(--foreground)]/80">
            {call.output}
          </pre>
        ) : null
      }
    />
  );
}

export function WriteFileCard({ call, density, expanded }: VfsCardProps) {
  const args = getArgs(call) ?? {};
  const filePath = typeof args.file_path === "string" ? args.file_path : "?";
  const content = typeof args.content === "string" ? args.content : "";
  const lineCount = content ? content.split("\n").length : 0;
  const subline = content
    ? `${formatBytes(content.length)} · ${lineCount} line${lineCount === 1 ? "" : "s"}`
    : null;
  return (
    <ToolCardShell
      call={call}
      density={density}
      icon={FilePlus}
      label={
        <>
          Wrote <code className="font-mono">{filePath}</code>
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

export function EditFileCard({ call, density, expanded }: VfsCardProps) {
  const args = getArgs(call) ?? {};
  const filePath = typeof args.file_path === "string" ? args.file_path : "?";
  const oldString = typeof args.old_string === "string" ? args.old_string : "";
  const newString = typeof args.new_string === "string" ? args.new_string : "";
  const oldLines = oldString ? oldString.split("\n").length : 0;
  const newLines = newString ? newString.split("\n").length : 0;
  const subline =
    oldLines || newLines ? `−${oldLines} / +${newLines} lines` : null;
  return (
    <ToolCardShell
      call={call}
      density={density}
      icon={Pencil}
      label={
        <>
          Edited <code className="font-mono">{filePath}</code>
        </>
      }
      subline={subline}
      expanded={expanded}
      details={
        oldString || newString ? (
          <div className="overflow-hidden rounded border border-[var(--border)] font-mono text-[10.5px] leading-snug">
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words bg-red-500/[0.08] p-1.5 text-red-700 dark:text-red-300">
              {prefixLines(oldString, "- ")}
            </pre>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words bg-emerald-500/[0.08] p-1.5 text-emerald-700 dark:text-emerald-300">
              {prefixLines(newString, "+ ")}
            </pre>
          </div>
        ) : null
      }
    />
  );
}

export function LsCard({ call, density, expanded }: VfsCardProps) {
  // deepagents `ls` returns a newline-separated path listing. We
  // count + render the first 50 paths in the expanded body. If the
  // tool hasn't run yet (`status === "running"`), output is null and
  // we render the card without a subline / details.
  const out = call.output ?? "";
  const paths = out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const subline =
    paths.length > 0
      ? `${paths.length} path${paths.length === 1 ? "" : "s"}`
      : null;
  return (
    <ToolCardShell
      call={call}
      density={density}
      icon={FolderOpen}
      label="Listed virtual filesystem"
      subline={subline}
      expanded={expanded}
      details={
        paths.length > 0 ? (
          <ul className="max-h-48 space-y-0.5 overflow-auto rounded bg-[var(--muted)]/40 p-1.5 font-mono text-[10.5px] leading-snug text-[var(--foreground)]/80">
            {paths.slice(0, 50).map((p, i) => (
              <li key={i} className="truncate">
                {p}
              </li>
            ))}
            {paths.length > 50 ? (
              <li className="text-[var(--muted-foreground)]">
                +{paths.length - 50} more
              </li>
            ) : null}
          </ul>
        ) : null
      }
    />
  );
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((l) => prefix + l)
    .join("\n");
}

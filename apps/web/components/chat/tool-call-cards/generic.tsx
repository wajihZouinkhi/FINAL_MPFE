"use client";

/**
 * Fallback for unknown tools. Preserves the previous JSON-dump
 * rendering (so any tool the runner ever adds without a matching
 * card here still renders SOMETHING useful) but routes through the
 * new `ToolCardShell` so the visual rhythm — status pill, duration,
 * error band — stays consistent with the friendly per-tool cards.
 *
 * Surface examples that hit this path today:
 *   - any new tool name not in the explicit switch in `index.tsx`
 *   - mid-stream tool calls whose `name` arrived but whose args
 *     haven't yet (in which case `args` is null but we still render
 *     a chip with name + status spinner)
 */

import { Wrench } from "lucide-react";
import { ToolCardShell, type ToolCardDensity } from "./shell";
import type { NormalizedToolCall } from "./normalize";

export function GenericToolCard({
  call,
  density,
  expanded,
}: {
  call: NormalizedToolCall;
  density: ToolCardDensity;
  expanded?: boolean;
}) {
  // Pre-build the truncated args preview for the subline. Prefer
  // parsed args; fall back to the raw streaming buffer so a chip
  // mid-`tool_call_arg_delta` shows ANYTHING rather than nothing.
  const argsPreview = call.args
    ? safeStringify(call.args)
    : call.args_buffer;
  const truncated =
    argsPreview.length > 160 ? argsPreview.slice(0, 160) + "…" : argsPreview;
  return (
    <ToolCardShell
      call={call}
      density={density}
      icon={Wrench}
      label={<code className="font-mono">{call.name}</code>}
      subline={
        truncated ? (
          <span className="font-mono text-[10.5px]">{truncated}</span>
        ) : null
      }
      expanded={expanded}
      details={
        <div className="space-y-1.5">
          {call.args && Object.keys(call.args).length > 0 ? (
            <details className="group" open>
              <summary className="cursor-pointer select-none font-mono text-[10px] uppercase tracking-wider text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
                args
              </summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--muted)]/40 p-1.5 font-mono text-[10.5px] leading-snug text-[var(--foreground)]/80">
                {safeStringify(call.args, 2)}
              </pre>
            </details>
          ) : null}
          {call.output ? (
            <details className="group" open>
              <summary className="cursor-pointer select-none font-mono text-[10px] uppercase tracking-wider text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
                output
              </summary>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--muted)]/40 p-1.5 font-mono text-[10.5px] leading-snug text-[var(--foreground)]/80">
                {call.output}
              </pre>
            </details>
          ) : null}
        </div>
      }
    />
  );
}

function safeStringify(value: unknown, indent?: number): string {
  try {
    return JSON.stringify(value, null, indent);
  } catch {
    return String(value);
  }
}

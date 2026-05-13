/**
 * Normalises the two on-wire shapes a tool call can arrive in
 * (`LiveToolCall` from the supervisor's chat stream and
 * `SubagentToolCall` from the canvas's per-subagent panel) into
 * one render-side shape so per-tool cards don't have to branch.
 *
 * The two sources differ in:
 *   - id field name           (live: `id`, subagent: `tool_call_id`)
 *   - status enum             (live: `calling|ok|error`, subagent: `running|ok|error`)
 *   - args availability       (live: `null` until `tool_call_end`, subagent: always set)
 *   - output field name       (live: `preview`, subagent: `output`)
 *
 * They agree on the conceptual shape: name + args + status + duration
 * + a stringified output preview + an optional error.
 */

import type { LiveToolCall } from "../../../stores/agent-store";
import type { SubagentToolCall } from "@mpfe/shared";

export interface NormalizedToolCall {
  id: string;
  name: string;
  /**
   * Parsed args once the runner has finalised the tool call. While a
   * supervisor `tool_call_arg_delta` is still streaming, this is null
   * and `args_buffer` carries the raw partial-JSON tail. Subagent
   * tool calls always have parsed args.
   */
  args: Record<string, unknown> | null;
  /** Raw streaming arg buffer (live source only; empty for subagent). */
  args_buffer: string;
  status: "running" | "ok" | "error";
  duration_ms: number | null;
  output: string | null;
  error: string | null;
}

export function normalizeLive(call: LiveToolCall): NormalizedToolCall {
  return {
    id: call.id,
    name: call.name,
    args: call.args,
    args_buffer: call.args_buffer,
    // `calling` (Vercel AI SDK live frame) and `running` (subagent
    // snapshot) both mean "in flight". Collapse to one enum.
    status: call.status === "calling" ? "running" : call.status,
    duration_ms: call.duration_ms,
    output: call.preview,
    error: call.error,
  };
}

export function normalizeSubagent(
  call: SubagentToolCall,
): NormalizedToolCall {
  return {
    id: call.tool_call_id,
    name: call.name,
    args: call.args,
    args_buffer: "",
    status: call.status,
    duration_ms: call.duration_ms,
    output: call.output,
    error: call.error,
  };
}

/**
 * Best-effort parse of a streaming arg buffer. The supervisor emits
 * args as a sequence of `tool_call_arg_delta` chunks that concatenate
 * to a single JSON object; mid-stream the buffer is partial and
 * unparseable. Returns null on partial / invalid JSON so callers can
 * still render the friendly card with whatever fields HAVE arrived
 * (we degrade gracefully to an empty `args` view).
 */
export function tryParseArgs(
  buffer: string,
): Record<string, unknown> | null {
  if (!buffer.trim()) return null;
  try {
    const v: unknown = JSON.parse(buffer);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Returns the best available args view: prefers the parsed args
 * (set after `tool_call_end`); falls back to a best-effort parse of
 * the live `args_buffer`; null if neither is usable yet.
 */
export function getArgs(
  call: NormalizedToolCall,
): Record<string, unknown> | null {
  if (call.args) return call.args;
  return tryParseArgs(call.args_buffer);
}

/**
 * Pretty-print a byte count for the file-size sublines on the
 * `write_file` / `create_lesson` cards. Mirrors the formatting used
 * elsewhere in the app (KB precision to 1dp, MB to 1dp).
 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format an elapsed-ms duration into a compact human label. Matches
 * the existing `formatDuration` in `deepagent-canvas.tsx` so the
 * canvas row's "12.4s" reads the same as the chat chip's "12.4s".
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}m ${r}s`;
}

"use client";

/**
 * Shared layout for every per-tool card. Per-tool components stay
 * presentational — they pick an icon + a friendly label + an optional
 * subline + (for canvas-row density) a richer details block, and
 * delegate the status pill, duration, error band, and click-affordance
 * to this shell so the visual rhythm is consistent across tools.
 *
 * Two densities:
 *
 *   - `chip`: chat pane (an inline live tool-call rendered under the
 *     supervisor's AI bubble). Multiline-friendly card; no expand
 *     state — chips are always at their compact form.
 *   - `row`:  canvas SubagentRunRow (a nested tool call rendered
 *     inside the parent task's expandable row). When the parent row
 *     is collapsed the card is a 1-liner; when expanded the
 *     tool-specific `details` slot kicks in.
 */

import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import type { NormalizedToolCall } from "./normalize";
import { formatDuration } from "./normalize";

export type ToolCardDensity = "chip" | "row";

interface ToolCardShellProps {
  call: NormalizedToolCall;
  density: ToolCardDensity;
  /** Tool-specific accent icon (paper, pencil, globe, …). */
  icon: LucideIcon;
  /**
   * Friendly human label — e.g. "Read /pedagogy_plan.md". Caller
   * picks the most distinctive arg and renders it inline. Inline
   * markup is allowed (e.g. `<code>` for paths) — the shell wraps it
   * in a 1-line truncating container.
   */
  label: ReactNode;
  /**
   * Optional sub-line under the header. Used for the second-tier
   * info that's nice-to-have but not critical (line range, audience,
   * file size, search-result count, …).
   */
  subline?: ReactNode;
  /**
   * Optional inline result body — rendered below the subline as a
   * "result: …" footer with a `border-t` separator. Only shown when
   * `call.status === "ok"`. Use this for read-side tools whose tool
   * message carries useful text (`list_chapters`, `get_lesson`,
   * `web_search`, …) so the user sees what came back without having
   * to click through to the canvas. Mirrors the TaskCard's
   * description+result layout pattern.
   *
   * Chip density: always visible. Row density: gated on `expanded`
   * so a collapsed nested tool call inside a SubagentRunRow stays
   * a 1-liner.
   */
  result?: ReactNode;
  /**
   * Optional unframed body slot — rendered below the subline with no
   * "result:" prefix, no border, no truncation. Used for tools whose
   * args ARE the user-visible content (`write_todos` carries the
   * checklist as args; the tool's actual result message is just
   * "Updated todos." and not worth surfacing). Always visible at
   * chip density; gated on `expanded` at row density.
   */
  body?: ReactNode;
  /**
   * Optional click handler. Renders the chip as a `<button>` instead
   * of a `<div>` and draws a hover state. Currently used by the
   * `create_*` artifact cards to flip the canvas to the Artifact tab
   * via `requestCanvasFocus({ kind: "artifact" })`.
   */
  onClick?: () => void;
  /**
   * Canvas-row only. When the parent SubagentRunRow is expanded, the
   * `details` slot below renders. Ignored for chip density.
   */
  expanded?: boolean;
  /**
   * Tool-specific expanded body (full content, full diff, search
   * results, …). Only rendered when `density === "row"` AND
   * `expanded` is true — chip density never renders details.
   */
  details?: ReactNode;
}

export function ToolCardShell({
  call,
  density,
  icon: Icon,
  label,
  subline,
  result,
  body,
  onClick,
  expanded,
  details,
}: ToolCardShellProps) {
  const StatusIcon =
    call.status === "running"
      ? Loader2
      : call.status === "ok"
        ? CheckCircle2
        : AlertCircle;
  const statusColor =
    call.status === "running"
      ? "text-[var(--primary)]"
      : call.status === "ok"
        ? "text-emerald-500 dark:text-emerald-400"
        : "text-red-500 dark:text-red-400";
  const durLabel =
    typeof call.duration_ms === "number"
      ? formatDuration(call.duration_ms)
      : call.status === "running"
        ? "running…"
        : "—";

  if (density === "chip") {
    // Chat pane chip — full-width card, multiline-friendly. We have
    // to branch on `onClick` to avoid emitting a `<button>` with
    // `type="button"` for non-interactive cards (some Tailwind
    // fixtures pick up button defaults that aren't appropriate for a
    // static card, e.g. inherited focus rings on every paint).
    const showResult = call.status === "ok" && result != null;
    if (onClick) {
      return (
        <button
          type="button"
          onClick={onClick}
          className="flex w-full animate-fade-in cursor-pointer flex-col gap-1 rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-left text-[12px] transition hover:border-[var(--primary)]/40 hover:bg-[var(--card)]/80"
        >
          <ChipHeader
            Icon={Icon}
            label={label}
            StatusIcon={StatusIcon}
            statusColor={statusColor}
            statusRunning={call.status === "running"}
            durLabel={durLabel}
          />
          {subline ? <ChipSubline>{subline}</ChipSubline> : null}
          {body ? <div>{body}</div> : null}
          {showResult ? <ChipResult>{result}</ChipResult> : null}
          {call.error ? <ChipError>{call.error}</ChipError> : null}
        </button>
      );
    }
    return (
      <div className="flex animate-fade-in flex-col gap-1 rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-[12px]">
        <ChipHeader
          Icon={Icon}
          label={label}
          StatusIcon={StatusIcon}
          statusColor={statusColor}
          statusRunning={call.status === "running"}
          durLabel={durLabel}
        />
        {subline ? <ChipSubline>{subline}</ChipSubline> : null}
        {body ? <div>{body}</div> : null}
        {showResult ? <ChipResult>{result}</ChipResult> : null}
        {call.error ? <ChipError>{call.error}</ChipError> : null}
      </div>
    );
  }

  // density === "row" — canvas SubagentRunRow nested tool call.
  // Compact 1-liner when collapsed; tool-specific details body when
  // the parent row is expanded.
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--background)]/40 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <StatusIcon
          className={
            "h-3 w-3 shrink-0 " +
            statusColor +
            (call.status === "running" ? " animate-spin" : "")
          }
        />
        <Icon className="h-3 w-3 shrink-0 text-[var(--muted-foreground)]" />
        <div className="min-w-0 flex-1 truncate text-[11px] font-semibold text-[var(--foreground)]">
          {label}
        </div>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-[var(--muted-foreground)]">
          {durLabel}
        </span>
      </div>
      {subline ? (
        <div className="mt-0.5 truncate text-[10.5px] text-[var(--muted-foreground)]">
          {subline}
        </div>
      ) : null}
      {expanded && body ? <div className="mt-1">{body}</div> : null}
      {expanded && call.status === "ok" && result != null ? (
        <div className="mt-1 border-t border-[var(--border)] pt-1 text-[10.5px] text-[var(--muted-foreground)]">
          <span className="font-medium text-[var(--foreground)]">
            result:
          </span>{" "}
          {result}
        </div>
      ) : null}
      {expanded && details ? <div className="mt-1.5">{details}</div> : null}
      {expanded && call.error ? (
        <div className="mt-1 rounded border border-red-400/40 bg-red-400/10 p-1.5 text-[10.5px] text-red-700 dark:text-red-300">
          {call.error}
        </div>
      ) : null}
    </div>
  );
}

function ChipHeader({
  Icon,
  label,
  StatusIcon,
  statusColor,
  statusRunning,
  durLabel,
}: {
  Icon: LucideIcon;
  label: ReactNode;
  StatusIcon: LucideIcon;
  statusColor: string;
  statusRunning: boolean;
  durLabel: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--primary)]" />
      <div className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--foreground)]">
        {label}
      </div>
      <StatusIcon
        className={
          "h-3 w-3 shrink-0 " +
          statusColor +
          (statusRunning ? " animate-spin" : "")
        }
      />
      <span className="shrink-0 font-mono text-[10.5px] text-[var(--muted-foreground)]">
        {durLabel}
      </span>
    </div>
  );
}

function ChipSubline({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11.5px] text-[var(--muted-foreground)]">
      {children}
    </div>
  );
}

function ChipResult({ children }: { children: ReactNode }) {
  // Mirrors the TaskCard's "result: …" inline footer (`border-t`
  // separator + bold prefix). Children are left unconstrained so
  // either a plain text result (`list_chapters`, `web_search`, …)
  // or a block-level body (write_todos checklist) can render here
  // without an extra wrapper. The chat-pane is scrollable so a
  // verbose result still respects the page layout.
  return (
    <div className="mt-0.5 border-t border-[var(--border)] pt-1.5 text-[11px] leading-snug text-[var(--muted-foreground)]">
      <span className="font-medium text-[var(--foreground)]">result:</span>{" "}
      {children}
    </div>
  );
}

function ChipError({ children }: { children: ReactNode }) {
  return (
    <div className="mt-0.5 text-[11px] text-red-600 dark:text-red-400">
      {children}
    </div>
  );
}

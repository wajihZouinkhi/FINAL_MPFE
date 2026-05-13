"use client";

/**
 * Web cards. Serper-backed `web_search` and `web_fetch` are
 * registered on the researcher subagent (and re-exposed to the
 * supervisor via `pickMcpTools`). Both have a single distinctive
 * scalar arg (`query` / `url`) and a stringified output preview.
 *
 * `web_search` parses the output as Serper JSON to surface a result
 * count; `web_fetch` extracts the URL host for the friendly label.
 * Both fall back gracefully to the raw output preview in the
 * canvas-row expanded body.
 */

import { Globe, Search } from "lucide-react";
import { ToolCardShell, type ToolCardDensity } from "./shell";
import { getArgs, type NormalizedToolCall } from "./normalize";

interface WebCardProps {
  call: NormalizedToolCall;
  density: ToolCardDensity;
  expanded?: boolean;
}

export function WebSearchCard({ call, density, expanded }: WebCardProps) {
  const args = getArgs(call) ?? {};
  const query = typeof args.query === "string" ? args.query : "";
  const numResults = countSearchResults(call.output);
  return (
    <ToolCardShell
      call={call}
      density={density}
      icon={Search}
      label={
        <>
          Searched:{" "}
          <span className="text-[var(--muted-foreground)]">
            &ldquo;{query}&rdquo;
          </span>
        </>
      }
      subline={
        numResults !== null
          ? `${numResults} result${numResults === 1 ? "" : "s"}`
          : null
      }
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

export function WebFetchCard({ call, density, expanded }: WebCardProps) {
  const args = getArgs(call) ?? {};
  const url = typeof args.url === "string" ? args.url : "";
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  return (
    <ToolCardShell
      call={call}
      density={density}
      icon={Globe}
      label={
        <>
          Fetched <code className="font-mono">{host}</code>
        </>
      }
      subline={url && url !== host ? url : null}
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

/**
 * Best-effort count of result entries from a Serper-style output.
 * Tries the canonical JSON shape first (`{ organic: [...] }`); if
 * the output is plain text or a different schema, falls back to
 * counting "1.", "2.", … numbered list markers. Returns null if
 * neither approach yields a count — the card then renders without
 * a subline.
 */
function countSearchResults(output: string | null): number | null {
  if (!output) return null;
  try {
    const parsed: unknown = JSON.parse(output);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "organic" in parsed &&
      Array.isArray((parsed as { organic: unknown }).organic)
    ) {
      return (parsed as { organic: unknown[] }).organic.length;
    }
  } catch {
    // Not JSON — try the numbered-marker heuristic below.
  }
  const matches = output.match(/^\s*\d+\./gm);
  return matches ? matches.length : null;
}

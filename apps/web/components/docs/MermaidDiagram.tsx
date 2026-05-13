"use client";

import { useEffect, useRef, useState, useId } from "react";

/**
 * Client-only Mermaid renderer.
 *
 * Mermaid registers a global on import and pulls in DOM APIs, so it can't run
 * during SSR. We dynamically import on mount, render the chart into the host
 * `<div>`, and fall back to a `<pre>` of the raw source if rendering throws
 * (e.g. syntax error, unsupported browser feature).
 *
 * All agent doc pages share this component — keep it dumb, no per-agent
 * styling here. Theming follows the `class="dark"` on `<html>` and the CSS
 * vars in globals.css.
 */
export function MermaidDiagram({
  chart,
  caption,
}: {
  chart: string;
  caption?: string;
}) {
  const reactId = useId();
  // Mermaid requires DOM-id-safe IDs (no `:` from React's useId).
  const safeId = `mmd-${reactId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          fontFamily:
            "var(--font-sans), Inter, ui-sans-serif, system-ui, -apple-system, sans-serif",
          themeVariables: {
            background: "#231a12",
            primaryColor: "#2e2218",
            primaryTextColor: "#f5ede3",
            primaryBorderColor: "#f66e60",
            lineColor: "#a08060",
            secondaryColor: "#3a2a1a",
            tertiaryColor: "#1a140e",
            tertiaryTextColor: "#fcaf41",
            edgeLabelBackground: "#1a140e",
            clusterBkg: "#1a140e",
            clusterBorder: "#3a2a1a",
            titleColor: "#fcaf41",
            mainBkg: "#2e2218",
            nodeBorder: "#f66e60",
            noteBkgColor: "#231a12",
            noteTextColor: "#f5ede3",
          },
          flowchart: { curve: "basis", htmlLabels: true, padding: 14 },
        });
        const { svg } = await mermaid.render(safeId, chart);
        if (!cancelled && hostRef.current) {
          hostRef.current.innerHTML = svg;
        }
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message ?? String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chart, safeId]);

  return (
    <figure className="my-6 rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
      {error ? (
        <pre className="overflow-x-auto text-xs text-[var(--destructive)]">
          mermaid render failed: {error}
          {"\n\n"}
          {chart}
        </pre>
      ) : (
        <div ref={hostRef} className="overflow-x-auto [&_svg]:mx-auto" />
      )}
      {caption ? (
        <figcaption className="mt-3 text-center text-xs text-[var(--muted-foreground)]">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

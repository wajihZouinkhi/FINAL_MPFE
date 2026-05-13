"use client";

import { memo } from "react";
import { toast } from "sonner";
import type { ArtifactCard } from "@mpfe/shared";
import { Markdown } from "./markdown";
import { DeepArtifactCard } from "./deep-artifact-card";
import { parseArtifactSegments } from "../../lib/artifact-card";
import { useAgentStore } from "../../stores/agent-store";

/**
 * Renders chat-bubble text with inline Deep Agent artifact cards.
 *
 * The supervisor embeds clickable cards mid-prose with a self-closing
 * `<artifact kind="…" id="…" title="…" />` tag. This component splits
 * the source by those tags and renders each segment with the
 * appropriate child:
 *   - text segments   → existing `Markdown` component (full markdown
 *                       grammar, streaming-safe).
 *   - artifact tags   → `DeepArtifactCard` (clickable chip).
 *
 * Use this wherever `Markdown` was previously rendered for assistant
 * bubbles. User bubbles never contain artifact tags (the user types
 * plain text), so user-side rendering can keep using `Markdown`
 * directly.
 *
 * Click behaviour is wired straight to the agent-store's
 * `openArtifact` action so a click on a syllabus / worksheet chip
 * pops the canvas's Artifact tab open in-place — no
 * `/syllabuses/<id>` / `/activities/<id>` page navigation. `lesson`
 * chips fall back to the legacy toast (no in-canvas viewer yet).
 *
 * Memoised on `source` so re-renders triggered by unrelated parent
 * state don't re-parse the source. The parser is cheap (~linear scan
 * + a couple of regexes per tag) but the bubble may stream 30–80
 * deltas per second during assistant turns; skipping the parse on
 * identical-source renders is still a worthwhile win.
 */
interface MarkdownWithArtifactsProps {
  source: string;
}

const KIND_LABEL: Record<ArtifactCard["kind"], string> = {
  syllabus: "Syllabus",
  worksheet: "Worksheet",
  lesson: "Lesson",
};

function MarkdownWithArtifactsImpl({ source }: MarkdownWithArtifactsProps) {
  const openArtifact = useAgentStore((s) => s.openArtifact);
  const segments = parseArtifactSegments(source);
  // Fast path: a bubble with no artifact tags is the overwhelming
  // majority. Skip the segment wrapper entirely so the existing
  // `Markdown` memo identity is preserved.
  if (segments.length === 1 && segments[0].type === "text") {
    return <Markdown source={segments[0].text} />;
  }
  const handleOpen = (card: ArtifactCard) => {
    if (card.kind === "syllabus" || card.kind === "worksheet") {
      openArtifact(card);
      return;
    }
    // Lesson chips have no dedicated viewer yet — surface the
    // resource id via a toast, mirroring the original
    // DeepArtifactCard fallback so behaviour stays unchanged.
    const label = card.title.trim() || "(untitled)";
    toast.message(`${KIND_LABEL[card.kind]}: ${label}`, {
      description: `id: ${card.id}`,
    });
  };
  return (
    <div className="space-y-1">
      {segments.map((seg, i) =>
        seg.type === "text" ? (
          // Empty text segments arise between adjacent artifact tags
          // (e.g. `<artifact … /><artifact … />`). Drop them so we
          // don't render an empty `<div className="prose-custom">`
          // shell with no content.
          seg.text.trim() === "" ? null : (
            <Markdown key={`t${i}`} source={seg.text} />
          )
        ) : (
          <DeepArtifactCard
            key={`a${i}-${seg.card.id}`}
            card={seg.card}
            onOpen={handleOpen}
          />
        ),
      )}
    </div>
  );
}

export const MarkdownWithArtifacts = memo(
  MarkdownWithArtifactsImpl,
  (a, b) => a.source === b.source,
);
MarkdownWithArtifacts.displayName = "MarkdownWithArtifacts";

"use client";

import { ExternalLink, FileText, GraduationCap, Plug } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { ArtifactCard } from "@mpfe/shared";

/**
 * Inline card the chat pane renders in place of a `<artifact … />`
 * tag the Deep Agent supervisor embeds in its assistant text.
 *
 * Visual: small bordered chip — kind icon, title, "open" arrow on the
 * right. Clickable. Sized to sit inline with prose without dominating
 * the bubble.
 *
 * Default click behaviour: navigate to the dedicated read-only
 * viewer for the artifact's kind:
 *   - `kind="syllabus"`  → `/syllabuses/<id>`
 *   - `kind="worksheet"` → `/activities/<id>`
 *   - `kind="lesson"`    → no dedicated viewer yet (the syllabus
 *                          viewer renders lessons in-context). Falls
 *                          back to the original toast + console
 *                          stub so the user still gets feedback.
 *
 * The `onOpen` prop overrides the default when the host (e.g. a
 * future in-thread side-panel canvas) wants thread-aware behaviour
 * instead of a hard navigation.
 */
export interface DeepArtifactCardProps {
  card: ArtifactCard;
  onOpen?: (card: ArtifactCard) => void;
}

const KIND_LABEL: Record<ArtifactCard["kind"], string> = {
  syllabus: "Syllabus",
  worksheet: "Worksheet",
  lesson: "Lesson",
};

const KIND_ICON: Record<ArtifactCard["kind"], React.ReactNode> = {
  syllabus: <GraduationCap className="h-3.5 w-3.5" />,
  worksheet: <Plug className="h-3.5 w-3.5" />,
  lesson: <FileText className="h-3.5 w-3.5" />,
};

/**
 * Map an artifact card to its viewer route, or `null` if no viewer
 * exists for that kind yet. Centralised so the routing story has
 * exactly one source of truth — adding a viewer (e.g. for `lesson`)
 * is a single-line change here.
 */
function viewerHrefFor(card: ArtifactCard): string | null {
  switch (card.kind) {
    case "syllabus":
      return `/syllabuses/${card.id}`;
    case "worksheet":
      return `/activities/${card.id}`;
    case "lesson":
      return null;
  }
}

export function DeepArtifactCard({ card, onOpen }: DeepArtifactCardProps) {
  const router = useRouter();
  const label = card.title.trim() || "(untitled)";
  const handleClick = () => {
    if (onOpen) {
      onOpen(card);
      return;
    }
    const href = viewerHrefFor(card);
    if (href) {
      router.push(href);
      return;
    }
    // Fallback for kinds that don't have a dedicated viewer yet.
    // Surface the resource id so the user still gets feedback rather
    // than a silent no-op.
    toast.message(`${KIND_LABEL[card.kind]}: ${label}`, {
      description: `id: ${card.id}`,
    });
    if (typeof window !== "undefined") {
      // eslint-disable-next-line no-console
      console.info("[DeepArtifactCard] open", card);
    }
  };
  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={`Open ${KIND_LABEL[card.kind].toLowerCase()}: ${label}`}
      className="my-1 inline-flex max-w-full items-center gap-2 rounded-lg border border-[var(--primary)]/30 bg-[var(--primary)]/8 px-2.5 py-1.5 text-left text-[12.5px] text-[var(--foreground)] shadow-[0_4px_14px_-10px_rgba(246,110,96,0.7)] transition hover:border-[var(--primary)]/60 hover:bg-[var(--primary)]/12"
    >
      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--primary)]/15 text-[var(--primary)] ring-1 ring-[var(--primary)]/30">
        {KIND_ICON[card.kind]}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="font-mono text-[9.5px] uppercase tracking-wider text-[var(--muted-foreground)]">
          {KIND_LABEL[card.kind]}
        </span>
        <span className="truncate font-medium text-[var(--foreground)]">
          {label}
        </span>
      </span>
      <ExternalLink className="ml-1 h-3 w-3 shrink-0 text-[var(--muted-foreground)]" />
    </button>
  );
}

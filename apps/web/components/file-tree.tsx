"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  FileText,
  Link2,
  Loader2,
  Circle,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import type { SyllabusSnapshot, ManifestItem } from "@mpfe/shared";
import { useAgentStore } from "../stores/agent-store";

/**
 * FileTree (left pane) — Syllabus → Chapters → Lessons.
 *
 * Two data sources merged into one tree:
 *   • `snapshot` — committed rows pushed by Supabase Realtime (the truth).
 *   • `manifest` — in-flight items the agent will commit shortly.
 * The manifest is what makes pending lessons visible BEFORE Postgres has
 * them, so the tree feels alive while writing is happening.
 *
 * Visual conventions match the MPFE FileTree: warm dark sidebar, monospaced
 * `#N` chapter prefix, lesson count badge, and auto-expand on first appear.
 */
export function FileTree({ snapshot }: { snapshot: SyllabusSnapshot | null }) {
  const manifest = useAgentStore((s) => s.manifest);
  const activeId = useAgentStore((s) => s.active_lesson_id);
  const activeChapterId = useAgentStore((s) => s.active_chapter_id);
  const setActive = useAgentStore((s) => s.setActiveLesson);
  const setActiveChapter = useAgentStore((s) => s.setActiveChapter);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const merged = useMemo(
    () => mergeTree(snapshot, manifest),
    [snapshot, manifest],
  );

  // Auto-expand chapters the first time we see them — matches MPFE feel
  // where the tree opens itself as the agent commits.
  const seenRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    setExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const c of merged.chapters) {
        if (!seenRef.current.has(c.id)) {
          seenRef.current.add(c.id);
          if (!next.has(c.id)) {
            next.add(c.id);
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [merged.chapters]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <aside className="flex h-full flex-col border-r border-[var(--border)] bg-[var(--sidebar-background)]">
      <Link
        href="/threads"
        className="flex shrink-0 items-center gap-1.5 border-b border-[var(--sidebar-border)]/60 px-3 py-2 text-[11.5px] text-[var(--muted-foreground)] transition hover:text-[var(--primary)]"
      >
        <ArrowLeft className="h-3 w-3" />
        All threads
      </Link>
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--sidebar-border)] px-3 py-3">
        <FolderOpen className="h-3.5 w-3.5 text-[var(--primary)]" />
        <h2 className="truncate text-[12.5px] font-semibold text-[var(--sidebar-foreground)]">
          {snapshot?.syllabus?.title ?? "Syllabus"}
        </h2>
        {merged.chapters.length > 0 ? (
          <span className="ml-auto rounded-full border border-[var(--sidebar-border)] bg-[var(--muted)] px-2 py-px font-mono text-[10px] text-[var(--muted-foreground)]">
            {merged.chapters.length} ch
          </span>
        ) : null}
      </header>

      {!snapshot?.syllabus && merged.chapters.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 py-6 text-center">
          <div className="flex flex-col items-center gap-2 text-[11.5px] text-[var(--muted-foreground)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--primary)]" />
            <span>
              Waiting for the agent to start a syllabus…
              <br />
              Send a request in the chat.
            </span>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-1 py-1">
          <ul className="flex flex-col">
            {merged.chapters.map((c, idx) => {
              const isCommitted = !c.id.startsWith("pending:");
              const isActiveChapter = activeChapterId === c.id;
              return (
              <li key={c.id} className="flex flex-col">
                <div
                  className={
                    "group flex items-center gap-1 rounded text-left text-[13px] font-medium transition " +
                    (isActiveChapter
                      ? "bg-[var(--primary)]/15 text-[var(--primary)]"
                      : "text-[var(--sidebar-foreground)] hover:bg-[var(--sidebar-accent)]")
                  }
                >
                  <button
                    type="button"
                    onClick={() => toggle(c.id)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded text-[var(--muted-foreground)] transition hover:text-[var(--foreground)]"
                    aria-label={expanded.has(c.id) ? "Collapse chapter" : "Expand chapter"}
                  >
                    {expanded.has(c.id) ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      isCommitted ? setActiveChapter(c.id) : undefined
                    }
                    disabled={!isCommitted}
                    className={
                      "flex flex-1 items-center gap-1 truncate py-1.5 pr-2 text-left " +
                      (isCommitted
                        ? ""
                        : "cursor-not-allowed opacity-80")
                    }
                    title={
                      isCommitted
                        ? "View chapter summary"
                        : "Chapter pending commit"
                    }
                  >
                    <span className="mr-1 font-mono text-[10px] text-[var(--muted-foreground)]">
                      #{idx + 1}
                    </span>
                    <span className="flex-1 truncate">{c.title}</span>
                    <span className="rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">
                      {c.lessons.length}
                    </span>
                  </button>
                </div>
                {expanded.has(c.id) ? (
                  <ul className="ml-3 border-l border-[var(--sidebar-border)] pl-2">
                    {c.lessons.map((l) => {
                      // Resolve dep UUIDs against the merged tree so the
                      // chip can show the actual lesson title (and so a
                      // dep on a still-pending lesson still renders —
                      // pending entries are in the manifest from the
                      // very first seed slice).
                      const deps = l.dependsOn
                        .map((id) => merged.lessonsById.get(id))
                        .filter(
                          (d): d is { id: string; title: string } => !!d,
                        );
                      return (
                        <li key={l.id}>
                          <button
                            type="button"
                            onClick={() =>
                              l.committed ? setActive(l.id) : undefined
                            }
                            disabled={!l.committed}
                            className={
                              "flex w-full flex-col items-stretch gap-0.5 rounded px-2 py-1 text-left text-[12.5px] transition " +
                              (activeId === l.id
                                ? "bg-[var(--primary)]/20 text-[var(--primary)]"
                                : l.committed
                                  ? "text-[var(--sidebar-foreground)] hover:bg-[var(--sidebar-accent)]"
                                  : "cursor-not-allowed text-[var(--muted-foreground)]/80")
                            }
                          >
                            <div className="flex items-center gap-1.5">
                              <StatusIcon status={l.status} />
                              <FileText
                                className={
                                  "h-3 w-3 " +
                                  (l.committed
                                    ? "text-sky-300"
                                    : "text-[var(--muted-foreground)]")
                                }
                              />
                              <span
                                className={
                                  "flex-1 truncate " +
                                  (!l.committed ? "italic opacity-80" : "")
                                }
                              >
                                {l.title}
                              </span>
                            </div>
                            {deps.length > 0 ? (
                              <div
                                title={deps
                                  .map((d) => d.title)
                                  .join(" • ")}
                                className="ml-[1.125rem] flex items-center gap-1 text-[10.5px] leading-tight text-[var(--muted-foreground)]"
                              >
                                <Link2 className="h-2.5 w-2.5 shrink-0" />
                                <span className="truncate">
                                  depends on{" "}
                                  {deps
                                    .slice(0, 2)
                                    .map((d) => d.title)
                                    .join(", ")}
                                  {deps.length > 2
                                    ? ` +${deps.length - 2}`
                                    : ""}
                                </span>
                              </div>
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
              );
            })}
          </ul>
        </div>
      )}
    </aside>
  );
}

function StatusIcon({ status }: { status: TreeLesson["status"] }) {
  switch (status) {
    case "done":
      return <CheckCircle2 className="h-3 w-3 text-[var(--success)]" />;
    case "writing":
      return <Loader2 className="h-3 w-3 animate-spin text-[var(--primary)]" />;
    case "failed":
      return <AlertCircle className="h-3 w-3 text-[var(--destructive)]" />;
    default:
      return <Circle className="h-3 w-3 text-[var(--muted-foreground)]" />;
  }
}

interface TreeLesson {
  id: string;
  title: string;
  status: ManifestItem["status"];
  committed: boolean;
  /**
   * Lesson UUIDs this lesson explicitly builds on. Sourced from
   * `lesson.depends_on` on the snapshot row and from
   * `ManifestItem.depends_on` on in-flight rows. Drives the inline
   * "depends on …" line under the lesson title.
   */
  dependsOn: string[];
}

interface TreeChapter {
  id: string;
  title: string;
  lessons: TreeLesson[];
}

interface MergedTree {
  chapters: TreeChapter[];
  /**
   * Flat lookup of every lesson currently displayed in the tree by id
   * so the FileTree can render dep chip titles ("depends on Lesson
   * 1.3") without walking the whole tree per row.
   */
  lessonsById: Map<string, { id: string; title: string }>;
}

/**
 * Merge committed snapshot + in-flight manifest into one display tree.
 * Committed lessons take priority (they have real DB ids and are clickable);
 * in-flight manifest entries appear as pending/writing/failed leaves.
 *
 * The manifest doesn't carry a chapter_id (the agent commits chapters before
 * lessons, so chapter rows arrive via Realtime first). We key in-flight items
 * by `chapter_title` and fall back to a "Pending" bucket if even that's
 * missing.
 */
function mergeTree(
  snapshot: SyllabusSnapshot | null,
  manifest: ManifestItem[],
): MergedTree {
  const chapters = new Map<string, TreeChapter>();
  for (const c of snapshot?.chapters ?? []) {
    chapters.set(c.id, {
      id: c.id,
      title: c.title,
      lessons: c.lessons.map((l) => ({
        id: l.id,
        title: l.title,
        status: "done",
        committed: true,
        dependsOn: l.depends_on ?? [],
      })),
    });
  }

  const titleToId = new Map<string, string>();
  for (const c of chapters.values()) titleToId.set(c.title, c.id);

  const pendingByTitle = new Map<string, TreeChapter>();

  for (const m of manifest) {
    const title = m.chapter_title ?? "Pending";
    let bucket: TreeChapter | undefined;
    const committedId = titleToId.get(title);
    if (committedId) {
      bucket = chapters.get(committedId);
    } else {
      bucket = pendingByTitle.get(title);
      if (!bucket) {
        bucket = { id: `pending:${title}`, title, lessons: [] };
        pendingByTitle.set(title, bucket);
      }
    }
    if (!bucket) continue;

    const existing = bucket.lessons.find((l) => l.id === m.id);
    if (existing) {
      // Don't overwrite a committed lesson with a stale pending status.
      if (!existing.committed) {
        existing.title = m.title;
        existing.status = m.status;
      }
      // Manifest carries fresher dep data while in-flight (the
      // snapshot lags Realtime); merge it in so the chips render as
      // soon as the supervisor seeds the plan.
      if (m.depends_on && m.depends_on.length > 0) {
        existing.dependsOn = m.depends_on;
      }
    } else {
      bucket.lessons.push({
        id: m.id,
        title: m.title,
        status: m.status,
        committed: false,
        dependsOn: m.depends_on ?? [],
      });
    }
  }

  const treeChapters = [...chapters.values(), ...pendingByTitle.values()];
  const lessonsById = new Map<string, { id: string; title: string }>();
  for (const c of treeChapters) {
    for (const l of c.lessons) {
      lessonsById.set(l.id, { id: l.id, title: l.title });
    }
  }

  return { chapters: treeChapters, lessonsById };
}

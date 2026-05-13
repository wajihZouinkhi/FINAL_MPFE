"use client";

import { useEffect, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  BookText,
  FileText,
  Sparkles,
  ChevronRight,
  ChevronLeft,
  ArrowLeft,
} from "lucide-react";
import type { SyllabusSnapshot, LessonRow, ChapterRow } from "@mpfe/shared";
import { useAgentStore } from "../stores/agent-store";
import {
  ChapterContractHeader,
  LessonContractHeader,
  SyllabusContractHeader,
} from "./contract-chips";

/**
 * Right pane viewer. Three modes:
 *   • Lesson — clicked from the FileTree or chapter list. Renders markdown
 *     with sticky breadcrumb + prev/next pagination across the whole
 *     syllabus.
 *   • Chapter summary — chapter highlighted but no lesson chosen. Shows
 *     chapter title + description + lesson list (clickable).
 *   • Overview (default) — syllabus title + description + chapter cards
 *     with lesson lists (the global TOC).
 */
export function Viewer({
  snapshot,
}: {
  snapshot: SyllabusSnapshot | null;
}) {
  const activeLessonId = useAgentStore((s) => s.active_lesson_id);
  const activeChapterId = useAgentStore((s) => s.active_chapter_id);
  const setActiveLesson = useAgentStore((s) => s.setActiveLesson);
  const setActiveChapter = useAgentStore((s) => s.setActiveChapter);
  const cacheLesson = useAgentStore((s) => s.cacheLesson);
  const cache = useAgentStore((s) => s.lesson_cache);

  // Flat ordered list of all committed lessons across the syllabus —
  // basis for prev/next pagination inside lesson view.
  const flatLessons = useMemo(() => {
    if (!snapshot) return [] as { lesson: LessonRow; chapter: ChapterRow }[];
    const out: { lesson: LessonRow; chapter: ChapterRow }[] = [];
    for (const c of snapshot.chapters) {
      for (const l of c.lessons) {
        out.push({ lesson: l as LessonRow, chapter: c as ChapterRow });
      }
    }
    return out;
  }, [snapshot]);

  const found = useMemo(() => {
    if (!activeLessonId) return null;
    return flatLessons.find((x) => x.lesson.id === activeLessonId) ?? null;
  }, [flatLessons, activeLessonId]);

  // Hydrate the cache the first time we have content for a lesson.
  useEffect(() => {
    if (!snapshot) return;
    for (const c of snapshot.chapters) {
      for (const l of c.lessons) {
        if (l.content && cache[l.id] !== l.content) {
          cacheLesson(l.id, l.content);
        }
      }
    }
    // We intentionally exclude `cache` from deps — we only want this to
    // run when the snapshot tree changes, not on every cache write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);

  const activeChapter = useMemo(() => {
    if (!snapshot || !activeChapterId) return null;
    return (
      (snapshot.chapters.find((c) => c.id === activeChapterId) as
        | ChapterRow
        | undefined) ?? null
    );
  }, [snapshot, activeChapterId]);

  if (found) {
    const idx = flatLessons.findIndex((x) => x.lesson.id === found.lesson.id);
    const prev = idx > 0 ? flatLessons[idx - 1] : null;
    const next = idx < flatLessons.length - 1 ? flatLessons[idx + 1] : null;
    const content = cache[found.lesson.id] ?? found.lesson.content ?? "";

    // Resolve the lesson's depends_on UUIDs to titles + chapter labels
    // by walking the snapshot. The chip row in the contract header
    // renders one chip per resolved dep (and skips entries that don't
    // resolve, which happens for stale rows whose deps were re-keyed
    // by a fresh syllabus build). Click navigates the Viewer to the
    // dep lesson via the same store action the Pager / FileTree use.
    const dependencies = (found.lesson.depends_on ?? [])
      .map((depId) => {
        const hit = flatLessons.find((x) => x.lesson.id === depId);
        if (!hit) return null;
        return {
          id: hit.lesson.id,
          title: hit.lesson.title,
          chapterTitle: hit.chapter.title,
        };
      })
      .filter(
        (
          d,
        ): d is { id: string; title: string; chapterTitle: string } => d !== null,
      );

    return (
      <div className="flex h-full min-h-0 flex-col bg-[var(--background)]">
        <header className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--card)]/80 px-4 py-3 backdrop-blur sm:px-5">
          <button
            type="button"
            onClick={() => setActiveLesson(null)}
            className="inline-flex items-center gap-1 rounded-md px-1 text-[12px] text-[var(--muted-foreground)] transition hover:text-[var(--secondary)]"
            title="Back to syllabus overview"
          >
            <ArrowLeft className="h-3 w-3" />
            <span className="hidden sm:inline">
              {snapshot?.syllabus?.title ?? "Syllabus"}
            </span>
            <span className="sm:hidden">Back</span>
          </button>
          <ChevronRight className="hidden h-3 w-3 text-[var(--muted-foreground)] sm:block" />
          <button
            type="button"
            onClick={() => setActiveChapter(found.chapter.id)}
            className="hidden truncate text-[12px] text-[var(--muted-foreground)] transition hover:text-[var(--secondary)] sm:block"
          >
            {found.chapter.title}
          </button>
          <ChevronRight className="hidden h-3 w-3 text-[var(--muted-foreground)] sm:block" />
          <span className="ml-auto truncate text-[12.5px] font-medium text-[var(--secondary)] sm:ml-0">
            {found.lesson.title}
          </span>
          <span className="ml-auto shrink-0 font-mono text-[10.5px] text-[var(--muted-foreground)]">
            {idx + 1}/{flatLessons.length}
          </span>
        </header>
        <article className="md mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-5 py-6 animate-fade-in sm:px-8 sm:py-8">
          <LessonContractHeader
            // `key` forces a fresh component instance per lesson so
            // per-lesson local state — if any is reintroduced later —
            // doesn't leak across prev/next navigation.
            key={found.lesson.id}
            lesson={found.lesson}
            audience={snapshot?.syllabus?.audience ?? null}
            dependencies={dependencies}
            onPickLesson={(id) => setActiveLesson(id)}
          />
          <Lesson content={content} />
          <Pager prev={prev} next={next} onPick={(id) => setActiveLesson(id)} />
        </article>
      </div>
    );
  }

  if (activeChapter) {
    const chapterIdx = snapshot
      ? snapshot.chapters.findIndex((c) => c.id === activeChapter.id)
      : -1;
    const lessons = snapshot
      ? (snapshot.chapters[chapterIdx]?.lessons ?? [])
      : [];
    return (
      <div className="flex h-full min-h-0 flex-col bg-[var(--background)]">
        <header className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--card)]/80 px-4 py-3 backdrop-blur sm:px-5">
          <button
            type="button"
            onClick={() => setActiveChapter(null)}
            className="inline-flex items-center gap-1 rounded-md px-1 text-[12px] text-[var(--muted-foreground)] transition hover:text-[var(--secondary)]"
          >
            <ArrowLeft className="h-3 w-3" />
            <span>{snapshot?.syllabus?.title ?? "Syllabus"}</span>
          </button>
          <ChevronRight className="h-3 w-3 text-[var(--muted-foreground)]" />
          <span className="truncate text-[12.5px] font-medium text-[var(--secondary)]">
            {activeChapter.title}
          </span>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-6 sm:px-8 sm:py-8">
          <div className="mx-auto max-w-3xl animate-fade-in">
            <span className="font-mono text-[10.5px] uppercase tracking-wider text-[var(--muted-foreground)]">
              Chapter {chapterIdx + 1} · {lessons.length} lesson
              {lessons.length === 1 ? "" : "s"}
            </span>
            <h1 className="mt-1 text-[1.65rem] font-semibold tracking-tight text-[var(--primary)]">
              {activeChapter.title}
            </h1>
            <p className="mt-3 text-[14px] leading-relaxed text-[var(--muted-foreground)]">
              A summary of every lesson in this chapter. Click any lesson to
              read its full markdown — the content is cached locally so
              switching back is instant.
            </p>
            <div className="mt-6">
              <ChapterContractHeader
                chapter={activeChapter}
                lessons={lessons as LessonRow[]}
              />
            </div>
            <ul className="mt-2 space-y-2">
              {lessons.map((l, i) => (
                <li key={l.id}>
                  <button
                    type="button"
                    onClick={() => setActiveLesson(l.id)}
                    className="group flex w-full items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)]/60 p-3.5 text-left transition hover:border-[var(--primary)]/40 hover:bg-[var(--card)]"
                  >
                    <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--secondary)]/10 font-mono text-[11px] text-[var(--secondary)]">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-medium text-[var(--foreground)] group-hover:text-[var(--secondary)]">
                        {l.title}
                      </div>
                      <div className="mt-0.5 line-clamp-2 text-[12px] text-[var(--muted-foreground)]">
                        {firstParagraph(l.content)}
                      </div>
                    </div>
                    <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-[var(--muted-foreground)] transition group-hover:translate-x-0.5 group-hover:text-[var(--primary)]" />
                  </button>
                </li>
              ))}
              {lessons.length === 0 ? (
                <li className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--card)]/40 px-4 py-3 text-[12.5px] text-[var(--muted-foreground)]">
                  No committed lessons in this chapter yet.
                </li>
              ) : null}
            </ul>
          </div>
        </div>
      </div>
    );
  }

  // Default — syllabus overview.
  return (
    <div className="h-full min-h-0 overflow-y-auto bg-[var(--background)]">
      <div className="mx-auto max-w-3xl px-5 py-6 sm:px-8 sm:py-10">
        {snapshot?.syllabus ? (
          <>
            <header className="mb-6 flex items-center gap-3 animate-fade-in">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--primary)]/15 ring-1 ring-[var(--primary)]/30">
                <BookText className="h-5 w-5 text-[var(--primary)]" />
              </span>
              <div className="min-w-0">
                <h1 className="truncate text-2xl font-semibold tracking-tight">
                  {snapshot.syllabus.title}
                </h1>
                <span className="font-mono text-[10.5px] uppercase tracking-wider text-[var(--muted-foreground)]">
                  syllabus overview · {snapshot.chapters.length} chapter
                  {snapshot.chapters.length === 1 ? "" : "s"} ·{" "}
                  {flatLessons.length} lesson
                  {flatLessons.length === 1 ? "" : "s"}
                </span>
              </div>
            </header>
            {snapshot.syllabus.description ? (
              <p className="mb-7 text-[14.5px] leading-relaxed text-[var(--muted-foreground)]">
                {snapshot.syllabus.description}
              </p>
            ) : null}
            <SyllabusContractHeader
              syllabus={snapshot.syllabus}
              totalDurationMin={flatLessons.reduce(
                (n, x) => n + (x.lesson.duration_min ?? 0),
                0,
              )}
            />
            <ol className="space-y-4">
              {snapshot.chapters.map((c, i) => (
                <li
                  key={c.id}
                  className="group rounded-xl border border-[var(--border)] bg-[var(--card)]/60 p-4 transition hover:border-[var(--primary)]/40"
                >
                  <button
                    type="button"
                    onClick={() => setActiveChapter(c.id)}
                    className="flex w-full items-baseline gap-2 text-left"
                  >
                    <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--muted-foreground)]">
                      Chapter {i + 1}
                    </span>
                    <span className="ml-auto rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">
                      {c.lessons.length} lesson
                      {c.lessons.length === 1 ? "" : "s"}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveChapter(c.id)}
                    className="mt-1 block w-full text-left text-[15.5px] font-semibold text-[var(--foreground)] transition group-hover:text-[var(--primary)]"
                  >
                    {c.title}
                  </button>
                  <ul className="mt-3 grid grid-cols-1 gap-1 sm:grid-cols-2">
                    {c.lessons.map((l) => (
                      <li key={l.id}>
                        <button
                          type="button"
                          onClick={() => setActiveLesson(l.id)}
                          className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[12.5px] text-[var(--foreground)]/85 transition hover:bg-[var(--accent)]/40 hover:text-[var(--secondary)]"
                        >
                          <FileText className="h-3 w-3 text-sky-300" />
                          <span className="truncate">{l.title}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
            {snapshot.chapters.length === 0 ? (
              <p className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--card)]/40 px-4 py-3 text-[13px] text-[var(--muted-foreground)]">
                Waiting for the agent to commit chapters…
              </p>
            ) : null}
          </>
        ) : (
          <div className="flex h-[60vh] flex-col items-center justify-center text-center text-[var(--muted-foreground)] animate-fade-in">
            <span className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--secondary)]/15 ring-1 ring-[var(--secondary)]/30">
              <Sparkles className="h-6 w-6 text-[var(--secondary)]" />
            </span>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">
              No syllabus yet
            </h2>
            <p className="mt-2 max-w-md text-[13.5px] leading-relaxed">
              Ask the agent in the chat to build one. As chapters and lessons
              are committed they&apos;ll appear in the file tree on the left,
              and the lesson content will render here.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Render lesson markdown. Uses the same `react-markdown` plumbing as the
 * chat bubbles but with viewer-specific typography (`.md` global class).
 */
function Lesson({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
  );
}

/**
 * Lightweight prev/next pagination at the foot of a lesson. Clicking
 * either button updates the active lesson — the cache then makes the
 * swap feel instant.
 */
function Pager({
  prev,
  next,
  onPick,
}: {
  prev: { lesson: LessonRow; chapter: ChapterRow } | null;
  next: { lesson: LessonRow; chapter: ChapterRow } | null;
  onPick: (id: string) => void;
}) {
  if (!prev && !next) return null;
  return (
    <nav className="mt-10 grid grid-cols-1 gap-3 border-t border-[var(--border)] pt-6 sm:grid-cols-2">
      {prev ? (
        <button
          type="button"
          onClick={() => onPick(prev.lesson.id)}
          className="group flex w-full items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)]/60 p-3 text-left transition hover:border-[var(--primary)]/40 hover:bg-[var(--card)]"
        >
          <ChevronLeft className="h-4 w-4 text-[var(--muted-foreground)] transition group-hover:-translate-x-0.5 group-hover:text-[var(--primary)]" />
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--muted-foreground)]">
              Previous · {prev.chapter.title}
            </div>
            <div className="truncate text-[13px] font-medium text-[var(--foreground)] group-hover:text-[var(--secondary)]">
              {prev.lesson.title}
            </div>
          </div>
        </button>
      ) : (
        <span className="hidden sm:block" />
      )}
      {next ? (
        <button
          type="button"
          onClick={() => onPick(next.lesson.id)}
          className="group flex w-full items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)]/60 p-3 text-right transition hover:border-[var(--primary)]/40 hover:bg-[var(--card)] sm:justify-end"
        >
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--muted-foreground)]">
              Next · {next.chapter.title}
            </div>
            <div className="truncate text-[13px] font-medium text-[var(--foreground)] group-hover:text-[var(--secondary)]">
              {next.lesson.title}
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-[var(--muted-foreground)] transition group-hover:translate-x-0.5 group-hover:text-[var(--primary)]" />
        </button>
      ) : null}
    </nav>
  );
}

function firstParagraph(content: string | null | undefined): string {
  if (!content) return "No preview yet.";
  // Drop fenced code, then take the first non-empty body line that isn't a
  // heading or blockquote — those are typically just the lesson title.
  const lines = content
    .replace(/```[\s\S]*?```/g, "")
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s && !/^#+\s/.test(s) && !/^>\s/.test(s));
  return lines[0]?.slice(0, 240) ?? "No preview yet.";
}

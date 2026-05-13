"use client";

/**
 * Read-only syllabus viewer used as the click-through target for
 * `<artifact kind="syllabus" id="…" />` chips emitted by the
 * deep-agent supervisor.
 *
 * Reuses the existing `FileTree` + `Viewer` components — same
 * three-column layout the syllabus thread page uses, minus the chat
 * pane. The components are state-driven via `useAgentStore`
 * (`active_lesson_id` / `active_chapter_id`), which is per-tab
 * Zustand state, so dropping them onto a fresh route works without
 * any additional plumbing — we just need to:
 *
 *   1. fetch the snapshot by syllabus id (NOT thread id, because the
 *      chip only carries the syllabus id),
 *   2. reset the agent store on mount so any prior thread navigation
 *      doesn't leak active-lesson state into this view,
 *   3. mount `FileTree` + `Viewer` with the snapshot.
 *
 * The "back" affordance routes to the originating thread when
 * available — the snapshot's `thread_id` is the thread that produced
 * this syllabus. Useful so the user can return to the deep-agent
 * conversation that built it.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, BookText, Menu, X } from "lucide-react";
import type { SyllabusSnapshot } from "@mpfe/shared";
import { FileTree } from "../../../components/file-tree";
import { Viewer } from "../../../components/viewer";
import { useAgentStore } from "../../../stores/agent-store";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface Props {
  syllabusId: string;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; snapshot: SyllabusSnapshot }
  | { kind: "missing" }
  | { kind: "error"; message: string };

export default function SyllabusViewerPage({ syllabusId }: Props) {
  const reset = useAgentStore((s) => s.reset);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [treeOpen, setTreeOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Fresh page → start from a clean store. Otherwise an old
    // active_lesson_id from a thread tab can flash into the viewer
    // before this snapshot's lessons hydrate.
    reset();
    fetch(`${API}/api/syllabuses/${syllabusId}/snapshot`)
      .then(async (r) => {
        if (cancelled) return;
        if (r.status === 404) {
          setState({ kind: "missing" });
          return;
        }
        if (!r.ok) {
          setState({ kind: "error", message: `HTTP ${r.status}` });
          return;
        }
        const snap = (await r.json()) as SyllabusSnapshot;
        setState({ kind: "ok", snapshot: snap });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: e instanceof Error ? e.message : "Failed to load",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [syllabusId, reset]);

  // Document title — mirrors the per-thread title in dispatch.tsx so
  // multi-tab users can tell what each tab is showing.
  useEffect(() => {
    if (state.kind !== "ok") return;
    const title = state.snapshot.syllabus?.title ?? "Syllabus";
    const previous = document.title;
    document.title = `${title} — FINAL_MPFE`;
    return () => {
      document.title = previous;
    };
  }, [state]);

  if (state.kind === "loading") {
    return (
      <div className="flex h-dvh items-center justify-center text-[12.5px] text-[var(--muted-foreground)]">
        Loading syllabus…
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="flex h-dvh items-center justify-center text-[12.5px] text-[var(--destructive)]">
        Couldn't load syllabus: {state.message}
      </div>
    );
  }
  if (state.kind === "missing") {
    return <NotFound syllabusId={syllabusId} />;
  }

  const snapshot = state.snapshot;
  const originThreadId = snapshot.thread_id;
  const title = snapshot.syllabus?.title ?? "Syllabus";

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[var(--background)]">
      {/* Mobile/tablet top bar — desktop uses the 2-col grid below. */}
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--card)]/40 px-3 py-2 lg:hidden">
        <Link
          href={originThreadId ? `/threads/${originThreadId}` : "/threads"}
          aria-label="Back to thread"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)] transition hover:text-[var(--primary)]"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <button
          type="button"
          onClick={() => setTreeOpen((v) => !v)}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)] transition hover:text-[var(--primary)]"
          aria-label="Toggle syllabus tree"
        >
          {treeOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
        </button>
        <div className="ml-1 flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[12px] font-semibold text-[var(--foreground)]">
            {title}
          </span>
          <span className="font-mono text-[10px] text-[var(--muted-foreground)]">
            <BookText className="mr-1 inline h-3 w-3" />
            read-only
          </span>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 overflow-hidden lg:grid lg:grid-cols-[260px_minmax(0,1fr)]">
        {/* FileTree — desktop column / mobile drawer */}
        <div
          className={
            "h-full min-h-0 lg:block " +
            "absolute inset-y-0 left-0 z-30 w-[82%] max-w-[300px] transform border-r border-[var(--border)] bg-[var(--sidebar-background)] transition-transform duration-200 ease-out shadow-2xl " +
            (treeOpen ? "translate-x-0" : "-translate-x-full") +
            " lg:relative lg:w-auto lg:max-w-none lg:translate-x-0 lg:shadow-none"
          }
        >
          <FileTree snapshot={snapshot} />
        </div>
        {treeOpen ? (
          <button
            type="button"
            aria-label="Close tree"
            onClick={() => setTreeOpen(false)}
            className="absolute inset-0 z-20 bg-black/40 lg:hidden"
          />
        ) : null}

        {/* Viewer pane (read-only — no thread id, so the lesson
            "Mark reviewed" affordance is hidden by the Viewer's
            optional-threadId guard). */}
        <div className="h-full min-h-0 w-full lg:w-auto">
          <Viewer snapshot={snapshot} />
        </div>
      </div>
    </div>
  );
}

function NotFound({ syllabusId }: { syllabusId: string }) {
  return (
    <div className="flex h-dvh items-center justify-center bg-[var(--background)]">
      <div className="max-w-md rounded-xl border border-[var(--border)] bg-[var(--card)] p-6 text-center">
        <h1 className="text-[15px] font-semibold text-[var(--foreground)]">
          Syllabus not found
        </h1>
        <p className="mt-2 text-[12.5px] text-[var(--muted-foreground)]">
          The syllabus you're looking for doesn't exist or was removed.
        </p>
        <p className="mt-3 font-mono text-[10.5px] text-[var(--muted-foreground)]">
          id: {syllabusId}
        </p>
        <Link
          href="/threads"
          className="mt-5 inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-[12px] text-[var(--foreground)] transition hover:border-[var(--primary)]/50"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to threads
        </Link>
      </div>
    </div>
  );
}

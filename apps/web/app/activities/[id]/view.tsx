"use client";

/**
 * Read-only worksheet viewer used as the click-through target for
 * `<artifact kind="worksheet" id="…" />` chips emitted by the
 * deep-agent supervisor.
 *
 * Wraps the existing `ActivityWorksheet` component (the one rendered
 * in the activity-thread feed) with a minimal page chrome — back
 * link to the originating thread, page title, the worksheet itself.
 *
 * The deep-agent worksheets aren't tagged with `agent:
 * "activity-generator-tooled" / "-toolless"` (they're produced by
 * the deep-agent's `activity_maker` subagent, which uses MCP for
 * grounding when bound to a lesson). We pass `"activity-generator-
 * tooled"` for the visual styling — same wrench/grounded badge,
 * which matches the lesson-aware authoring flow more closely than
 * the toolless baseline. This is purely cosmetic; the row's actual
 * data and grading are identical regardless of the agent tag.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { ActivityRow } from "@mpfe/shared";
import { ActivityWorksheet } from "../../../components/activities/activity-worksheet";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface Props {
  activityId: string;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; row: ActivityRow }
  | { kind: "missing" }
  | { kind: "error"; message: string };

export default function ActivityViewerPage({ activityId }: Props) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/api/activities/${activityId}`)
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
        const row = (await r.json()) as ActivityRow;
        setState({ kind: "ok", row });
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
  }, [activityId]);

  useEffect(() => {
    if (state.kind !== "ok") return;
    const w = state.row.content as { title?: string };
    const title = w.title?.trim() || state.row.lesson_title || "Worksheet";
    const previous = document.title;
    document.title = `${title} — FINAL_MPFE`;
    return () => {
      document.title = previous;
    };
  }, [state]);

  if (state.kind === "loading") {
    return (
      <div className="flex h-dvh items-center justify-center text-[12.5px] text-[var(--muted-foreground)]">
        Loading worksheet…
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="flex h-dvh items-center justify-center text-[12.5px] text-[var(--destructive)]">
        Couldn't load worksheet: {state.message}
      </div>
    );
  }
  if (state.kind === "missing") {
    return <NotFound activityId={activityId} />;
  }

  const row = state.row;
  const originThreadId = row.thread_id;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[var(--background)]">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--card)]/40 px-4 py-2.5">
        <Link
          href={originThreadId ? `/threads/${originThreadId}` : "/threads"}
          aria-label="Back to thread"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)] transition hover:text-[var(--primary)]"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="ml-1 flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[12.5px] font-semibold text-[var(--foreground)]">
            Worksheet
          </span>
          <span className="font-mono text-[10px] text-[var(--muted-foreground)]">
            id {row.id.slice(0, 8)}
          </span>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-4 py-5 sm:px-6 sm:py-6">
        <div className="mx-auto w-full max-w-3xl">
          <ActivityWorksheet row={row} agent="activity-generator-tooled" />
        </div>
      </main>
    </div>
  );
}

function NotFound({ activityId }: { activityId: string }) {
  return (
    <div className="flex h-dvh items-center justify-center bg-[var(--background)]">
      <div className="max-w-md rounded-xl border border-[var(--border)] bg-[var(--card)] p-6 text-center">
        <h1 className="text-[15px] font-semibold text-[var(--foreground)]">
          Worksheet not found
        </h1>
        <p className="mt-2 text-[12.5px] text-[var(--muted-foreground)]">
          The worksheet you're looking for doesn't exist or was removed.
        </p>
        <p className="mt-3 font-mono text-[10.5px] text-[var(--muted-foreground)]">
          id: {activityId}
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

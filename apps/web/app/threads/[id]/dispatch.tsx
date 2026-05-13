"use client";

import { useEffect, useState } from "react";
import type { AgentKind } from "@mpfe/shared";
import ThreadView from "./view";
import ActivityThreadView from "./activity-view";
import DeepAgentThreadView from "./deepagent-view";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

// Short, glanceable per-agent label for the document title (audit §3.10).
const AGENT_TITLE_LABEL: Record<AgentKind, string> = {
  "syllabus-generator": "Syllabus",
  "activity-generator-tooled": "Worksheet (grounded)",
  "activity-generator-toolless": "Worksheet",
  deepagent: "Deep Agent",
};

/**
 * Read the thread's agent kind once, then mount the matching view.
 * Syllabus threads (default for back-compat) use the original
 * three-pane FileTree + Viewer shell; activity threads use the
 * two-pane chat + worksheet feed shell.
 */
export default function ThreadDispatch({ threadId }: { threadId: string }) {
  const [meta, setMeta] = useState<{
    agent: AgentKind;
    bound_syllabus_thread_id: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/api/chat/${threadId}/state`)
      .then((r) => r.json())
      .then((s: { agent?: AgentKind; bound_syllabus_thread_id?: string | null }) => {
        if (cancelled) return;
        setMeta({
          agent: (s.agent ?? "syllabus-generator") as AgentKind,
          bound_syllabus_thread_id: s.bound_syllabus_thread_id ?? null,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  // Audit §3.10: set document.title per thread so multi-tab users can
  // tell which kind of agent each tab is running. The short id suffix
  // matches the conversation header so tabs and headers agree. Reset
  // on unmount so the threads index / docs pages don't inherit a
  // stale per-thread title.
  useEffect(() => {
    if (!meta) return;
    const label = AGENT_TITLE_LABEL[meta.agent] ?? "Thread";
    const idSlug = threadId.slice(0, 8);
    const previous = document.title;
    document.title = `${label} · ${idSlug} — FINAL_MPFE`;
    return () => {
      document.title = previous;
    };
  }, [meta, threadId]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-[12.5px] text-[var(--destructive)]">
        Couldn't load thread: {error}
      </div>
    );
  }
  if (!meta) {
    return (
      <div className="flex h-full items-center justify-center text-[12.5px] text-[var(--muted-foreground)]">
        Loading thread…
      </div>
    );
  }
  if (meta.agent === "syllabus-generator") {
    return <ThreadView threadId={threadId} />;
  }
  if (meta.agent === "deepagent") {
    return <DeepAgentThreadView threadId={threadId} />;
  }
  return (
    <ActivityThreadView
      threadId={threadId}
      agent={meta.agent}
      boundSyllabusThreadId={meta.bound_syllabus_thread_id}
    />
  );
}

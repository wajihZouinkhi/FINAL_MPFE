"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { MpfeUIMessage } from "../../../lib/ui-message";
import { ArrowLeft, MessageSquare, BookText, Menu, X } from "lucide-react";
import type {
  AgentInterrupt,
  AgentPhase,
  ManifestItem,
  ResearchPlan,
  RunSnapshot,
  SyllabusSnapshot,
  TodoPlan,
} from "@mpfe/shared";
import { ChatPane } from "../../../components/chat/chat-pane";
import { FileTree } from "../../../components/file-tree";
import { Viewer } from "../../../components/viewer";
import { useSyllabusRealtime } from "../../../lib/realtime";
import { useAgentRunRealtime } from "../../../lib/agent-run-realtime";
import { useAgentStore } from "../../../stores/agent-store";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

type MobileTab = "chat" | "viewer";

interface PersistedState {
  phase: AgentPhase | null;
  research_plan: ResearchPlan | null;
  todo_plan: TodoPlan | null;
  manifest: ManifestItem[];
  interrupt: AgentInterrupt | null;
  interrupt_history: AgentInterrupt[];
  messages: Array<{ role: string; content: string }>;
  latest_run: RunSnapshot | null;
  research_anchor_msg_index: number | null;
  todo_anchor_msg_index: number | null;
}

interface Hydrated {
  snapshot: SyllabusSnapshot | null;
  initialMessages: MpfeUIMessage[];
  initialAgentState: PersistedState;
}

export default function ThreadView({ threadId }: { threadId: string }) {
  const [hydrated, setHydrated] = useState<Hydrated | null>(null);
  const reset = useAgentStore((s) => s.reset);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`${API}/api/threads/${threadId}/snapshot`).then((r) => r.json()),
      fetch(`${API}/api/chat/${threadId}/state`).then((r) => r.json()),
    ])
      .then(([snap, state]: [SyllabusSnapshot, PersistedState]) => {
        if (cancelled) return;
        // v5 UIMessage shape: each message has a `parts: UIMessagePart[]`
        // array (no `content` field). Hydrate every persisted turn so
        // server-side anchor indices (research/todo/worksheet) resolve
        // against the same array positions the API used. Tool messages
        // get an empty text part so `MessageRow` can skip them; the
        // syllabus graph today never produces tool/empty-AI turns but
        // this keeps the hydrate behaviour consistent with activity.
        const initialMessages: MpfeUIMessage[] = (state.messages ?? []).map(
          (m, i) => ({
            id: `hist-${i}`,
            role: m.role === "human" ? "user" : "assistant",
            parts: [
              {
                type: "text",
                text: m.role === "tool" ? "" : m.content,
              },
            ],
          }),
        );
        // Hydrate the agent store from persisted state so reload-mid-run
        // shows the right cards immediately. `latest_run` is the
        // server-side lifecycle row — without it we can't tell a thread
        // that's still running from one that crashed (the LangGraph
        // checkpointer's `phase` is never reverted on failure).
        reset({
          phase: state.phase ?? "idle",
          research_plan: state.research_plan ?? null,
          todo_plan: state.todo_plan ?? null,
          manifest: state.manifest ?? [],
          interrupt: state.interrupt ?? null,
          interrupt_history: state.interrupt_history ?? [],
          latest_run: state.latest_run ?? null,
          research_anchor_msg_index: state.research_anchor_msg_index ?? null,
          todo_anchor_msg_index: state.todo_anchor_msg_index ?? null,
        });
        setHydrated({
          snapshot: snap,
          initialMessages,
          initialAgentState: state,
        });
      })
      .catch(() => {
        if (cancelled) return;
        reset();
        setHydrated({
          snapshot: null,
          initialMessages: [],
          initialAgentState: {
            phase: "idle",
            research_plan: null,
            todo_plan: null,
            manifest: [],
            interrupt: null,
            interrupt_history: [],
            messages: [],
            latest_run: null,
            research_anchor_msg_index: null,
            todo_anchor_msg_index: null,
          },
        });
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, reset]);

  if (!hydrated) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">
        Loading thread…
      </div>
    );
  }

  return <ThreadShell threadId={threadId} hydrated={hydrated} />;
}

function ThreadShell({
  threadId,
  hydrated,
}: {
  threadId: string;
  hydrated: Hydrated;
}) {
  const snapshot = useSyllabusRealtime(threadId, hydrated.snapshot);
  // Subscribe to server-side lifecycle + per-slice events so the chat
  // UI reflects runs that this tab didn't drive (other tabs, reaper-
  // driven failures, queued runs once Phase 1 ships).
  useAgentRunRealtime(threadId);
  const [tab, setTab] = useState<MobileTab>("chat");
  const [treeOpen, setTreeOpen] = useState(false); // mobile drawer

  const activeLessonId = useAgentStore((s) => s.active_lesson_id);
  const activeChapterId = useAgentStore((s) => s.active_chapter_id);

  // Auto-switch to viewer on small screens when the user picks a lesson/chapter.
  useEffect(() => {
    if (activeLessonId || activeChapterId) {
      setTab("viewer");
      setTreeOpen(false);
    }
  }, [activeLessonId, activeChapterId]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[var(--background)]">
      {/* Mobile/tablet top bar (lg+ shows nothing — desktop uses 3-col grid below). */}
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--card)]/40 px-3 py-2 lg:hidden">
        <Link
          href="/threads"
          aria-label="Back to all threads"
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
            {snapshot?.syllabus?.title ?? "Master PFE"}
          </span>
          <span className="font-mono text-[10px] text-[var(--muted-foreground)]">
            thread {threadId.slice(0, 8)}
          </span>
        </div>
        <nav className="ml-auto flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--card)] p-0.5">
          <TabButton
            active={tab === "chat"}
            onClick={() => setTab("chat")}
            icon={<MessageSquare className="h-3.5 w-3.5" />}
            label="Chat"
          />
          <TabButton
            active={tab === "viewer"}
            onClick={() => setTab("viewer")}
            icon={<BookText className="h-3.5 w-3.5" />}
            label="Read"
          />
        </nav>
      </header>

      <div className="relative flex min-h-0 flex-1 overflow-hidden lg:grid lg:grid-cols-[260px_minmax(0,1fr)_minmax(0,1.1fr)]">
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

        {/* Chat pane */}
        <div
          className={
            "h-full min-h-0 w-full lg:w-auto lg:block " +
            (tab === "chat" ? "block" : "hidden")
          }
        >
          <ChatPane
            threadId={threadId}
            initialMessages={hydrated.initialMessages}
          />
        </div>

        {/* Viewer pane */}
        <div
          className={
            "h-full min-h-0 w-full lg:w-auto lg:block " +
            (tab === "viewer" ? "block" : "hidden")
          }
        >
          <Viewer snapshot={snapshot} />
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] font-medium transition " +
        (active
          ? "bg-[var(--primary)] text-[var(--primary-foreground)] shadow-sm"
          : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]")
      }
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

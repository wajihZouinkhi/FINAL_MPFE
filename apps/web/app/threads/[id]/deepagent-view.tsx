"use client";

/**
 * `agent === "deepagent"` thread view — chat pane + canvas.
 *
 * Two-pane layout (chat left, canvas right) on desktop with a tab
 * switcher on mobile, mirroring the activity-view shell. The canvas
 * surfaces the deepagents virtual filesystem and the per-task
 * subagent activity panel — both populated from the agent store
 * (live via the chat-pane's `onData` and `useAgentRunRealtime`,
 * cold via `/state` hydration here).
 */
import { useEffect, useState } from "react";
import { FolderTree, MessageSquare } from "lucide-react";
import type {
  RunSnapshot,
  SubagentRun,
  SubagentToolCall,
} from "@mpfe/shared";
import type { MpfeUIMessage } from "../../../lib/ui-message";
import { ChatPane } from "../../../components/chat/chat-pane";
import { DeepAgentCanvas } from "../../../components/threads/deepagent-canvas";
import { useAgentRunRealtime } from "../../../lib/agent-run-realtime";
import { useAgentStore } from "../../../stores/agent-store";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface SupervisorToolCallSnapshot {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "ok" | "error";
  preview: string | null;
  anchor_msg_index: number | null;
}

interface ChatState {
  messages?: Array<{ role: string; content: string }>;
  vfs?: Record<string, string>;
  subagent_runs?: SubagentRun[];
  subagent_tool_calls?: SubagentToolCall[];
  supervisor_tool_calls?: SupervisorToolCallSnapshot[];
  latest_run?: RunSnapshot | null;
}

type DeepAgentTab = "chat" | "canvas";

export default function DeepAgentThreadView({
  threadId,
}: {
  threadId: string;
}) {
  const [hydrated, setHydrated] = useState<{
    initialMessages: MpfeUIMessage[];
  } | null>(null);
  const [tab, setTab] = useState<DeepAgentTab>("chat");
  const reset = useAgentStore((s) => s.reset);
  const setVfs = useAgentStore((s) => s.setVfs);
  const setSubagentRuns = useAgentStore((s) => s.setSubagentRuns);
  const setSubagentToolCalls = useAgentStore(
    (s) => s.setSubagentToolCalls,
  );
  const setLiveToolCalls = useAgentStore((s) => s.setLiveToolCalls);
  const setLatestRun = useAgentStore((s) => s.setLatestRun);
  // Mobile-only: any code path that wants the user to see the canvas
  // bumps `canvas_focus_request.counter`. We watch the counter and
  // flip the outer `Chat | Canvas` switcher to "canvas" on every
  // bump. On `lg:` and up the grid renders both panes side-by-side
  // and `tab` is irrelevant, so the same effect is a no-op for the
  // user even though it still runs.
  const canvasFocusCounter = useAgentStore(
    (s) => s.canvas_focus_request?.counter ?? 0,
  );

  // Follower-tab + post-disconnect resume channel: opens a long-
  // lived GET /stream that replays missed events and follows live.
  // Mirrors the activity-view / syllabus-view shells. The driver
  // tab (the one that POSTed the human turn) gets the same data
  // through useChat's onData and ignores duplicate updates here.
  useAgentRunRealtime(threadId);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/api/chat/${threadId}/state`)
      .then((r) => r.json())
      .then((state: ChatState) => {
        if (cancelled) return;
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
        // Reset clears every store slice; we then push the canvas
        // hydration explicitly so the panels render immediately on
        // tab reload (live updates take over via onData / realtime).
        reset();
        if (state.vfs) setVfs(state.vfs);
        if (state.subagent_runs) setSubagentRuns(state.subagent_runs);
        if (state.subagent_tool_calls)
          setSubagentToolCalls(state.subagent_tool_calls);
        // Hydrate the supervisor's tool-call chips. Walked from the
        // LangGraph checkpoint so write_todos / vfs / `task` chips
        // come back to the chat after a page refresh — without this
        // the in-memory `live_tool_calls` store would be empty on
        // mount and reload would silently drop every chip the user
        // saw stream live in the previous session.
        if (state.supervisor_tool_calls) {
          setLiveToolCalls(
            state.supervisor_tool_calls.map((c) => ({
              id: c.id,
              name: c.name,
              node: "deepagent_supervisor",
              call_index: 0,
              args_buffer: "",
              args: c.args,
              status: c.status,
              preview: c.preview,
              duration_ms: null,
              error: null,
              anchor_msg_index: c.anchor_msg_index,
            })),
          );
        }
        if (state.latest_run !== undefined) setLatestRun(state.latest_run);
        setHydrated({ initialMessages });
      })
      .catch(() => {
        if (cancelled) return;
        reset();
        setHydrated({ initialMessages: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [
    threadId,
    reset,
    setVfs,
    setSubagentRuns,
    setSubagentToolCalls,
    setLiveToolCalls,
    setLatestRun,
  ]);

  // Watch `canvas_focus_request.counter` for any user gesture that
  // wants the canvas in view (artifact chip click, TaskCard click,
  // …). Skip the cold-mount value 0 so the page doesn't open on
  // the canvas tab — only post-mount bumps switch tabs.
  useEffect(() => {
    if (canvasFocusCounter > 0) setTab("canvas");
  }, [canvasFocusCounter]);

  if (!hydrated) {
    return (
      <div className="flex h-full items-center justify-center text-[12.5px] text-[var(--muted-foreground)]">
        Loading conversation…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <nav className="flex shrink-0 items-center gap-1 border-b border-[var(--border)] bg-[var(--card)]/40 px-2 py-1.5 lg:hidden">
        <DeepAgentTabButton
          active={tab === "chat"}
          onClick={() => setTab("chat")}
          icon={<MessageSquare className="h-3.5 w-3.5" />}
          label="Chat"
        />
        <DeepAgentTabButton
          active={tab === "canvas"}
          onClick={() => setTab("canvas")}
          icon={<FolderTree className="h-3.5 w-3.5" />}
          label="Canvas"
        />
      </nav>
      <div className="relative flex min-h-0 flex-1 overflow-hidden lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div
          className={
            "h-full min-h-0 w-full lg:block " +
            (tab === "chat" ? "block" : "hidden")
          }
        >
          <ChatPane
            threadId={threadId}
            initialMessages={hydrated.initialMessages}
            agent="deepagent"
          />
        </div>
        <div
          className={
            "h-full min-h-0 w-full lg:block " +
            (tab === "canvas" ? "block" : "hidden")
          }
        >
          <DeepAgentCanvas />
        </div>
      </div>
    </div>
  );
}

function DeepAgentTabButton({
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
        "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] font-medium ring-1 transition-colors " +
        (active
          ? "bg-[var(--primary)]/15 text-[var(--primary)] ring-[var(--primary)]/30"
          : "bg-transparent text-[var(--muted-foreground)] ring-transparent hover:bg-[var(--muted)]/40")
      }
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

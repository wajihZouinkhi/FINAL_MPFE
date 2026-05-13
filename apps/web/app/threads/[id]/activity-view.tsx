"use client";

import { useEffect, useMemo, useState } from "react";
import type { MpfeUIMessage } from "../../../lib/ui-message";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Loader2,
  MessageSquare,
  Sparkles,
  Wrench,
  Ban,
  X,
  XCircle,
} from "lucide-react";
import type {
  ActivityRow,
  ActivityManifestItem,
  ActivityToolCall,
  ActivityWorksheetEmission,
  AgentKind,
  AgentPhase,
  RunSnapshot,
  Worksheet,
} from "@mpfe/shared";
import { Worksheet as WorksheetSchema } from "@mpfe/shared";
import { ChatPane } from "../../../components/chat/chat-pane";
import { ActivityWorksheet } from "../../../components/activities/activity-worksheet";
import { useAgentRunRealtime } from "../../../lib/agent-run-realtime";
import { useAgentStore } from "../../../stores/agent-store";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface ActivityState {
  thread_id: string;
  agent: AgentKind;
  bound_syllabus_thread_id: string | null;
  activities: ActivityRow[];
}

interface ChatState {
  phase: AgentPhase | null;
  messages: Array<{ role: string; content: string }>;
  activity_manifest?: ActivityManifestItem[];
  activity_tool_calls?: ActivityToolCall[];
  activity_worksheets?: import("@mpfe/shared").ActivityWorksheetEmission[];
  // Activity agents now use the same interrupt machinery as the
  // syllabus side (kind="activity_intake" and kind="ask"). Hydrate
  // both so the intake card / Q&A trail survive reload.
  interrupt?: import("@mpfe/shared").AgentInterrupt | null;
  interrupt_history?: import("@mpfe/shared").AgentInterrupt[];
  latest_run: RunSnapshot | null;
}

/**
 * Thread page for activity-generator agents (tooled or toolless).
 * Two-pane layout: chat on the left, activities feed on the right.
 * No file tree, no syllabus snapshot.
 *
 * Activities are loaded once via /api/threads/:id/activities and then
 * appended via the chat-pane's `activity_manifest` data part — when a
 * new manifest item flips to status="ready", we refetch the row from
 * Supabase (the manifest doesn't carry the full content, only the
 * status). Cheaper than streaming the whole worksheet through the SSE
 * channel and keeps Supabase as the single source of truth.
 */
export default function ActivityThreadView({
  threadId,
  agent,
  boundSyllabusThreadId,
}: {
  threadId: string;
  agent: AgentKind;
  boundSyllabusThreadId: string | null;
}) {
  const [hydrated, setHydrated] = useState<{
    initialMessages: MpfeUIMessage[];
    initial: ActivityState | null;
  } | null>(null);
  const reset = useAgentStore((s) => s.reset);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`${API}/api/threads/${threadId}/activities`).then((r) => r.json()),
      fetch(`${API}/api/chat/${threadId}/state`).then((r) => r.json()),
    ])
      .then(([acts, state]: [ActivityState, ChatState]) => {
        if (cancelled) return;
        // v5 UIMessage shape: each message has a `parts: UIMessagePart[]`
        // array (no `content` field). Hydrate every persisted turn —
        // tool messages and empty-content AI messages (tool-call-only
        // turns) are kept in the array so server-side `anchor_msg_index`
        // pointers (worksheets, tool calls) still resolve. The render
        // loop hides them visually by skipping `MessageRow` when the
        // bubble would be empty, so the user sees a clean transcript
        // while inline cards (tool chips, worksheet card) anchor to
        // the right indices.
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
        reset({
          phase: state.phase ?? "idle",
          activity_manifest: state.activity_manifest ?? [],
          activity_tool_calls: state.activity_tool_calls ?? [],
          activity_worksheets: state.activity_worksheets ?? [],
          interrupt: state.interrupt ?? null,
          interrupt_history: state.interrupt_history ?? [],
          latest_run: state.latest_run ?? null,
        });
        setHydrated({ initialMessages, initial: acts });
      })
      .catch(() => {
        if (cancelled) return;
        reset();
        setHydrated({ initialMessages: [], initial: null });
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, reset]);

  if (!hydrated) {
    return (
      <div className="flex h-full items-center justify-center text-[12.5px] text-[var(--muted-foreground)]">
        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
        Loading thread…
      </div>
    );
  }

  return (
    <ActivityShell
      threadId={threadId}
      agent={agent}
      boundSyllabusThreadId={boundSyllabusThreadId}
      hydrated={hydrated}
    />
  );
}

function ActivityShell({
  threadId,
  agent,
  boundSyllabusThreadId,
  hydrated,
}: {
  threadId: string;
  agent: AgentKind;
  boundSyllabusThreadId: string | null;
  hydrated: { initialMessages: MpfeUIMessage[]; initial: ActivityState | null };
}) {
  useAgentRunRealtime(threadId);
  const manifest = useAgentStore((s) => s.activity_manifest);
  const toolCalls = useAgentStore((s) => s.activity_tool_calls);
  const [rows, setRows] = useState<ActivityRow[]>(
    hydrated.initial?.activities ?? [],
  );
  const [tab, setTab] = useState<"chat" | "viewer">("chat");

  // When the manifest reports a new "ready" item we don't already have
  // a row for, refetch the activities snapshot so the worksheet body
  // (which isn't in the manifest) shows up.
  const knownIds = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  const newReady = useMemo(
    () =>
      (manifest ?? []).filter(
        (m) => m.status === "ready" && !knownIds.has(m.activity_id),
      ),
    [manifest, knownIds],
  );
  useEffect(() => {
    if (newReady.length === 0) return;
    let cancelled = false;
    fetch(`${API}/api/threads/${threadId}/activities`)
      .then((r) => r.json() as Promise<ActivityState>)
      .then((s) => {
        if (cancelled) return;
        setRows(s.activities ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [newReady.length, threadId]);

  // Auto-jump to viewer on small screens when a new worksheet lands
  useEffect(() => {
    if (rows.length > 0 && tab === "chat" && newReady.length > 0) {
      setTab("viewer");
    }
  }, [rows.length, newReady.length, tab]);

  const grounded = agent === "activity-generator-tooled";

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[var(--background)]">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--card)]/40 px-3 py-2 lg:px-5">
        <span
          className={
            "inline-flex h-7 w-7 items-center justify-center rounded-md ring-1 " +
            (grounded
              ? "bg-emerald-400/15 text-emerald-300 ring-emerald-400/30"
              : "bg-amber-400/15 text-amber-300 ring-amber-400/30")
          }
        >
          {grounded ? (
            <Wrench className="h-3.5 w-3.5" />
          ) : (
            <Ban className="h-3.5 w-3.5" />
          )}
        </span>
        <div className="ml-1 flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[12.5px] font-semibold text-[var(--foreground)]">
            {grounded
              ? "Activity generator (with tools · MCP)"
              : "Activity generator (no tools)"}
          </span>
          <span className="font-mono text-[10px] text-[var(--muted-foreground)]">
            thread {threadId.slice(0, 8)}
            {boundSyllabusThreadId
              ? ` · bound → ${boundSyllabusThreadId.slice(0, 8)}`
              : ""}
          </span>
        </div>
        <nav className="ml-auto flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--card)] p-0.5 lg:hidden">
          <TabButton
            active={tab === "chat"}
            onClick={() => setTab("chat")}
            icon={<MessageSquare className="h-3.5 w-3.5" />}
            label="Chat"
          />
          <TabButton
            active={tab === "viewer"}
            onClick={() => setTab("viewer")}
            icon={<BookOpen className="h-3.5 w-3.5" />}
            label="Worksheets"
          />
        </nav>
      </header>

      <div className="relative flex min-h-0 flex-1 overflow-hidden lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div
          className={
            "h-full min-h-0 w-full lg:w-auto lg:block " +
            (tab === "chat" ? "block" : "hidden")
          }
        >
          <ChatPane
            threadId={threadId}
            initialMessages={hydrated.initialMessages}
            agent={agent}
          />
        </div>
        <div
          className={
            "h-full min-h-0 w-full overflow-y-auto lg:hidden " +
            (tab === "viewer" ? "block" : "hidden")
          }
        >
          <ActivityFeed
            rows={rows}
            manifest={manifest}
            toolCalls={toolCalls}
            agent={agent}
            grounded={grounded}
          />
        </div>
        <div className="hidden h-full min-h-0 lg:block">
          <Workbench
            threadId={threadId}
            agent={agent}
            grounded={grounded}
            manifest={manifest}
            toolCalls={toolCalls}
            rows={rows}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Right-pane workbench (desktop only). Renders the worksheet that the
 * user clicked in the chat as a "tool call" chip. Empty by default —
 * shows a hint until something is selected. Falls back to the live
 * draft / pending / tool-call timeline so the user has feedback while
 * the agent is still generating, even when no chip has been clicked.
 *
 * Why we keep selection in the global agent store rather than local
 * state: the selection is set by `<WorksheetToolCallChip>` (rendered
 * in the chat pane), which doesn't share a parent with this component.
 * Persisting the id in zustand gives both panes a single source of
 * truth and survives any in-thread navigation.
 */
function Workbench({
  threadId,
  agent,
  grounded,
  manifest,
  toolCalls,
  rows,
}: {
  threadId: string;
  agent: AgentKind;
  grounded: boolean;
  manifest: ActivityManifestItem[];
  toolCalls: ActivityToolCall[];
  rows: ActivityRow[];
}) {
  const selectedId = useAgentStore((s) => s.selected_worksheet_activity_id);
  const setSelected = useAgentStore((s) => s.setSelectedWorksheet);
  const worksheets = useAgentStore((s) => s.activity_worksheets);

  const selected = useMemo(
    () => worksheets.find((w) => w.activity_id === selectedId) ?? null,
    [worksheets, selectedId],
  );
  const selectedRow = useMemo(
    () => buildRowFromEmission(selected, threadId),
    [selected, threadId],
  );

  // Pending state — a worksheet is being drafted right now. We render
  // it on the workbench so the user sees something happening even when
  // nothing has been clicked yet (otherwise the draft is invisible
  // until a chip lands in chat).
  const knownIds = new Set(rows.map((r) => r.id));
  const pending = manifest.filter(
    (m) => !knownIds.has(m.activity_id) && m.status !== "ready",
  );
  const livePending = pending[0] ?? null;
  const showToolCalls = grounded && toolCalls.length > 0 && pending.length > 0;

  if (selected && selectedRow) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--card)]/40 px-5 py-2.5">
          <span className="font-mono text-[10.5px] uppercase tracking-wide text-[var(--muted-foreground)]">
            emit_worksheet
          </span>
          <span className="text-[var(--muted-foreground)]">·</span>
          <span className="truncate text-[12.5px] font-medium text-[var(--foreground)]">
            {selected.lesson_title || selectedRow.content.title}
          </span>
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] transition hover:bg-[var(--muted)]/40 hover:text-[var(--foreground)]"
            aria-label="Close worksheet"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <ActivityWorksheet row={selectedRow} agent={agent} />
        </div>
      </div>
    );
  }

  // Nothing selected. Surface live progress if the agent is mid-draft
  // so the workbench isn't completely silent during generation; fall
  // back to a "click a chip" placeholder otherwise.
  if (livePending || showToolCalls) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto p-5">
        <div className="space-y-4">
          {livePending ? <PendingCard item={livePending} /> : null}
          {showToolCalls ? <ToolCallTimeline calls={toolCalls} /> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-md text-center">
        <span className="mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-[var(--secondary)]/15 ring-1 ring-[var(--secondary)]/30">
          <BookOpen className="h-4 w-4 text-[var(--secondary)]" />
        </span>
        <p className="text-[13.5px] font-medium">
          {worksheets.length > 0
            ? "Click a worksheet in chat to open it here."
            : grounded
              ? "Ask for a worksheet — I'll pick a lesson from the bound syllabus and ground it."
              : "Ask for a worksheet — I'll generate it from your prompt only."}
        </p>
        {worksheets.length === 0 ? (
          <p className="mx-auto mt-1.5 max-w-xs text-[11.5px] leading-snug text-[var(--muted-foreground)]">
            {grounded
              ? "Try: \"Make a worksheet on graph traversals for chapter 3.\""
              : "Try: \"Worksheet on graph traversals for first-year CS students.\""}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function buildRowFromEmission(
  emission: ActivityWorksheetEmission | null,
  threadId: string,
): (ActivityRow & { content: Worksheet }) | null {
  if (!emission) return null;
  const parsed = WorksheetSchema.safeParse(emission.worksheet);
  if (!parsed.success) return null;
  return {
    id: emission.activity_id,
    thread_id: threadId,
    lesson_id: emission.lesson_id,
    kind: "worksheet",
    prompt: "",
    lesson_title: emission.lesson_title,
    content: parsed.data,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function ActivityFeed({
  rows,
  manifest,
  toolCalls,
  agent,
  grounded,
}: {
  rows: ActivityRow[];
  manifest: ActivityManifestItem[];
  toolCalls: ActivityToolCall[];
  agent: AgentKind;
  grounded: boolean;
}) {
  const knownIds = new Set(rows.map((r) => r.id));
  const pending = manifest.filter(
    (m) => !knownIds.has(m.activity_id) && m.status !== "ready",
  );
  // Show the tool-call timeline only on the tooled agent and only while
  // there's an active draft — otherwise it lingers above finished
  // worksheets, which is noisy. The trace is preserved in the agent
  // store either way for the live view.
  const showToolCalls = grounded && toolCalls.length > 0 && pending.length > 0;
  if (rows.length === 0 && pending.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-md text-center">
          <span className="mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-[var(--secondary)]/15 ring-1 ring-[var(--secondary)]/30">
            <Sparkles className="h-4 w-4 text-[var(--secondary)]" />
          </span>
          <p className="text-[13.5px] font-medium">
            {grounded
              ? "Ask for a worksheet — I'll pick a lesson from the bound syllabus and ground it."
              : "Ask for a worksheet — I'll generate it from your prompt only."}
          </p>
          <p className="mx-auto mt-1.5 max-w-xs text-[11.5px] leading-snug text-[var(--muted-foreground)]">
            {grounded
              ? "Try: \"Make a worksheet on graph traversals for chapter 3.\""
              : "Try: \"Worksheet on graph traversals for first-year CS students.\""}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-4 p-5">
      {rows.map((r) => (
        <ActivityWorksheet key={r.id} row={r} agent={agent} />
      ))}
      {pending.map((m) => (
        <PendingCard key={m.activity_id} item={m} />
      ))}
      {showToolCalls ? <ToolCallTimeline calls={toolCalls} /> : null}
    </div>
  );
}

function ToolCallTimeline({ calls }: { calls: ActivityToolCall[] }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)]/50 px-5 py-4">
      <div className="mb-3 flex items-center gap-2 text-[11.5px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
        <Wrench className="h-3 w-3" />
        MCP tool calls
      </div>
      <ol className="space-y-2">
        {calls.map((c) => (
          <ToolCallRow key={c.id} call={c} />
        ))}
      </ol>
    </div>
  );
}

function ToolCallRow({ call }: { call: ActivityToolCall }) {
  const argSummary = formatToolArgs(call.args);
  return (
    <li className="rounded-md border border-[var(--border)]/60 bg-[var(--background)]/40 px-3 py-2">
      <div className="flex items-center gap-2 text-[12px]">
        {call.status === "calling" ? (
          <Loader2 className="h-3 w-3 animate-spin text-[var(--primary)]" />
        ) : call.status === "complete" ? (
          <CheckCircle2 className="h-3 w-3 text-emerald-400" />
        ) : (
          <AlertTriangle className="h-3 w-3 text-[var(--destructive)]" />
        )}
        <span className="font-mono text-[11.5px] font-medium">{call.name}</span>
        {argSummary ? (
          <span className="truncate font-mono text-[10.5px] text-[var(--muted-foreground)]">
            {argSummary}
          </span>
        ) : null}
      </div>
      {call.status === "error" && call.error ? (
        <div className="mt-1 text-[11px] text-[var(--destructive)]">
          {call.error}
        </div>
      ) : null}
      {call.status === "complete" && call.result_preview ? (
        <div className="mt-1 line-clamp-2 font-mono text-[10.5px] text-[var(--muted-foreground)]">
          {call.result_preview}
        </div>
      ) : null}
    </li>
  );
}

function formatToolArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ")
    .slice(0, 120);
}

function PendingCard({ item }: { item: ActivityManifestItem }) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--card)]/60 px-5 py-4">
      <div className="flex items-center gap-2 text-[12px] font-medium">
        {item.status === "failed" ? (
          <>
            <XCircle className="h-3.5 w-3.5 text-[var(--destructive)]" />
            <span className="text-[var(--destructive)]">Generation failed</span>
          </>
        ) : (
          <>
            <Loader2 className="h-3 w-3 animate-spin text-[var(--primary)]" />
            <span className="text-[var(--primary)]">Drafting worksheet…</span>
          </>
        )}
      </div>
      <p className="mt-1 truncate text-[11.5px] text-[var(--muted-foreground)]">
        {item.prompt}
      </p>
      {item.error ? (
        <p className="mt-1.5 text-[11px] text-[var(--destructive)]">
          {item.error}
        </p>
      ) : null}
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

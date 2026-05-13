"use client";

/**
 * Deep-agent canvas — Archon-style three-pane companion to the chat.
 *
 * The canvas surfaces three views of an in-flight (or completed)
 * deep-agent run that the chat-pane intentionally hides:
 *
 *  1. **Files** — the deepagents virtual filesystem (VFS) the
 *     supervisor and subagents read/write to. The pedagogy_planner
 *     persists `/pedagogy_plan.md`; the writer mirrors each
 *     persisted lesson to `/lessons/<lesson_id>.md`. The user can
 *     inspect plan + lesson drafts as they're produced, before
 *     they hit Supabase.
 *  2. **Subagents** — per-`task()` activity panel: who was
 *     dispatched, what the supervisor asked of them (the full
 *     description, not the 80-char chip preview), how long the
 *     subagent took, the live thinking buffer, AND every nested
 *     tool call the subagent makes (writer's `create_lesson`,
 *     researcher's `web_search`, …) interleaved under its row.
 *  3. **Artifact** — opened on demand when the user clicks an
 *     `<artifact …/>` chip in the chat. Renders the same syllabus
 *     `<FileTree>+<Viewer>` (kind="syllabus") or
 *     `<ActivityWorksheet>` (kind="worksheet") as the dedicated
 *     standalone routes — but in-place inside the canvas so the
 *     user never has to navigate away from the deepagent thread.
 *
 * Both Files and Subagents are populated from `useAgentStore` slices
 * that the chat pane's `onData` and the realtime hook keep in sync
 * (plus a cold `/state` hydration on mount). The Artifact tab fetches
 * its snapshot directly from `/api/syllabuses/:id/snapshot` /
 * `/api/activities/:id` when the user clicks a chip.
 */

import { memo, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  FileText,
  FolderTree,
  Loader2,
  Menu,
  Plug,
  Users,
  Wrench,
  X,
} from "lucide-react";
import type {
  ActivityRow,
  ArtifactCard,
  SubagentRun,
  SubagentToolCall,
  SyllabusSnapshot,
} from "@mpfe/shared";
import { Markdown } from "../chat/markdown";
import { SubagentToolCallRowCard } from "../chat/tool-call-cards";
import { useAgentStore } from "../../stores/agent-store";
import { FileTree } from "../file-tree";
import { Viewer } from "../viewer";
import { ActivityWorksheet } from "../activities/activity-worksheet";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

type CanvasTab = "files" | "subagents" | "artifact";

export function DeepAgentCanvas({ className }: { className?: string }) {
  const vfs = useAgentStore((s) => s.vfs);
  const subagentRuns = useAgentStore((s) => s.subagent_runs);
  const subagentToolCalls = useAgentStore((s) => s.subagent_tool_calls);
  const activeArtifact = useAgentStore((s) => s.active_artifact);
  const closeArtifact = useAgentStore((s) => s.closeArtifact);
  const canvasFocusRequest = useAgentStore((s) => s.canvas_focus_request);
  const [tab, setTab] = useState<CanvasTab>("files");

  // Auto-jump to the Artifact tab when the chat pane opens one (the
  // tab itself only renders when there is an active selection — so
  // jumping when null would land on an empty tab).
  useEffect(() => {
    if (activeArtifact) setTab("artifact");
  }, [activeArtifact]);

  // If the user closes the artifact while looking at it, fall back to
  // a tab that exists. Subagents is the more interesting default after
  // a deepagent run; Files comes second.
  useEffect(() => {
    if (!activeArtifact && tab === "artifact") {
      setTab(subagentRuns.length > 0 ? "subagents" : "files");
    }
  }, [activeArtifact, tab, subagentRuns.length]);

  // Other surfaces (chat-pane TaskCard, future inline cards…) ask for
  // canvas focus through `canvas_focus_request`. The mobile parent
  // flips its outer `Chat | Canvas` switcher; we sync the inner tab
  // and (for subagents-target requests) scroll the matching row into
  // view once the row has had a chance to mount.
  //
  // Artifact-target requests are already covered by the
  // `active_artifact` effect above — they're accepted here too just
  // to keep the focus contract symmetrical (no-op when the inner
  // tab is already "artifact").
  useEffect(() => {
    if (!canvasFocusRequest) return;
    const target = canvasFocusRequest.target;
    if (target.kind === "subagents") {
      setTab("subagents");
      const callId = target.subagent_call_id;
      if (callId) {
        // Wait one frame so the Subagents tab has mounted the row
        // before we ask the browser to scroll it into view. Without
        // the rAF the element may not yet exist on first paint
        // after a tab swap.
        const raf = requestAnimationFrame(() => {
          const el = document.getElementById(`subagent-run-${callId}`);
          el?.scrollIntoView({ behavior: "smooth", block: "center" });
        });
        return () => cancelAnimationFrame(raf);
      }
    } else if (target.kind === "files") {
      setTab("files");
    } else if (target.kind === "artifact") {
      setTab("artifact");
    }
    // `canvas_focus_request` is replaced as a whole on every bump,
    // so the counter+target identity changing is enough to re-fire
    // the effect; no need to depend on `.counter` separately.
  }, [canvasFocusRequest]);

  // Default-select the first file once the VFS becomes non-empty so
  // the right pane doesn't render the "select a file" hint forever
  // on a thread that's already produced output.
  const paths = useMemo(() => Object.keys(vfs).sort(), [vfs]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const effectiveSelected =
    selectedPath && vfs[selectedPath] !== undefined
      ? selectedPath
      : (paths[0] ?? null);

  // Index nested tool calls by parent task call_id so SubagentRunRow
  // can pluck its slice in O(1) per row rather than O(N×M) overall.
  const toolCallsByCallId = useMemo(() => {
    const m = new Map<string, SubagentToolCall[]>();
    for (const t of subagentToolCalls) {
      const arr = m.get(t.call_id);
      if (arr) arr.push(t);
      else m.set(t.call_id, [t]);
    }
    return m;
  }, [subagentToolCalls]);

  return (
    <section
      className={
        "flex h-full min-h-0 flex-col border-l border-[var(--border)] bg-[var(--card)]/30 " +
        (className ?? "")
      }
    >
      <header className="flex shrink-0 items-center gap-1 border-b border-[var(--border)] bg-[var(--card)]/50 px-2 py-1.5">
        <CanvasTabButton
          active={tab === "files"}
          onClick={() => setTab("files")}
          icon={<FolderTree className="h-3.5 w-3.5" />}
          label="Files"
          count={paths.length}
        />
        <CanvasTabButton
          active={tab === "subagents"}
          onClick={() => setTab("subagents")}
          icon={<Users className="h-3.5 w-3.5" />}
          label="Subagents"
          count={subagentRuns.length}
        />
        {activeArtifact ? (
          <ArtifactTabButton
            active={tab === "artifact"}
            onClick={() => setTab("artifact")}
            card={activeArtifact}
            onClose={closeArtifact}
          />
        ) : null}
      </header>

      {tab === "files" ? (
        <FilesView
          paths={paths}
          vfs={vfs}
          selected={effectiveSelected}
          onSelect={setSelectedPath}
        />
      ) : tab === "subagents" ? (
        <SubagentsView
          runs={subagentRuns}
          toolCallsByCallId={toolCallsByCallId}
        />
      ) : activeArtifact ? (
        <ArtifactView card={activeArtifact} />
      ) : null}
    </section>
  );
}

function CanvasTabButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
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
      <span
        className={
          "rounded-full px-1.5 text-[10px] font-mono " +
          (active
            ? "bg-[var(--primary)]/20 text-[var(--primary)]"
            : "bg-[var(--muted)]/60 text-[var(--muted-foreground)]")
        }
      >
        {count}
      </span>
    </button>
  );
}

/**
 * Tab control for the on-demand Artifact view. Distinct from the
 * generic CanvasTabButton because it carries a close (×) affordance
 * — the Files / Subagents tabs are always present, but Artifact
 * appears only when the user clicks a chip and should be dismissable
 * back to the two-tab default.
 */
function ArtifactTabButton({
  active,
  onClick,
  card,
  onClose,
}: {
  active: boolean;
  onClick: () => void;
  card: ArtifactCard;
  onClose: () => void;
}) {
  const icon =
    card.kind === "syllabus" ? (
      <FolderTree className="h-3.5 w-3.5" />
    ) : card.kind === "worksheet" ? (
      <Plug className="h-3.5 w-3.5" />
    ) : (
      <FileText className="h-3.5 w-3.5" />
    );
  const label = card.title.trim() || ARTIFACT_KIND_LABEL[card.kind];
  return (
    <span
      className={
        "inline-flex items-center gap-1.5 rounded-md py-1 pl-2 pr-1 text-[11.5px] font-medium ring-1 transition-colors " +
        (active
          ? "bg-[var(--primary)]/15 text-[var(--primary)] ring-[var(--primary)]/30"
          : "bg-transparent text-[var(--muted-foreground)] ring-transparent hover:bg-[var(--muted)]/40")
      }
    >
      <button
        type="button"
        onClick={onClick}
        className="inline-flex max-w-[160px] items-center gap-1.5 truncate"
      >
        {icon}
        <span className="truncate">{label}</span>
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close artifact"
        className="ml-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-[var(--muted-foreground)] hover:bg-[var(--muted)]/60 hover:text-[var(--foreground)]"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

const ARTIFACT_KIND_LABEL: Record<ArtifactCard["kind"], string> = {
  syllabus: "Syllabus",
  worksheet: "Worksheet",
  lesson: "Lesson",
};

function FilesView({
  paths,
  vfs,
  selected,
  onSelect,
}: {
  paths: string[];
  vfs: Record<string, string>;
  selected: string | null;
  onSelect: (p: string) => void;
}) {
  if (paths.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-[var(--muted-foreground)]">
        <span>
          The supervisor and subagents will write files here as they work.
        </span>
      </div>
    );
  }
  const content = selected ? (vfs[selected] ?? "") : "";
  return (
    <div className="grid h-full min-h-0 flex-1 grid-cols-[180px_minmax(0,1fr)]">
      <ul className="h-full min-h-0 overflow-y-auto border-r border-[var(--border)] bg-[var(--background)]/40 py-1">
        {paths.map((p) => (
          <li key={p}>
            <button
              type="button"
              onClick={() => onSelect(p)}
              className={
                "block w-full truncate px-2 py-1.5 text-left font-mono text-[11px] " +
                (p === selected
                  ? "bg-[var(--primary)]/15 text-[var(--primary)]"
                  : "text-[var(--muted-foreground)] hover:bg-[var(--muted)]/40 hover:text-[var(--foreground)]")
              }
              title={p}
            >
              {p}
            </button>
          </li>
        ))}
      </ul>
      <FileContent path={selected} content={content} />
    </div>
  );
}

const FileContent = memo(
  function FileContent({
    path,
    content,
  }: {
    path: string | null;
    content: string;
  }) {
    if (!path) {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center text-[11.5px] text-[var(--muted-foreground)]">
          Select a file to preview.
        </div>
      );
    }
    return (
      <div className="h-full min-h-0 overflow-y-auto px-3 py-2">
        <div className="mb-2 flex items-center gap-1.5 font-mono text-[10.5px] text-[var(--muted-foreground)]">
          <FileText className="h-3 w-3" />
          {path}
        </div>
        {content.length === 0 ? (
          <p className="text-[12px] italic text-[var(--muted-foreground)]">
            (empty file)
          </p>
        ) : isMarkdownPath(path) ? (
          <Markdown source={content} />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-[var(--foreground)]">
            {content}
          </pre>
        )}
      </div>
    );
  },
  (a, b) => a.path === b.path && a.content === b.content,
);

function isMarkdownPath(p: string): boolean {
  return p.endsWith(".md") || p.endsWith(".markdown");
}

function SubagentsView({
  runs,
  toolCallsByCallId,
}: {
  runs: SubagentRun[];
  toolCallsByCallId: Map<string, SubagentToolCall[]>;
}) {
  if (runs.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-[var(--muted-foreground)]">
        <span>
          When the supervisor delegates to a subagent, the run will appear here.
        </span>
      </div>
    );
  }
  return (
    <ul className="flex h-full min-h-0 flex-col divide-y divide-[var(--border)] overflow-y-auto">
      {runs.map((r) => (
        <li key={r.call_id}>
          <SubagentRunRow
            run={r}
            toolCalls={toolCallsByCallId.get(r.call_id) ?? EMPTY_TOOL_CALLS}
          />
        </li>
      ))}
    </ul>
  );
}

const EMPTY_TOOL_CALLS: SubagentToolCall[] = [];

function SubagentRunRow({
  run,
  toolCalls,
}: {
  run: SubagentRun;
  toolCalls: SubagentToolCall[];
}) {
  const [expanded, setExpanded] = useState(false);
  // Per-call_id live thinking buffer. Filled by `subagent_text_delta`
  // wire frames as the subagent's LLM call streams. Cleared by the
  // store the moment `run.status` flips to ok/error, at which point
  // `run.output` (the synthesised final answer) takes over below.
  const liveText = useAgentStore(
    (s) => s.subagent_live_text[run.call_id]?.text ?? "",
  );
  const status = run.status;
  const StatusIcon =
    status === "running"
      ? Loader2
      : status === "ok"
        ? CheckCircle2
        : AlertCircle;
  const statusColor =
    status === "running"
      ? "text-[var(--primary)]"
      : status === "ok"
        ? "text-emerald-400"
        : "text-red-400";
  const durLabel =
    typeof run.duration_ms === "number"
      ? formatDuration(run.duration_ms)
      : status === "running"
        ? "running…"
        : "—";
  const showLive = status === "running" && liveText.length > 0;
  const hasToolCalls = toolCalls.length > 0;
  return (
    <div
      // Stable DOM id so the chat-pane TaskCard's onClick can scroll
      // this row into view (`document.getElementById(\`subagent-run-${id}\`)`).
      // The supervisor's `task` tool-call id matches the subagent
      // run's call_id, so the lookup is direct.
      id={`subagent-run-${run.call_id}`}
      role="button"
      tabIndex={0}
      onClick={() => setExpanded((x) => !x)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setExpanded((x) => !x);
        }
      }}
      className="block w-full cursor-pointer px-3 py-2 text-left transition-colors hover:bg-[var(--muted)]/30"
    >
      <div className="flex items-center gap-2">
        <StatusIcon
          className={
            "h-3.5 w-3.5 shrink-0 " +
            statusColor +
            (status === "running" ? " animate-spin" : "")
          }
        />
        <span className="truncate font-mono text-[11.5px] font-semibold text-[var(--foreground)]">
          {run.name}
        </span>
        {hasToolCalls ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--muted)]/60 px-1.5 py-px font-mono text-[9.5px] text-[var(--muted-foreground)]">
            <Wrench className="h-2.5 w-2.5" />
            {toolCalls.length}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 font-mono text-[10.5px] text-[var(--muted-foreground)]">
          {durLabel}
        </span>
      </div>
      <p
        className={
          "mt-1 text-[11.5px] leading-snug text-[var(--muted-foreground)] " +
          (expanded ? "whitespace-pre-wrap" : "line-clamp-2")
        }
      >
        {run.description || "(no description)"}
      </p>
      {showLive ? (
        // Compact live preview (always visible while streaming, even
        // when the row is collapsed) so the user sees the subagent
        // is actively thinking. Scrolls to the latest tokens.
        <SubagentLivePreview text={liveText} expanded={expanded} />
      ) : null}
      {hasToolCalls ? (
        <ul className="mt-2 space-y-1.5">
          {toolCalls.map((t) => (
            <li key={t.tool_call_id}>
              <SubagentToolCallRowCard call={t} expanded={expanded} />
            </li>
          ))}
        </ul>
      ) : null}
      {/* Subagent's final output — always visible once the run
          terminates, not gated on `expanded`. The user's mental model
          (per the supervisor/subagent split): a `task` tool's result
          is "the last message of the subagent's conversation in the
          workbench". Rendering it inline here is what makes the
          workbench feel like a chat (subagent thinking → tool calls →
          final answer) instead of a collapsed activity log. */}
      {!showLive && run.output ? (
        <div className="mt-2 rounded-md border border-[var(--border)] bg-[var(--background)]/40 p-2 text-[11.5px]">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--muted-foreground)]">
            <Bot className="h-2.5 w-2.5" />
            <span>{run.name} · final answer</span>
          </div>
          <Markdown source={run.output} />
        </div>
      ) : null}
      {run.error ? (
        <div className="mt-2 rounded-md border border-red-400/40 bg-red-400/10 p-2 text-[11.5px] text-red-200">
          {run.error}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Live thinking preview rendered inside a running SubagentRunRow.
 *
 * Collapsed rows clamp to a short tail (last ~3 lines) so a long
 * stream doesn't push other rows off-screen. Expanded rows render
 * the full buffer scrollable. Plain text for now — subagents can
 * emit markdown but mid-stream tokens often mean the renderer sees
 * unbalanced fences / partial code blocks, and the chat-pane
 * supervisor stream takes the same plain-text approach for in-flight
 * deltas.
 */
function SubagentLivePreview({
  text,
  expanded,
}: {
  text: string;
  expanded: boolean;
}) {
  return (
    <div className="mt-2 rounded-md border border-[var(--primary)]/30 bg-[var(--primary)]/[0.06] p-2 text-[11.5px]">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--primary)]/80">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        thinking
      </div>
      <pre
        className={
          "whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-[var(--foreground)]/90 " +
          (expanded ? "max-h-72 overflow-auto" : "line-clamp-3")
        }
      >
        {text}
      </pre>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}m ${r}s`;
}

/**
 * Artifact tab body. The chat pane sets `active_artifact` when the
 * user clicks an inline `<artifact … />` chip; this view fetches
 * the corresponding snapshot from the API and reuses the existing
 * standalone-route components (`<FileTree>+<Viewer>` for syllabuses,
 * `<ActivityWorksheet>` for worksheets) — same data-shape so the
 * UX matches the dedicated `/syllabuses/[id]` and `/activities/[id]`
 * pages without forking the renderers.
 *
 * `lesson` kind has no in-canvas viewer yet (matches the original
 * `DeepArtifactCard` toast fallback). The chat pane never sets
 * `active_artifact` for lesson chips so this branch is defensive.
 */
type ArtifactState =
  | { kind: "loading" }
  | { kind: "syllabus"; snapshot: SyllabusSnapshot }
  | { kind: "worksheet"; row: ActivityRow }
  | { kind: "missing" }
  | { kind: "error"; message: string };

function ArtifactView({ card }: { card: ArtifactCard }) {
  const [state, setState] = useState<ArtifactState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    const url =
      card.kind === "syllabus"
        ? `${API}/api/syllabuses/${card.id}/snapshot`
        : card.kind === "worksheet"
          ? `${API}/api/activities/${card.id}`
          : null;
    if (!url) {
      // Lesson kind — no dedicated viewer.
      setState({
        kind: "error",
        message: `No in-canvas viewer for kind "${card.kind}" yet.`,
      });
      return;
    }
    fetch(url)
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
        const data = await r.json();
        if (cancelled) return;
        if (card.kind === "syllabus") {
          setState({ kind: "syllabus", snapshot: data as SyllabusSnapshot });
        } else {
          setState({ kind: "worksheet", row: data as ActivityRow });
        }
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
  }, [card.kind, card.id]);

  if (state.kind === "loading") {
    return (
      <div className="flex flex-1 items-center justify-center text-[12px] text-[var(--muted-foreground)]">
        Loading {card.kind}…
      </div>
    );
  }
  if (state.kind === "missing") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <div className="text-[12.5px] font-semibold text-[var(--foreground)]">
          {ARTIFACT_KIND_LABEL[card.kind]} not found
        </div>
        <div className="mt-1 font-mono text-[10.5px] text-[var(--muted-foreground)]">
          id: {card.id}
        </div>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-[var(--destructive)]">
        Couldn't load {card.kind}: {state.message}
      </div>
    );
  }
  if (state.kind === "syllabus") {
    return <SyllabusArtifactView snapshot={state.snapshot} />;
  }
  // worksheet
  return (
    <div className="h-full min-h-0 overflow-y-auto px-3 py-3">
      <ActivityWorksheet row={state.row} agent="activity-generator-tooled" />
    </div>
  );
}

/**
 * In-canvas syllabus viewer. The standalone `/syllabuses/[id]` page
 * uses a 260px FileTree + 1fr Viewer grid on `lg+` and a slide-in
 * drawer on mobile (the FileTree is hidden by default and toggled
 * via a hamburger button). The previous in-canvas implementation
 * used a hard `grid-cols-[200px_minmax(0,1fr)]` that didn't shrink
 * — at the canvas's effective mobile width (≈ a 375px viewport
 * minus the chat | canvas tab strip) that gave the FileTree 200px
 * and the Viewer ≈ 175px, both unusably narrow. This component
 * mirrors the standalone-page pattern so the in-canvas viewer
 * gets the same drawer treatment on mobile.
 *
 * The viewer renders full-width below `lg`. A small toolbar sits
 * above it with an "Outline" hamburger that opens the FileTree as
 * a slide-in drawer with a backdrop, dismissable by tapping the
 * backdrop or the close button. On `lg+` the toolbar is hidden and
 * the FileTree returns to a static side column.
 */
function SyllabusArtifactView({
  snapshot,
}: {
  snapshot: SyllabusSnapshot;
}) {
  const [treeOpen, setTreeOpen] = useState(false);
  const activeLessonId = useAgentStore((s) => s.active_lesson_id);
  const activeChapterId = useAgentStore((s) => s.active_chapter_id);

  // Mobile UX: when the user picks a lesson or chapter from the
  // drawer, auto-close the drawer so the Viewer becomes visible.
  // Tracks the last-seen ids and closes only on a CHANGE so reopening
  // the drawer mid-read doesn't snap shut on its own. No-op above
  // `lg` because the drawer is always visible there anyway.
  useEffect(() => {
    if (!treeOpen) return;
    setTreeOpen(false);
    // Intentionally exclude `treeOpen` from deps — we only want this
    // to fire when the user PICKS something, not when they open the
    // drawer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLessonId, activeChapterId]);

  return (
    <div className="relative flex h-full min-h-0 flex-1 overflow-hidden lg:grid lg:grid-cols-[220px_minmax(0,1fr)]">
      {/* Mobile drawer toggle — sits above the viewer below `lg`.
          The Files / Subagents / Artifact tab strip already gives
          us a kind of header so we render this as a thin compact
          toolbar with just the toggle button. */}
      <button
        type="button"
        onClick={() => setTreeOpen((v) => !v)}
        className="absolute left-2 top-2 z-30 inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--card)] px-2 text-[11px] font-medium text-[var(--muted-foreground)] shadow-sm transition hover:text-[var(--primary)] lg:hidden"
        aria-label={treeOpen ? "Close outline" : "Open outline"}
      >
        {treeOpen ? <X className="h-3 w-3" /> : <Menu className="h-3 w-3" />}
        <span>{treeOpen ? "Close" : "Outline"}</span>
      </button>

      {/* FileTree — desktop column / mobile drawer. Same shape as
          the standalone /syllabuses/[id] page so the drawer
          behaviour and visual rhythm are consistent. */}
      <div
        className={
          "h-full min-h-0 lg:block " +
          "absolute inset-y-0 left-0 z-20 w-[82%] max-w-[300px] transform overflow-y-auto border-r border-[var(--border)] bg-[var(--sidebar-background)] shadow-2xl transition-transform duration-200 ease-out " +
          (treeOpen ? "translate-x-0" : "-translate-x-full") +
          " lg:relative lg:w-auto lg:max-w-none lg:translate-x-0 lg:shadow-none lg:overflow-y-auto"
        }
      >
        <FileTree snapshot={snapshot} />
      </div>
      {treeOpen ? (
        // Backdrop — clicking dismisses the drawer. `lg:hidden`
        // because on desktop the drawer is the static column and
        // doesn't need a backdrop. z-10 so it sits below the
        // drawer (z-20) and toggle button (z-30).
        <button
          type="button"
          aria-label="Close outline"
          onClick={() => setTreeOpen(false)}
          className="absolute inset-0 z-10 bg-black/40 lg:hidden"
        />
      ) : null}

      {/* Viewer — full width on mobile, right column on `lg+`.
          Below `lg` we reserve 40px at the top so the absolute
          Outline toggle button doesn't overlap the Viewer's own
          header / content. On `lg+` the toggle is hidden so the
          padding collapses. */}
      <div className="h-full min-h-0 w-full overflow-y-auto pt-10 lg:w-auto lg:pt-0">
        <Viewer snapshot={snapshot} />
      </div>
    </div>
  );
}

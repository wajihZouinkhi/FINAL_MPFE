"use client";

/**
 * Manual workspace for one syllabus.
 *
 * Layout: header (back link, syllabus title) + left tree pane
 * (unities/activities accordion with create + generate buttons) +
 * right detail pane (active stream + last generated content).
 *
 * Each level (syllabus / unity / activity) supports `name first,
 * generate second`:
 *   1. type name in the inline form
 *   2. click "Create" → POST /api/{unities,activities} → empty row
 *   3. click "Generate" on the row → POST /:id/generate → SSE
 *      stream renders live in the right pane; on `done`, refresh
 *      the tree so the new body/worksheet is visible.
 *
 * The writer subagent inside each `/generate` pass calls
 * `find_related_activities(syllabus_id, query_text)` before each
 * `create_activity` so duplicate-detection happens server-side
 * without any FE plumbing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  CircleStop,
  FileText,
  Hammer,
  Loader2,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  streamScopedGenerate,
  type DeepAgentChunk,
  type DeepAgentTaskFailureKind,
} from "../../../lib/scoped-generate-sse";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface Activity {
  id: string;
  unity_id: string;
  title: string;
  order_index: number;
  body: string | null;
  worksheet: unknown;
}

interface Unity {
  id: string;
  syllabus_id: string;
  title: string;
  order_index: number;
  activities: Activity[];
}

interface Tree {
  syllabus: {
    id: string;
    title: string;
    description: string;
    thread_id: string | null;
  };
  unities: Unity[];
}

/**
 * One row in the activity timeline (replacement for the old free-form
 * events list). Each row corresponds to a single discrete event from
 * the deep-agent stream and carries enough structured data for the
 * timeline panel to render it richly — name, duration, subagent,
 * failure reason — without re-parsing a generic `message` string.
 *
 * Status semantics:
 *
 *   - `running`  — a `tool-start` / `task-start` was emitted and the
 *                  matching `*-end` hasn't been seen yet. Renders the
 *                  spinner.
 *   - `ok`       — the matching `*-end` arrived with no failure
 *                  signal. Renders an emerald checkmark.
 *   - `failed`   — `task-end` carried `failureKind`, or an `error`
 *                  chunk was emitted, or an in-flight tool/task was
 *                  cancelled by the user. Renders red.
 *   - `info`     — bookkeeping rows (cancellation, done, files-update)
 *                  that don't have a start/end pairing.
 */
type TimelineRow =
  | {
      key: string;
      ts: number;
      kind: "tool";
      status: "running" | "ok" | "failed";
      name: string;
      callId: string;
      subagentName: string | null;
      durationMs: number | null;
      output: string | null;
    }
  | {
      key: string;
      ts: number;
      kind: "task";
      status: "running" | "ok" | "failed";
      subagentName: string;
      callId: string;
      description: string;
      durationMs: number | null;
      output: string | null;
      failureKind: DeepAgentTaskFailureKind | null;
      failureReason: string | null;
    }
  | {
      key: string;
      ts: number;
      kind: "file";
      status: "info";
      paths: string[];
      subagentCallId: string | null;
    }
  | {
      key: string;
      ts: number;
      kind: "info" | "error";
      status: "info" | "failed";
      message: string;
    };

/**
 * Rolling counters surfaced as badges on the timeline panel header so
 * the user gets a one-glance "is the supervisor doing anything"
 * signal even before any text starts streaming.
 */
interface TimelineCounts {
  toolsRunning: number;
  toolsDone: number;
  tasksRunning: number;
  tasksDone: number;
  filesWritten: number;
  failures: number;
}

type ActiveStream =
  | null
  | {
      scope: "syllabuses" | "unities" | "activities";
      entityId: string;
      label: string;
      text: string;
      rows: TimelineRow[];
      counts: TimelineCounts;
      doneOrFailed: boolean;
      ctrl: AbortController;
    };

const emptyCounts = (): TimelineCounts => ({
  toolsRunning: 0,
  toolsDone: 0,
  tasksRunning: 0,
  tasksDone: 0,
  filesWritten: 0,
  failures: 0,
});

interface Props {
  syllabusId: string;
}

export default function ManualWorkspaceView({ syllabusId }: Props) {
  const [tree, setTree] = useState<Tree | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [stream, setStream] = useState<ActiveStream>(null);
  const [viewing, setViewing] = useState<
    | null
    | { kind: "activity"; id: string }
    | { kind: "unity"; id: string }
  >(null);
  // Inline "add unity" / "add activity" form state, keyed by parent id
  // ("__syllabus__" for the syllabus-level add-unity form).
  const [addFormFor, setAddFormFor] = useState<string | null>(null);
  const [addName, setAddName] = useState("");
  const [adding, setAdding] = useState(false);

  const reload = useCallback(() => {
    fetch(`${API}/api/syllabuses/${syllabusId}/tree`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as Tree;
      })
      .then((t) => {
        setTree(t);
        setLoadErr(null);
      })
      .catch((e: unknown) =>
        setLoadErr(e instanceof Error ? e.message : String(e)),
      );
  }, [syllabusId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Document title.
  useEffect(() => {
    if (!tree) return;
    const prev = document.title;
    document.title = `${tree.syllabus.title} — Manual — FINAL_MPFE`;
    return () => {
      document.title = prev;
    };
  }, [tree]);

  const toggle = (uid: string) =>
    setExpanded((m) => ({ ...m, [uid]: !m[uid] }));

  // ─── create handlers ────────────────────────────────────────────────
  const addUnity = async () => {
    if (!tree || !addName.trim()) return;
    setAdding(true);
    try {
      const r = await fetch(`${API}/api/unities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          syllabus_id: tree.syllabus.id,
          title: addName.trim(),
          order_index: tree.unities.length,
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setAddFormFor(null);
      setAddName("");
      reload();
      toast.success("Unity added");
    } catch (e: unknown) {
      toast.error("Create unity failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setAdding(false);
    }
  };

  const addActivity = async (unity: Unity) => {
    if (!addName.trim()) return;
    setAdding(true);
    try {
      const r = await fetch(`${API}/api/activities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          unity_id: unity.id,
          title: addName.trim(),
          order_index: unity.activities.length,
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setAddFormFor(null);
      setAddName("");
      reload();
      toast.success("Activity added");
    } catch (e: unknown) {
      toast.error("Create activity failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setAdding(false);
    }
  };

  // ─── streaming ──────────────────────────────────────────────────────
  const runStream = useCallback(
    async (opts: {
      scope: "syllabuses" | "unities" | "activities";
      entityId: string;
      label: string;
    }) => {
      // Cancel any active stream before starting a new one.
      stream?.ctrl.abort();
      const ctrl = new AbortController();
      setStream({
        scope: opts.scope,
        entityId: opts.entityId,
        label: opts.label,
        text: "",
        rows: [],
        counts: emptyCounts(),
        doneOrFailed: false,
        ctrl,
      });

      const it = streamScopedGenerate({
        apiBase: API,
        scope: opts.scope,
        entityId: opts.entityId,
        signal: ctrl.signal,
      });

      try {
        for await (const chunk of it) {
          setStream((cur) =>
            applyChunk(cur, opts.entityId, opts.scope, chunk),
          );
          if (chunk.type === "done") break;
          if (chunk.type === "error") break;
        }
      } finally {
        // Refresh the tree after the stream ends so any newly-created
        // unities / activities (or populated body / worksheet) show up.
        reload();
      }
    },
    [stream, reload],
  );

  const cancelStream = () => {
    stream?.ctrl.abort();
    setStream((cur) => {
      if (!cur) return cur;
      const now = Date.now();
      // Flush any still-running tool / task rows to a `failed` state
      // with a synthetic cancellation reason so the timeline reflects
      // that the user stopped the run mid-flight rather than the
      // stream silently finishing.
      const counts = { ...cur.counts };
      const flushed: TimelineRow[] = cur.rows.map((r) => {
        if (r.kind === "tool" && r.status === "running") {
          counts.toolsRunning = Math.max(0, counts.toolsRunning - 1);
          counts.failures += 1;
          return { ...r, status: "failed" as const, durationMs: now - r.ts };
        }
        if (r.kind === "task" && r.status === "running") {
          counts.tasksRunning = Math.max(0, counts.tasksRunning - 1);
          counts.failures += 1;
          return {
            ...r,
            status: "failed" as const,
            durationMs: now - r.ts,
            failureKind: "unknown" as DeepAgentTaskFailureKind,
            failureReason: "cancelled by user",
          };
        }
        return r;
      });
      return {
        ...cur,
        rows: [
          ...flushed,
          {
            key: `info:${now}:cancel`,
            ts: now,
            kind: "info",
            status: "info",
            message: "Cancelled by user",
          } satisfies TimelineRow,
        ],
        counts,
        doneOrFailed: true,
      };
    });
  };

  // ─── viewing state ──────────────────────────────────────────────────
  const viewingNode = useMemo(() => {
    if (!viewing || !tree) return null;
    if (viewing.kind === "activity") {
      for (const u of tree.unities) {
        const a = u.activities.find((x) => x.id === viewing.id);
        if (a) return { kind: "activity" as const, activity: a, unity: u };
      }
    } else {
      const u = tree.unities.find((x) => x.id === viewing.id);
      if (u) return { kind: "unity" as const, unity: u };
    }
    return null;
  }, [viewing, tree]);

  if (loadErr) {
    return (
      <div className="flex h-dvh items-center justify-center text-[12.5px] text-[var(--destructive)]">
        Couldn't load syllabus: {loadErr}
      </div>
    );
  }
  if (!tree) {
    return (
      <div className="flex h-dvh items-center justify-center text-[12.5px] text-[var(--muted-foreground)]">
        <Loader2 className="mr-2 h-3 w-3 animate-spin" />
        Loading workspace…
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[var(--background)]">
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--border)] bg-gradient-to-r from-[var(--card)]/70 via-[var(--card)]/40 to-[var(--card)]/20 px-5 py-3.5 backdrop-blur">
        <Link
          href="/manual"
          aria-label="Back to manual workspace index"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)] transition hover:-translate-x-px hover:border-[var(--primary)]/40 hover:text-[var(--primary)]"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[var(--primary)]/30 to-[var(--primary)]/10 ring-1 ring-[var(--primary)]/40 shadow-[0_0_12px_rgba(255,144,108,0.15)]">
          <Hammer className="h-4 w-4 text-[var(--primary)]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[15px] font-semibold tracking-tight">
              {tree.syllabus.title}
            </h1>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--primary)]/30 bg-[var(--primary)]/10 px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-[var(--primary)]">
              Manual
            </span>
          </div>
          <p className="truncate text-[11.5px] text-[var(--muted-foreground)]">
            {tree.syllabus.description || "(no description)"}
          </p>
        </div>
        <button
          onClick={() =>
            runStream({
              scope: "syllabuses",
              entityId: tree.syllabus.id,
              label: `Generate full syllabus: ${tree.syllabus.title}`,
            })
          }
          disabled={!!stream}
          className="inline-flex items-center gap-2 rounded-lg border border-[var(--primary)]/40 bg-gradient-to-br from-[var(--primary)]/20 to-[var(--primary)]/5 px-3.5 py-2 text-[12.5px] font-semibold text-[var(--primary)] transition hover:from-[var(--primary)]/30 hover:to-[var(--primary)]/15 hover:shadow-[0_0_0_4px_rgba(255,144,108,0.10)] disabled:cursor-not-allowed disabled:opacity-40"
          title="Run the supervisor + writer end-to-end on this syllabus"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Generate full syllabus
        </button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        {/* Left: tree */}
        <aside className="min-h-0 overflow-y-auto border-r border-[var(--border)] bg-gradient-to-b from-[var(--card)]/40 to-[var(--card)]/10 p-4">
          {/* Add unity */}
          {addFormFor === "__syllabus__" ? (
            <InlineAddForm
              placeholder="Unity title (e.g. 'Variables & types')"
              value={addName}
              onChange={setAddName}
              busy={adding}
              onSubmit={addUnity}
              onCancel={() => {
                setAddFormFor(null);
                setAddName("");
              }}
            />
          ) : (
            <button
              onClick={() => {
                setAddFormFor("__syllabus__");
                setAddName("");
              }}
              className="group mb-4 inline-flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-[var(--border)] bg-[var(--card)]/30 px-4 py-2.5 text-[13px] font-semibold text-[var(--muted-foreground)] transition-all hover:-translate-y-px hover:border-[var(--primary)] hover:bg-[var(--primary)]/10 hover:text-[var(--primary)] hover:shadow-[0_0_0_4px_rgba(255,144,108,0.08)]"
            >
              <Plus className="h-4 w-4 transition-transform group-hover:rotate-90" />
              Add unity
            </button>
          )}

          {tree.unities.length === 0 ? (
            <div className="mt-2 flex flex-col items-center gap-2 rounded-xl border border-dashed border-[var(--border)] bg-[var(--card)]/20 px-4 py-8 text-center">
              <span className="text-[24px]">📚</span>
              <p className="text-[12.5px] font-medium text-[var(--foreground)]">
                No unities yet
              </p>
              <p className="text-[11px] text-[var(--muted-foreground)]">
                Click <span className="font-semibold text-[var(--primary)]">+ Add unity</span> above to begin.
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {tree.unities.map((u) => {
                const isSelected =
                  viewing?.kind === "unity" && viewing.id === u.id;
                const completedCount = u.activities.filter((a) => !!a.body).length;
                const isStreamingThis =
                  stream?.scope === "unities" && stream?.entityId === u.id;
                return (
                <li
                  key={u.id}
                  className={`overflow-hidden rounded-xl border bg-gradient-to-br from-[var(--card)] to-[var(--card)]/40 shadow-sm transition-all ${
                    isSelected
                      ? "border-[var(--primary)]/60 shadow-[0_0_0_3px_rgba(255,144,108,0.08)]"
                      : isStreamingThis
                        ? "border-[var(--primary)]/40 ring-1 ring-[var(--primary)]/30 animate-pulse"
                        : "border-[var(--border)] hover:border-[var(--primary)]/30 hover:shadow-md"
                  }`}
                >
                  <div className="flex items-center gap-2.5 px-3 py-2.5">
                    <button
                      onClick={() => toggle(u.id)}
                      aria-label="Toggle"
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] transition hover:bg-[var(--muted)]/30 hover:text-[var(--foreground)]"
                    >
                      {expanded[u.id] ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <button
                      onClick={() => setViewing({ kind: "unity", id: u.id })}
                      className={`min-w-0 flex-1 truncate text-left text-[13.5px] font-semibold tracking-tight transition ${
                        isSelected
                          ? "text-[var(--primary)]"
                          : "text-[var(--foreground)] hover:text-[var(--primary)]"
                      }`}
                      title={u.title}
                    >
                      {u.title}
                    </button>
                    <span
                      className={`inline-flex h-5 min-w-[20px] shrink-0 items-center justify-center rounded-full px-1.5 text-[10px] font-semibold tabular-nums ${
                        u.activities.length === 0
                          ? "bg-[var(--muted)]/30 text-[var(--muted-foreground)]"
                          : completedCount === u.activities.length
                            ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/30"
                            : "bg-[var(--primary)]/15 text-[var(--primary)] ring-1 ring-[var(--primary)]/30"
                      }`}
                      title={`${completedCount} of ${u.activities.length} activities generated`}
                    >
                      {u.activities.length === 0
                        ? "0"
                        : `${completedCount}/${u.activities.length}`}
                    </span>
                    <button
                      onClick={() =>
                        runStream({
                          scope: "unities",
                          entityId: u.id,
                          label: `Generate unity: ${u.title}`,
                        })
                      }
                      disabled={!!stream}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--primary)]/30 bg-[var(--primary)]/10 px-2 py-1 text-[11px] font-medium text-[var(--primary)] transition hover:bg-[var(--primary)]/20 hover:shadow-[0_0_0_3px_rgba(255,144,108,0.10)] disabled:cursor-not-allowed disabled:opacity-40"
                      title="Generate activities under this unity (writer calls find_related_activities first)"
                    >
                      {isStreamingThis ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Sparkles className="h-3 w-3" />
                      )}
                      Generate
                    </button>
                  </div>

                  {expanded[u.id] && (
                    <div className="border-t border-[var(--border)] bg-[var(--background)]/40 px-3 py-2.5">
                      {u.activities.length === 0 && addFormFor !== u.id && (
                        <p className="mb-2 px-1 text-[11px] italic text-[var(--muted-foreground)]">
                          No activities yet — add one below.
                        </p>
                      )}
                      <ul className="relative ml-2 space-y-1 border-l-2 border-[var(--border)]/60 pl-3">
                        {u.activities.map((a) => {
                          const aSelected =
                            viewing?.kind === "activity" && viewing.id === a.id;
                          const aStreaming =
                            stream?.scope === "activities" &&
                            stream?.entityId === a.id;
                          const hasWorksheet =
                            !!a.worksheet &&
                            typeof a.worksheet === "object" &&
                            Object.keys(a.worksheet as Record<string, unknown>).length > 0;
                          return (
                          <li
                            key={a.id}
                            className={`group relative flex items-center gap-2 rounded-md px-2 py-1.5 transition ${
                              aSelected
                                ? "bg-[var(--primary)]/10 ring-1 ring-[var(--primary)]/30"
                                : "hover:bg-[var(--muted)]/15"
                            }`}
                          >
                            <span
                              className="absolute -left-3 top-1/2 h-px w-3 bg-[var(--border)]/60"
                              aria-hidden="true"
                            />
                            <span className="shrink-0 text-[14px] leading-none" title={hasWorksheet ? "Has worksheet" : "Body only"}>
                              {hasWorksheet ? "📝" : a.body ? "📖" : "📄"}
                            </span>
                            <button
                              onClick={() =>
                                setViewing({ kind: "activity", id: a.id })
                              }
                              className={`min-w-0 flex-1 truncate text-left text-[12px] transition ${
                                aSelected
                                  ? "font-medium text-[var(--primary)]"
                                  : "text-[var(--foreground)] hover:text-[var(--primary)]"
                              }`}
                              title={a.title}
                            >
                              {a.title}
                            </button>
                            <span
                              className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wide ${
                                aStreaming
                                  ? "bg-[var(--primary)]/20 text-[var(--primary)] ring-1 ring-[var(--primary)]/40"
                                  : a.body
                                    ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30"
                                    : "bg-[var(--muted)]/30 text-[var(--muted-foreground)] ring-1 ring-[var(--border)]"
                              }`}
                              title={
                                aStreaming
                                  ? "Currently generating"
                                  : a.body
                                    ? "Generated"
                                    : "Not generated yet"
                              }
                            >
                              {aStreaming ? "live" : a.body ? "ready" : "empty"}
                            </span>
                            <button
                              onClick={() =>
                                runStream({
                                  scope: "activities",
                                  entityId: a.id,
                                  label: `Generate activity: ${a.title}`,
                                })
                              }
                              disabled={!!stream}
                              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--primary)]/30 bg-[var(--primary)]/5 px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--primary)] transition hover:bg-[var(--primary)]/15 disabled:cursor-not-allowed disabled:opacity-40"
                              title="Generate this activity's body + worksheet (writer calls find_related_activities first)"
                            >
                              {aStreaming ? (
                                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                              ) : (
                                <Sparkles className="h-2.5 w-2.5" />
                              )}
                              Gen
                            </button>
                          </li>
                          );
                        })}
                      </ul>

                      <div className="mt-2 ml-2 pl-3">
                      {addFormFor === u.id ? (
                        <InlineAddForm
                          placeholder="Activity title (e.g. 'Lab: hello world')"
                          value={addName}
                          onChange={setAddName}
                          busy={adding}
                          onSubmit={() => addActivity(u)}
                          onCancel={() => {
                            setAddFormFor(null);
                            setAddName("");
                          }}
                        />
                      ) : (
                        <button
                          onClick={() => {
                            setAddFormFor(u.id);
                            setAddName("");
                          }}
                          className="group inline-flex items-center gap-1.5 rounded-md border border-dashed border-[var(--border)] bg-[var(--card)]/40 px-2.5 py-1 text-[11.5px] font-medium text-[var(--muted-foreground)] transition hover:border-[var(--primary)] hover:bg-[var(--primary)]/10 hover:text-[var(--primary)]"
                        >
                          <Plus className="h-3 w-3 transition-transform group-hover:rotate-90" />
                          Add activity
                        </button>
                      )}
                      </div>
                    </div>
                  )}
                </li>
                );
              })}
            </ul>
          )}
        </aside>

        {/* Right: stream or content viewer */}
        <main className="min-h-0 overflow-y-auto p-4">
          {stream ? (
            <StreamPanel stream={stream} onCancel={cancelStream} />
          ) : viewingNode ? (
            viewingNode.kind === "activity" ? (
              <ActivityViewer
                activity={viewingNode.activity}
                unity={viewingNode.unity}
                onGenerate={() =>
                  runStream({
                    scope: "activities",
                    entityId: viewingNode.activity.id,
                    label: `Generate activity: ${viewingNode.activity.title}`,
                  })
                }
              />
            ) : (
              <UnityViewer
                unity={viewingNode.unity}
                onGenerate={() =>
                  runStream({
                    scope: "unities",
                    entityId: viewingNode.unity.id,
                    label: `Generate unity: ${viewingNode.unity.title}`,
                  })
                }
              />
            )
          ) : (
            <EmptyViewer />
          )}
        </main>
      </div>
    </div>
  );
}

// ─── helpers + sub-components ─────────────────────────────────────────

/**
 * Reducer over the deep-agent SSE stream into the structured timeline
 * model in `ActiveStream`.
 *
 * Key invariants (read this before touching the function):
 *
 *   - A `tool-start` / `task-start` always inserts a NEW row at the
 *     tail in `running` state. The matching `*-end` MUTATES that row
 *     in place (status → ok/failed, durationMs filled, output filled)
 *     instead of appending a second row. This keeps the timeline
 *     one-row-per-tool-call so the user reads top-to-bottom without
 *     duplicates.
 *
 *   - Match by `callId`. Both start and end chunks carry the same
 *     `callId` from the runner (`tool_call_id` from the AIMessage),
 *     so matching is exact, not heuristic. If we receive an end
 *     without a matching start (e.g. SSE reconnect mid-stream), we
 *     still append a synthetic completed row so nothing is silently
 *     dropped.
 *
 *   - The supervisor `text` accumulates into `cur.text` exactly as
 *     before; the timeline does NOT replace the supervisor stream
 *     panel, it sits ALONGSIDE it. F1 deliberately keeps both so
 *     the user can still scrub the supervisor's reasoning prose
 *     while seeing the structured activity below.
 *
 *   - `doneOrFailed` flips to `true` on a terminal `done` or `error`
 *     chunk. The header swaps the spinner for a check or an error
 *     glyph and hides the Cancel button.
 */
function applyChunk(
  cur: ActiveStream,
  entityId: string,
  scope: "syllabuses" | "unities" | "activities",
  chunk: DeepAgentChunk,
): ActiveStream {
  if (!cur || cur.entityId !== entityId || cur.scope !== scope) return cur;
  const now = Date.now();
  const counts = { ...cur.counts };
  switch (chunk.type) {
    case "text-delta":
      return { ...cur, text: cur.text + chunk.delta };
    case "tool-start": {
      counts.toolsRunning += 1;
      const row: TimelineRow = {
        key: `tool:${chunk.callId}`,
        ts: now,
        kind: "tool",
        status: "running",
        name: chunk.name,
        callId: chunk.callId,
        subagentName: null,
        durationMs: null,
        output: null,
      };
      return { ...cur, rows: [...cur.rows, row], counts };
    }
    case "tool-end": {
      // Mutate the matching running row in place; if we didn't see a
      // start (unlikely but possible on reconnect), append a synthetic
      // completed row so the event isn't silently dropped.
      const idx = cur.rows.findIndex(
        (r) => r.kind === "tool" && r.callId === chunk.callId,
      );
      if (idx === -1) {
        counts.toolsDone += 1;
        const row: TimelineRow = {
          key: `tool:${chunk.callId}`,
          ts: now,
          kind: "tool",
          status: "ok",
          name: chunk.name,
          callId: chunk.callId,
          subagentName: null,
          durationMs: null,
          output: chunk.output ?? null,
        };
        return { ...cur, rows: [...cur.rows, row], counts };
      }
      counts.toolsRunning = Math.max(0, counts.toolsRunning - 1);
      counts.toolsDone += 1;
      const existing = cur.rows[idx] as Extract<TimelineRow, { kind: "tool" }>;
      const updated: TimelineRow = {
        ...existing,
        status: "ok",
        durationMs: now - existing.ts,
        output: chunk.output ?? null,
      };
      const rows = cur.rows.slice();
      rows[idx] = updated;
      return { ...cur, rows, counts };
    }
    case "task-start": {
      counts.tasksRunning += 1;
      const row: TimelineRow = {
        key: `task:${chunk.callId}`,
        ts: now,
        kind: "task",
        status: "running",
        subagentName: chunk.subagentName,
        callId: chunk.callId,
        description: chunk.description,
        durationMs: null,
        output: null,
        failureKind: null,
        failureReason: null,
      };
      return { ...cur, rows: [...cur.rows, row], counts };
    }
    case "task-end": {
      const idx = cur.rows.findIndex(
        (r) => r.kind === "task" && r.callId === chunk.callId,
      );
      const failed = !!chunk.failureKind;
      if (failed) counts.failures += 1;
      if (idx === -1) {
        counts.tasksDone += 1;
        const row: TimelineRow = {
          key: `task:${chunk.callId}`,
          ts: now,
          kind: "task",
          status: failed ? "failed" : "ok",
          subagentName: chunk.subagentName,
          callId: chunk.callId,
          description: "",
          durationMs: chunk.durationMs,
          output: chunk.output ?? null,
          failureKind: chunk.failureKind ?? null,
          failureReason: chunk.failureReason ?? null,
        };
        return { ...cur, rows: [...cur.rows, row], counts };
      }
      counts.tasksRunning = Math.max(0, counts.tasksRunning - 1);
      counts.tasksDone += 1;
      const existing = cur.rows[idx] as Extract<TimelineRow, { kind: "task" }>;
      const updated: TimelineRow = {
        ...existing,
        status: failed ? "failed" : "ok",
        durationMs: chunk.durationMs,
        output: chunk.output ?? null,
        failureKind: chunk.failureKind ?? null,
        failureReason: chunk.failureReason ?? null,
      };
      const rows = cur.rows.slice();
      rows[idx] = updated;
      return { ...cur, rows, counts };
    }
    case "files-update": {
      const paths = Object.keys(chunk.files);
      counts.filesWritten += paths.length;
      const row: TimelineRow = {
        key: `file:${now}:${paths.join(",")}`,
        ts: now,
        kind: "file",
        status: "info",
        paths,
        subagentCallId: chunk.subagentCallId ?? null,
      };
      return { ...cur, rows: [...cur.rows, row], counts };
    }
    case "error": {
      counts.failures += 1;
      const row: TimelineRow = {
        key: `error:${now}`,
        ts: now,
        kind: "error",
        status: "failed",
        message: chunk.message,
      };
      return {
        ...cur,
        rows: [...cur.rows, row],
        counts,
        doneOrFailed: true,
      };
    }
    case "done": {
      const row: TimelineRow = {
        key: `done:${now}`,
        ts: now,
        kind: "info",
        status: "info",
        message: "stream complete",
      };
      // Flush any still-running tool/task rows that never received
      // a matching *-end (e.g. the supervisor finished its outer
      // loop without closing them). Mark them as ok so the timeline
      // doesn't keep spinning forever after [DONE].
      const flushed = cur.rows.map((r) => {
        if (r.kind === "tool" && r.status === "running") {
          counts.toolsRunning = Math.max(0, counts.toolsRunning - 1);
          counts.toolsDone += 1;
          return { ...r, status: "ok" as const, durationMs: now - r.ts };
        }
        if (r.kind === "task" && r.status === "running") {
          counts.tasksRunning = Math.max(0, counts.tasksRunning - 1);
          counts.tasksDone += 1;
          return { ...r, status: "ok" as const, durationMs: now - r.ts };
        }
        return r;
      });
      return {
        ...cur,
        rows: [...flushed, row],
        counts,
        doneOrFailed: true,
      };
    }
    default:
      return cur;
  }
}

function InlineAddForm({
  placeholder,
  value,
  onChange,
  busy,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  busy: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mb-2 flex items-center gap-2 rounded-md border border-[var(--primary)]/40 bg-[var(--card)] px-2 py-1.5">
      <input
        autoFocus
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
          if (e.key === "Escape") onCancel();
        }}
        disabled={busy}
        className="min-w-0 flex-1 bg-transparent text-[12px] outline-none"
      />
      <button
        onClick={onSubmit}
        disabled={busy || !value.trim()}
        className="inline-flex items-center gap-1 rounded bg-[var(--primary)] px-2 py-0.5 text-[11px] font-medium text-[var(--primary-foreground)] disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : "Save"}
      </button>
      <button
        onClick={onCancel}
        disabled={busy}
        className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        aria-label="Cancel"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

/**
 * Right-pane view for an in-flight (or just-finished) /generate call.
 *
 * Layout (F1):
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ <header>  label  spinner  [Cancel]  counts             │
 *   ├─────────────────────────────────────────────────────────┤
 *   │ Activity timeline                                       │
 *   │   <row…>  task pedagogy_planner  · running · 4.1 s     │
 *   │   <row…>  tool find_related_activities · ok · 0.7 s    │
 *   │   <row…>  file /pedagogy_plan.md                       │
 *   │   …                                                     │
 *   ├─────────────────────────────────────────────────────────┤
 *   │ Supervisor stream                                       │
 *   │   <prose tokens…>                                       │
 *   └─────────────────────────────────────────────────────────┘
 *
 * The timeline sits ABOVE the supervisor stream so the user sees
 * "something is happening" the moment the first tool fires, instead
 * of staring at the supervisor's blank prose pane for 20-30s while
 * the writer subagent burns through MCP calls.
 */
function StreamPanel({
  stream,
  onCancel,
}: {
  stream: NonNullable<ActiveStream>;
  onCancel: () => void;
}) {
  const textRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef<HTMLDivElement | null>(null);
  // Auto-scroll the streaming text container as deltas arrive.
  useEffect(() => {
    if (textRef.current) {
      textRef.current.scrollTop = textRef.current.scrollHeight;
    }
  }, [stream.text]);
  // Auto-scroll the timeline as new rows append.
  useEffect(() => {
    if (rowsRef.current) {
      rowsRef.current.scrollTop = rowsRef.current.scrollHeight;
    }
  }, [stream.rows.length]);
  const done = stream.doneOrFailed;
  const hasFailure = stream.counts.failures > 0;
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold">
          {done ? (
            hasFailure ? (
              <X className="h-3.5 w-3.5 text-[var(--destructive)]" />
            ) : (
              <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
            )
          ) : (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--primary)]" />
          )}
          {stream.label}
        </h2>
        {!done && (
          <button
            onClick={onCancel}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--muted-foreground)] transition hover:border-[var(--destructive)] hover:text-[var(--destructive)]"
          >
            <CircleStop className="h-3 w-3" />
            Cancel
          </button>
        )}
      </div>

      <TimelineCountsBar counts={stream.counts} done={done} />

      <section className="rounded-md border border-[var(--border)] bg-[var(--card)]/50">
        <header className="border-b border-[var(--border)] px-3 py-1.5 text-[10.5px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
          Activity timeline ({stream.rows.length})
        </header>
        <div
          ref={rowsRef}
          className="max-h-[40dvh] overflow-y-auto divide-y divide-[var(--border)]/60"
        >
          {stream.rows.length === 0 ? (
            <p className="px-3 py-3 text-[11px] text-[var(--muted-foreground)]">
              Waiting for the supervisor to start a tool or dispatch a
              subagent…
            </p>
          ) : (
            stream.rows.map((row) => (
              <TimelineRowView key={row.key} row={row} />
            ))
          )}
        </div>
      </section>

      <section className="rounded-md border border-[var(--border)] bg-[var(--card)]/50">
        <header className="border-b border-[var(--border)] px-3 py-1.5 text-[10.5px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
          Supervisor stream
        </header>
        <div
          ref={textRef}
          className="max-h-[35dvh] overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 text-[12px] leading-relaxed"
        >
          {stream.text ? (
            stream.text
          ) : stream.counts.tasksRunning > 0 ||
            stream.counts.toolsRunning > 0 ? (
            <span className="text-[var(--muted-foreground)]">
              Supervisor is running tools / subagents — see the activity
              timeline above.
            </span>
          ) : (
            <span className="text-[var(--muted-foreground)]">
              Waiting for the first supervisor token…
            </span>
          )}
        </div>
      </section>
    </div>
  );
}

/** Compact badge row under the header showing live tool / task counts. */
function TimelineCountsBar({
  counts,
  done,
}: {
  counts: TimelineCounts;
  done: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
      <CountBadge
        label="tasks"
        running={counts.tasksRunning}
        done={counts.tasksDone}
        tone="violet"
      />
      <CountBadge
        label="tools"
        running={counts.toolsRunning}
        done={counts.toolsDone}
        tone="emerald"
      />
      {counts.filesWritten > 0 && (
        <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 font-medium text-sky-300">
          <FileText className="h-2.5 w-2.5" />
          {counts.filesWritten} file{counts.filesWritten === 1 ? "" : "s"}
        </span>
      )}
      {counts.failures > 0 && (
        <span className="inline-flex items-center gap-1 rounded-full border border-[var(--destructive)]/40 bg-[var(--destructive)]/10 px-2 py-0.5 font-medium text-[var(--destructive)]">
          <X className="h-2.5 w-2.5" />
          {counts.failures} failure{counts.failures === 1 ? "" : "s"}
        </span>
      )}
      {done && counts.failures === 0 && (
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-300">
          <Sparkles className="h-2.5 w-2.5" />
          complete
        </span>
      )}
    </div>
  );
}

function CountBadge({
  label,
  running,
  done,
  tone,
}: {
  label: string;
  running: number;
  done: number;
  tone: "violet" | "emerald";
}) {
  const total = running + done;
  if (total === 0) return null;
  const ring =
    tone === "violet" ? "border-violet-500/30 text-violet-300" : "border-emerald-500/30 text-emerald-300";
  const bg = tone === "violet" ? "bg-violet-500/10" : "bg-emerald-500/10";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border ${ring} ${bg} px-2 py-0.5 font-medium`}
    >
      {label}: {done}
      {running > 0 ? <span>/{total} ({running} live)</span> : <span>/{total}</span>}
    </span>
  );
}

/** Render one row of the activity timeline. */
function TimelineRowView({ row }: { row: TimelineRow }) {
  const time = new Date(row.ts).toLocaleTimeString();
  if (row.kind === "tool") {
    return (
      <div
        className={`flex items-start gap-2 px-3 py-1.5 text-[11.5px] ${
          row.status === "failed"
            ? "bg-[var(--destructive)]/5 text-[var(--destructive)]"
            : "text-[var(--foreground)]"
        }`}
      >
        <RowGlyph status={row.status} kind="tool" />
        <span className="mt-0.5 shrink-0 font-mono text-[9.5px] opacity-60">
          {time}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate">
            <span className="font-medium">tool</span>{" "}
            <span className="font-mono text-emerald-300">{row.name}</span>
            {row.durationMs != null && row.status !== "running" && (
              <span className="ml-2 text-[10.5px] text-[var(--muted-foreground)]">
                · {(row.durationMs / 1000).toFixed(1)}s
              </span>
            )}
          </p>
        </div>
      </div>
    );
  }
  if (row.kind === "task") {
    const desc = row.description.slice(0, 200);
    return (
      <div
        className={`flex items-start gap-2 px-3 py-1.5 text-[11.5px] ${
          row.status === "failed"
            ? "bg-[var(--destructive)]/5 text-[var(--destructive)]"
            : "text-[var(--foreground)]"
        }`}
      >
        <RowGlyph status={row.status} kind="task" />
        <span className="mt-0.5 shrink-0 font-mono text-[9.5px] opacity-60">
          {time}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate">
            <span className="font-medium">subagent</span>{" "}
            <span className="font-mono text-violet-300">{row.subagentName}</span>
            {row.durationMs != null && row.status !== "running" && (
              <span className="ml-2 text-[10.5px] text-[var(--muted-foreground)]">
                · {(row.durationMs / 1000).toFixed(1)}s
              </span>
            )}
          </p>
          {desc && (
            <p className="mt-0.5 truncate text-[10.5px] text-[var(--muted-foreground)]">
              {desc}
              {row.description.length > 200 ? "…" : ""}
            </p>
          )}
          {row.failureKind && (
            <p className="mt-0.5 truncate text-[10.5px] text-[var(--destructive)]">
              {row.failureKind}: {row.failureReason ?? "(no detail)"}
            </p>
          )}
        </div>
      </div>
    );
  }
  if (row.kind === "file") {
    return (
      <div className="flex items-start gap-2 px-3 py-1.5 text-[11.5px] text-sky-300">
        <FileText className="mt-0.5 h-3 w-3" />
        <span className="mt-0.5 shrink-0 font-mono text-[9.5px] opacity-60">
          {time}
        </span>
        <p className="min-w-0 flex-1 truncate font-mono">
          wrote {row.paths.join(", ")}
        </p>
      </div>
    );
  }
  // info / error
  return (
    <div
      className={`flex items-start gap-2 px-3 py-1.5 text-[11.5px] ${
        row.status === "failed"
          ? "text-[var(--destructive)]"
          : "text-[var(--muted-foreground)]"
      }`}
    >
      <RowGlyph status={row.status} kind={row.kind} />
      <span className="mt-0.5 shrink-0 font-mono text-[9.5px] opacity-60">
        {time}
      </span>
      <p className="min-w-0 flex-1 truncate">{row.message}</p>
    </div>
  );
}

function RowGlyph({
  status,
  kind,
}: {
  status: TimelineRow["status"];
  kind: TimelineRow["kind"];
}) {
  if (status === "running") {
    return <Loader2 className="mt-0.5 h-3 w-3 animate-spin text-[var(--primary)]" />;
  }
  if (status === "failed") {
    return <X className="mt-0.5 h-3 w-3 text-[var(--destructive)]" />;
  }
  if (status === "ok") {
    return (
      <Sparkles
        className={`mt-0.5 h-3 w-3 ${
          kind === "task" ? "text-violet-300" : "text-emerald-300"
        }`}
      />
    );
  }
  // info bookkeeping row
  return <ChevronRight className="mt-0.5 h-3 w-3 text-[var(--muted-foreground)]" />;
}

function EmptyViewer() {
  return (
    <div className="flex h-full items-center justify-center text-[12.5px] text-[var(--muted-foreground)]">
      <div className="text-center">
        <Hammer className="mx-auto mb-2 h-6 w-6 opacity-50" />
        <p>Pick a unity or activity on the left, or click Generate.</p>
      </div>
    </div>
  );
}

function UnityViewer({
  unity,
  onGenerate,
}: {
  unity: Unity;
  onGenerate: () => void;
}) {
  return (
    <div className="flex h-full flex-col gap-3">
      <header className="flex items-center justify-between">
        <h2 className="text-[14px] font-semibold">{unity.title}</h2>
        <button
          onClick={onGenerate}
          className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--card)] px-2.5 py-1 text-[12px] transition hover:border-[var(--primary)] hover:text-[var(--primary)]"
        >
          <Sparkles className="h-3 w-3" />
          Generate
        </button>
      </header>
      <p className="text-[11.5px] text-[var(--muted-foreground)]">
        {unity.activities.length} activity{unity.activities.length === 1 ? "" : "ies"}
      </p>
      {unity.activities.length === 0 ? (
        <p className="rounded border border-dashed border-[var(--border)] px-4 py-6 text-center text-[11.5px] text-[var(--muted-foreground)]">
          No activities yet. Add them in the tree on the left, or click
          Generate to have the writer fill them in (it will call
          find_related_activities first to avoid duplicating existing
          activities in this syllabus).
        </p>
      ) : (
        <ul className="space-y-2">
          {unity.activities.map((a) => (
            <li
              key={a.id}
              className="rounded-md border border-[var(--border)] bg-[var(--card)]/50 p-2 text-[12px]"
            >
              <p className="font-medium">{a.title}</p>
              <p className="mt-0.5 text-[10.5px] text-[var(--muted-foreground)]">
                {a.body ? "Body populated" : "Empty — not generated yet"}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ActivityViewer({
  activity,
  unity,
  onGenerate,
}: {
  activity: Activity;
  unity: Unity;
  onGenerate: () => void;
}) {
  const worksheetJson = useMemo(() => {
    try {
      const w = activity.worksheet;
      if (w == null || (typeof w === "object" && Object.keys(w).length === 0)) {
        return null;
      }
      return JSON.stringify(w, null, 2);
    } catch {
      return null;
    }
  }, [activity.worksheet]);

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden">
      <header className="flex shrink-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-[14px] font-semibold">{activity.title}</h2>
          <p className="truncate text-[10.5px] text-[var(--muted-foreground)]">
            in unity: {unity.title}
          </p>
        </div>
        <button
          onClick={onGenerate}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--card)] px-2.5 py-1 text-[12px] transition hover:border-[var(--primary)] hover:text-[var(--primary)]"
        >
          <Sparkles className="h-3 w-3" />
          Generate
        </button>
      </header>

      <section className="min-h-0 flex-1 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--card)]/40 p-4">
        <h3 className="mb-2 text-[10.5px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
          Cours body
        </h3>
        {activity.body ? (
          <div className="prose prose-sm prose-invert max-w-none text-[12.5px]">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {activity.body}
            </ReactMarkdown>
          </div>
        ) : (
          <p className="text-[11.5px] text-[var(--muted-foreground)]">
            Empty. Click Generate to fill in this activity (writer will
            consult find_related_activities first).
          </p>
        )}
      </section>

      {worksheetJson && (
        <section className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--card)]/40">
          <header className="border-b border-[var(--border)] px-3 py-1.5 text-[10.5px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
            Worksheet (jsonb)
          </header>
          <pre className="max-h-[25dvh] overflow-auto px-3 py-2 font-mono text-[10.5px]">
            {worksheetJson}
          </pre>
        </section>
      )}
    </div>
  );
}

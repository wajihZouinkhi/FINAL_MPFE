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

type ActiveStream =
  | null
  | {
      scope: "syllabuses" | "unities" | "activities";
      entityId: string;
      label: string;
      text: string;
      events: Array<{
        kind: "tool" | "task" | "file" | "info" | "error";
        message: string;
        ts: number;
      }>;
      ctrl: AbortController;
    };

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
        events: [],
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
    setStream((cur) =>
      cur
        ? {
            ...cur,
            events: [
              ...cur.events,
              { kind: "info", message: "Cancelled by user", ts: Date.now() },
            ],
          }
        : cur,
    );
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
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--card)]/40 px-4 py-3">
        <Link
          href="/manual"
          aria-label="Back to manual workspace index"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)] transition hover:text-[var(--primary)]"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--primary)]/15 ring-1 ring-[var(--primary)]/30">
          <Hammer className="h-4 w-4 text-[var(--primary)]" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[14px] font-semibold tracking-tight">
            {tree.syllabus.title}
          </h1>
          <p className="truncate text-[11px] text-[var(--muted-foreground)]">
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
          className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-[12px] font-medium text-[var(--foreground)] transition hover:border-[var(--primary)] hover:text-[var(--primary)] disabled:opacity-50"
          title="Run the supervisor + writer end-to-end on this syllabus"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Generate full syllabus
        </button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        {/* Left: tree */}
        <aside className="min-h-0 overflow-y-auto border-r border-[var(--border)] bg-[var(--card)]/30 p-3">
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
              className="mb-3 inline-flex items-center gap-2 rounded-md border border-dashed border-[var(--border)] px-3 py-1.5 text-[12px] font-medium text-[var(--muted-foreground)] transition hover:border-[var(--primary)] hover:text-[var(--primary)]"
            >
              <Plus className="h-3 w-3" />
              Add unity
            </button>
          )}

          {tree.unities.length === 0 ? (
            <p className="px-1 py-4 text-[11.5px] text-[var(--muted-foreground)]">
              No unities yet. Add one above to begin.
            </p>
          ) : (
            <ul className="space-y-2">
              {tree.unities.map((u) => (
                <li key={u.id} className="rounded-md border border-[var(--border)] bg-[var(--background)]/40">
                  <div className="flex items-center gap-2 px-2 py-1.5">
                    <button
                      onClick={() => toggle(u.id)}
                      aria-label="Toggle"
                      className="text-[var(--muted-foreground)]"
                    >
                      {expanded[u.id] ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronRight className="h-3 w-3" />
                      )}
                    </button>
                    <button
                      onClick={() => setViewing({ kind: "unity", id: u.id })}
                      className="min-w-0 flex-1 truncate text-left text-[12.5px] font-medium hover:text-[var(--primary)]"
                      title={u.title}
                    >
                      {u.title}
                    </button>
                    <span className="font-mono text-[10px] text-[var(--muted-foreground)]/70">
                      {u.activities.length}
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
                      className="inline-flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--card)] px-1.5 py-0.5 text-[10.5px] text-[var(--muted-foreground)] transition hover:border-[var(--primary)] hover:text-[var(--primary)] disabled:opacity-50"
                      title="Generate activities under this unity (writer calls find_related_activities first)"
                    >
                      <Sparkles className="h-2.5 w-2.5" />
                      Gen
                    </button>
                  </div>

                  {expanded[u.id] && (
                    <div className="border-t border-[var(--border)] px-2 py-2">
                      {u.activities.map((a) => (
                        <div
                          key={a.id}
                          className="mb-1 flex items-center gap-2 rounded px-1.5 py-1 hover:bg-[var(--muted)]/15"
                        >
                          <FileText className="h-3 w-3 shrink-0 text-[var(--muted-foreground)]/70" />
                          <button
                            onClick={() =>
                              setViewing({ kind: "activity", id: a.id })
                            }
                            className="min-w-0 flex-1 truncate text-left text-[11.5px] hover:text-[var(--primary)]"
                            title={a.title}
                          >
                            {a.title}
                          </button>
                          <span
                            className={`text-[9.5px] font-mono ${a.body ? "text-emerald-400/80" : "text-[var(--muted-foreground)]/70"}`}
                            title={
                              a.body
                                ? "body populated"
                                : "not yet generated"
                            }
                          >
                            {a.body ? "ready" : "empty"}
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
                            className="inline-flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--card)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)] transition hover:border-[var(--primary)] hover:text-[var(--primary)] disabled:opacity-50"
                            title="Generate this activity's body + worksheet"
                          >
                            <Sparkles className="h-2 w-2" />
                            Gen
                          </button>
                        </div>
                      ))}

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
                          className="ml-3 inline-flex items-center gap-1 rounded-md border border-dashed border-[var(--border)] px-2 py-0.5 text-[10.5px] text-[var(--muted-foreground)] transition hover:border-[var(--primary)] hover:text-[var(--primary)]"
                        >
                          <Plus className="h-2.5 w-2.5" />
                          Add activity
                        </button>
                      )}
                    </div>
                  )}
                </li>
              ))}
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

function applyChunk(
  cur: ActiveStream,
  entityId: string,
  scope: "syllabuses" | "unities" | "activities",
  chunk: DeepAgentChunk,
): ActiveStream {
  if (!cur || cur.entityId !== entityId || cur.scope !== scope) return cur;
  switch (chunk.type) {
    case "text-delta":
      return { ...cur, text: cur.text + chunk.delta };
    case "tool-start":
      return {
        ...cur,
        events: [
          ...cur.events,
          {
            kind: "tool",
            message: `tool-start: ${chunk.name}`,
            ts: Date.now(),
          },
        ],
      };
    case "tool-end":
      return {
        ...cur,
        events: [
          ...cur.events,
          {
            kind: "tool",
            message: `tool-end: ${chunk.name}`,
            ts: Date.now(),
          },
        ],
      };
    case "task-start":
      return {
        ...cur,
        events: [
          ...cur.events,
          {
            kind: "task",
            message: `dispatch ${chunk.subagentName}: ${chunk.description.slice(0, 80)}…`,
            ts: Date.now(),
          },
        ],
      };
    case "task-end":
      return {
        ...cur,
        events: [
          ...cur.events,
          {
            kind: "task",
            message: `${chunk.subagentName} done (${(chunk.durationMs / 1000).toFixed(1)}s)`,
            ts: Date.now(),
          },
        ],
      };
    case "files-update": {
      const paths = Object.keys(chunk.files).join(", ");
      return {
        ...cur,
        events: [
          ...cur.events,
          {
            kind: "file",
            message: `wrote ${paths}`,
            ts: Date.now(),
          },
        ],
      };
    }
    case "error":
      return {
        ...cur,
        events: [
          ...cur.events,
          { kind: "error", message: chunk.message, ts: Date.now() },
        ],
      };
    case "done":
      return {
        ...cur,
        events: [
          ...cur.events,
          { kind: "info", message: "done", ts: Date.now() },
        ],
      };
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

function StreamPanel({
  stream,
  onCancel,
}: {
  stream: NonNullable<ActiveStream>;
  onCancel: () => void;
}) {
  const textRef = useRef<HTMLDivElement | null>(null);
  // Auto-scroll the streaming text container as deltas arrive.
  useEffect(() => {
    if (textRef.current) {
      textRef.current.scrollTop = textRef.current.scrollHeight;
    }
  }, [stream.text]);
  const done = stream.events.some(
    (e) => e.message === "done" || e.kind === "error",
  );
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold">
          {done ? (
            <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
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

      <section className="rounded-md border border-[var(--border)] bg-[var(--card)]/50">
        <header className="border-b border-[var(--border)] px-3 py-1.5 text-[10.5px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
          Supervisor stream
        </header>
        <div
          ref={textRef}
          className="max-h-[40dvh] overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 text-[12px] leading-relaxed"
        >
          {stream.text || (
            <span className="text-[var(--muted-foreground)]">
              waiting for first token…
            </span>
          )}
        </div>
      </section>

      <section className="rounded-md border border-[var(--border)] bg-[var(--card)]/50">
        <header className="border-b border-[var(--border)] px-3 py-1.5 text-[10.5px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
          Events ({stream.events.length})
        </header>
        <ul className="max-h-[35dvh] overflow-y-auto divide-y divide-[var(--border)]/60 text-[11px]">
          {stream.events.map((ev, i) => (
            <li
              key={i}
              className={`flex items-center gap-2 px-3 py-1 ${
                ev.kind === "error"
                  ? "text-[var(--destructive)]"
                  : ev.kind === "task"
                    ? "text-violet-400"
                    : ev.kind === "tool"
                      ? "text-emerald-400/90"
                      : ev.kind === "file"
                        ? "text-sky-400"
                        : "text-[var(--muted-foreground)]"
              }`}
            >
              <span className="font-mono text-[9.5px] opacity-70">
                {new Date(ev.ts).toLocaleTimeString()}
              </span>
              <span>{ev.message}</span>
            </li>
          ))}
          {stream.events.length === 0 && (
            <li className="px-3 py-2 text-[var(--muted-foreground)]">
              No events yet.
            </li>
          )}
        </ul>
      </section>
    </div>
  );
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

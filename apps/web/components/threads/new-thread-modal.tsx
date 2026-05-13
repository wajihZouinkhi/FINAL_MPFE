"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FlaskConical,
  GraduationCap,
  Loader2,
  Plug,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type {
  AgentKind,
  ThreadListEntry,
  ThreadListResponse,
} from "@mpfe/shared";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface AgentOption {
  kind: AgentKind;
  title: string;
  blurb: string;
  badge: string;
  icon: React.ReactNode;
  needsBinding: boolean;
}

const AGENTS: AgentOption[] = [
  {
    kind: "syllabus-generator",
    title: "Syllabus generator",
    blurb:
      "Researches a topic, plans chapters/lessons, and writes graded markdown for each lesson. Can ask follow-ups to clarify scope.",
    badge: "Course author",
    icon: <GraduationCap className="h-4 w-4" />,
    needsBinding: false,
  },
  {
    kind: "activity-generator-tooled",
    title: "Activity generator (with tools)",
    blurb:
      "Reads your existing course material via MCP tools and produces worksheets grounded in the actual lesson content. Bind it to a syllabus thread.",
    badge: "MCP / grounded",
    icon: <Plug className="h-4 w-4" />,
    needsBinding: true,
  },
  {
    kind: "activity-generator-toolless",
    title: "Activity generator (no tools)",
    blurb:
      "Generates a worksheet purely from the user prompt, with no access to your syllabus. Useful as a side-by-side baseline against the tooled agent.",
    badge: "Demo baseline",
    icon: <FlaskConical className="h-4 w-4" />,
    needsBinding: false,
  },
  {
    kind: "deepagent",
    title: "Deep Agent",
    blurb:
      "A generalist supervisor with four specialists. Tell it what you want — build a syllabus, make a worksheet (for an existing lesson or standalone), critique a draft, or just ask a pedagogical question — and it picks the right capability and runs it.",
    badge: "Generalist",
    icon: <Sparkles className="h-4 w-4" />,
    needsBinding: false,
  },
];

/**
 * Two-step modal for creating a new thread:
 *   1. Pick which agent to dispatch.
 *   2. (Tooled-activity only) Pick which existing syllabus thread to
 *      bind to. The activity-tooled agent reads chapters/lessons of
 *      that thread's syllabus through MCP tools.
 *
 * On confirmation we POST `/api/threads` with `{ agent,
 * bound_syllabus_thread_id? }` and route to the new thread.
 */
export function NewThreadModal({
  open,
  onClose,
  defaultAgent = "syllabus-generator",
}: {
  open: boolean;
  onClose: () => void;
  defaultAgent?: AgentKind;
}) {
  const router = useRouter();
  const [step, setStep] = useState<"pick-agent" | "pick-binding">("pick-agent");
  const [agent, setAgent] = useState<AgentKind>(defaultAgent);
  const [boundId, setBoundId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [threads, setThreads] = useState<ThreadListEntry[] | null>(null);

  // Reset on open. We reset the agent to the caller's default so a
  // teacher who hits "New activity" gets the activity picker
  // pre-selected without an extra click. We also drop the cached
  // thread list so re-opening the modal picks up any syllabus thread
  // created since the last open (e.g. from another tab, or just from
  // the threads index between opens).
  useEffect(() => {
    if (open) {
      setStep("pick-agent");
      setAgent(defaultAgent);
      setBoundId(null);
      setThreads(null);
    }
  }, [open, defaultAgent]);

  // Lazy-load thread list only when the user actually advances to the
  // binding step — saves the round-trip on the (common) syllabus path.
  // /api/threads is paginated and returns {items, next_cursor, counts};
  // we let the server filter by agent and request a generous page size
  // so the (rare) >100-syllabus case is the only one that would clip.
  useEffect(() => {
    if (!open || step !== "pick-binding" || threads !== null) return;
    fetch(
      `${API}/api/threads?agent=syllabus-generator&limit=100`,
      { cache: "no-store" },
    )
      .then((r) => r.json())
      .then((body: ThreadListResponse) => setThreads(body.items))
      .catch((e) =>
        toast.error("Couldn't load syllabus threads", {
          description: (e as Error).message,
        }),
      );
  }, [open, step, threads]);

  const syllabusThreads: ThreadListEntry[] = threads ?? [];

  if (!open) return null;

  const selected = AGENTS.find((a) => a.kind === agent)!;
  // Step 1 ("pick-agent") only needs an agent selected — for
  // needsBinding agents the button advances to step 2 instead of
  // confirming. Step 2 ("pick-binding") requires a bound thread id.
  const canConfirm =
    !creating &&
    (step === "pick-binding" ? !!boundId : true);

  const advance = () => {
    if (selected.needsBinding && step === "pick-agent") {
      setStep("pick-binding");
      return;
    }
    void confirm();
  };

  const confirm = async () => {
    setCreating(true);
    try {
      const res = await fetch(`${API}/api/threads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent,
          bound_syllabus_thread_id: selected.needsBinding ? boundId : null,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { id } = (await res.json()) as { id: string };
      router.push(`/threads/${id}`);
    } catch (e) {
      toast.error("Couldn't start a thread", {
        description: (e as Error).message,
      });
      setCreating(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-[var(--primary)]/20 bg-[var(--card)] shadow-[0_30px_80px_-20px_rgba(0,0,0,0.7),0_0_0_1px_rgba(246,110,96,0.08)] ring-1 ring-[var(--primary)]/10"
      >
        <header className="flex items-start gap-3 border-b border-[var(--border)] px-5 py-4">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-[var(--primary)]/15 ring-1 ring-[var(--primary)]/30">
            <Sparkles className="h-3.5 w-3.5 text-[var(--primary)]" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold tracking-tight">
              {step === "pick-agent"
                ? "Start a new thread"
                : "Bind to a syllabus thread"}
            </h2>
            <p className="mt-0.5 text-[12px] text-[var(--muted-foreground)]">
              {step === "pick-agent"
                ? "Pick which agent will run this thread."
                : "Tooled activity threads read chapters and lessons of an existing syllabus."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
          {step === "pick-agent" ? (
            <ul className="grid gap-2">
              {AGENTS.map((a) => (
                <li key={a.kind}>
                  <button
                    type="button"
                    onClick={() => setAgent(a.kind)}
                    className={
                      "flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition " +
                      (agent === a.kind
                        ? "border-[var(--primary)]/55 bg-[var(--primary)]/8"
                        : "border-[var(--border)] hover:border-[var(--primary)]/30 hover:bg-[var(--muted)]/30")
                    }
                  >
                    <span
                      className={
                        "mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md ring-1 " +
                        (agent === a.kind
                          ? "bg-[var(--primary)]/15 text-[var(--primary)] ring-[var(--primary)]/30"
                          : "bg-[var(--muted)]/40 text-[var(--muted-foreground)] ring-[var(--border)]")
                      }
                    >
                      {a.icon}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-semibold text-[var(--foreground)]">
                          {a.title}
                        </span>
                        <span className="rounded-full border border-[var(--border)] bg-[var(--muted)]/40 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wider text-[var(--muted-foreground)]">
                          {a.badge}
                        </span>
                      </div>
                      <p className="mt-1 text-[11.5px] leading-snug text-[var(--muted-foreground)]">
                        {a.blurb}
                      </p>
                    </div>
                    {agent === a.kind ? (
                      <Check className="mt-1 h-4 w-4 shrink-0 text-[var(--primary)]" />
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <BindingPicker
              threads={syllabusThreads}
              loading={threads === null}
              boundId={boundId}
              onSelect={setBoundId}
            />
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[var(--border)] bg-[var(--muted)]/15 px-5 py-3">
          {step === "pick-binding" ? (
            <button
              type="button"
              onClick={() => setStep("pick-agent")}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            >
              <ArrowLeft className="h-3 w-3" />
              Back
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2.5 py-1.5 text-[12px] font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={advance}
            disabled={!canConfirm}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--primary)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--primary-foreground)] shadow-[0_8px_24px_-12px_rgba(246,110,96,0.7)] transition hover:opacity-95 disabled:opacity-50"
          >
            {creating ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : selected.needsBinding && step === "pick-agent" ? (
              <ArrowRight className="h-3 w-3" />
            ) : (
              <Check className="h-3 w-3" />
            )}
            {creating
              ? "Creating…"
              : selected.needsBinding && step === "pick-agent"
                ? "Next"
                : "Start thread"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function BindingPicker({
  threads,
  loading,
  boundId,
  onSelect,
}: {
  threads: ThreadListEntry[];
  loading: boolean;
  boundId: string | null;
  onSelect: (id: string) => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-10 text-[12px] text-[var(--muted-foreground)]">
        <Loader2 className="mr-2 h-3 w-3 animate-spin" />
        Loading your syllabus threads…
      </div>
    );
  }
  if (threads.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--muted)]/20 px-4 py-6 text-center text-[12px] text-[var(--muted-foreground)]">
        You don't have any syllabus threads yet.
        <br />
        Start one from the "Syllabus generator" agent first, then come
        back to bind an activity-tooled thread to it.
      </div>
    );
  }
  return (
    <ul className="grid gap-1.5">
      {threads.map((t) => {
        const title =
          t.title?.trim() ||
          t.last_user_message?.slice(0, 64) ||
          "Untitled syllabus";
        const selected = t.id === boundId;
        return (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => onSelect(t.id)}
              className={
                "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition " +
                (selected
                  ? "border-[var(--primary)]/55 bg-[var(--primary)]/8"
                  : "border-[var(--border)] hover:border-[var(--primary)]/30 hover:bg-[var(--muted)]/30")
              }
            >
              <span
                className={
                  "inline-flex h-6 w-6 items-center justify-center rounded ring-1 " +
                  (selected
                    ? "bg-[var(--primary)]/15 text-[var(--primary)] ring-[var(--primary)]/30"
                    : "bg-[var(--muted)]/40 text-[var(--muted-foreground)] ring-[var(--border)]")
                }
              >
                <GraduationCap className="h-3 w-3" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-medium text-[var(--foreground)]">
                  {title}
                </div>
                <div className="font-mono text-[10px] text-[var(--muted-foreground)]">
                  {t.id.slice(0, 8)}
                </div>
              </div>
              {selected ? (
                <Check className="h-3.5 w-3.5 text-[var(--primary)]" />
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

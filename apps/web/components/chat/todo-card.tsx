"use client";

import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ListTodo,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Circle,
  Pencil,
  Search,
} from "lucide-react";
import type { TodoPlan, TodoStep } from "@mpfe/shared";

/**
 * Inline writing-progress card. Shows per-lesson status as the command
 * subgraph runs through writer → critic → committer.
 */
export function TodoCard({ plan }: { plan: TodoPlan }) {
  const [open, setOpen] = useState(true);
  const total = plan.steps.length;
  const done = plan.steps.filter(
    (s) =>
      s.status === "accepted" ||
      s.status === "rejected" ||
      s.status === "failed",
  ).length;
  const running = total > 0 && done < total;

  // Group steps by chapter for readability.
  const groups = useMemo(() => {
    const m = new Map<string, TodoStep[]>();
    for (const s of plan.steps) {
      const k = s.chapter_ref || "—";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(s);
    }
    return [...m.entries()];
  }, [plan.steps]);

  return (
    <section className="animate-fade-in overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)]/80 text-[13px] shadow-[0_4px_24px_-12px_rgba(0,0,0,0.5)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-[var(--accent)]/40"
      >
        <ListTodo className="h-3.5 w-3.5 text-[var(--primary)]" />
        <span className="font-semibold">Working plan</span>
        <span className="text-[11px] text-[var(--muted-foreground)]">
          {done}/{total}
        </span>
        <span className="ml-auto flex items-center gap-2 text-[var(--muted-foreground)]">
          {running ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </span>
      </button>
      {open ? (
        <div className="space-y-3 border-t border-[var(--border)] px-3 py-2">
          {groups.map(([chapter, steps]) => (
            <div key={chapter}>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-[var(--muted-foreground)]">
                {chapter}
              </div>
              <ul className="space-y-1">
                {steps.map((s) => (
                  <Step key={s.id} step={s} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function Step({ step }: { step: TodoStep }) {
  return (
    <li className="flex items-center gap-1.5 rounded border border-[var(--border)]/70 bg-[var(--background)]/60 px-2 py-1.5 transition hover:border-[var(--primary)]/40">
      <StepIcon status={step.status} />
      <span className="rounded bg-[var(--muted)] px-1 py-px font-mono text-[10px] text-[var(--muted-foreground)]">
        {step.id}
      </span>
      <span className="flex-1 truncate text-[12px]">{step.name}</span>
      <span className="text-[10px] capitalize text-[var(--muted-foreground)]">
        {labelFor(step)}
      </span>
    </li>
  );
}

function StepIcon({ status }: { status: TodoStep["status"] }) {
  switch (status) {
    case "accepted":
    // Treat legacy "rejected" as "passed" — same icon, same colour.
    // The status is kept on the type for backward-compat with old
    // persisted state; new commits never produce it.
    case "rejected":
      return <CheckCircle2 className="h-3 w-3 text-[var(--success)]" />;
    case "failed":
      return <AlertCircle className="h-3 w-3 text-[var(--destructive)]" />;
    case "writing":
      return <Pencil className="h-3 w-3 animate-pulse text-[var(--primary)]" />;
    case "critiquing":
      return <Search className="h-3 w-3 animate-pulse text-[var(--primary)]" />;
    default:
      return <Circle className="h-3 w-3 text-[var(--muted-foreground)]" />;
  }
}

function labelFor(step: TodoStep): string {
  switch (step.status) {
    case "pending":
      return "queued";
    case "writing":
      return `attempt ${step.attempts || 1}`;
    case "critiquing":
      return "review";
    // The writer/critic gate no longer surfaces a "force-passed" outcome —
    // lessons are always committed as accepted regardless of whether the
    // critic's first pass succeeded or the writer revised once silently.
    // The legacy "rejected" status is kept on the type for backward-compat
    // with persisted state from pre-zero-trace runs, but it now reads as
    // a normal "passed" step in the FE.
    case "accepted":
    case "rejected":
      return `passed (${step.attempts}×)`;
    case "failed":
      return "failed";
  }
}

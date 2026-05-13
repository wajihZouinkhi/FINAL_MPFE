"use client";

import { useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Lightbulb,
  PencilLine,
  Wrench,
  Ban,
  XCircle,
} from "lucide-react";
import type { ActivityRow, AgentKind, Worksheet } from "@mpfe/shared";

/**
 * Renders one worksheet activity row produced by either the tooled or
 * toolless activity-generator. The shape is identical between the two
 * agents (same Worksheet zod type), which is exactly the side-by-side
 * comparison the demo is built around: same prompt → same output
 * shape → very different fidelity depending on whether the agent had
 * MCP tools.
 *
 * The grading state for MCQs is purely client-side; we don't
 * persist student answers anywhere — this is a teacher-facing demo,
 * not a student LMS.
 */
export function ActivityWorksheet({
  row,
  agent,
}: {
  row: ActivityRow;
  agent: AgentKind;
}) {
  const w = row.content as Worksheet;
  const grounded = agent === "activity-generator-tooled";
  // The worked-example object is always present on the worksheet (Zod
  // default stub) but the activity-intake form lets the user opt out.
  // Treat "empty steps and empty prompt" as "no worked example" so we
  // don't render an empty section header / inflate the badge count.
  const hasWorkedExample =
    w.worked_example &&
    (w.worked_example.steps.length > 0 ||
      Boolean(w.worked_example.prompt?.trim()));
  const hasShortAnswers = w.short_answers.length > 0;
  return (
    <article className="rounded-xl border border-[var(--border)] bg-[var(--card)]/85 backdrop-blur">
      <header className="flex items-start gap-3 border-b border-[var(--border)] px-5 py-4">
        <span
          className={
            "mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md ring-1 " +
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
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold tracking-tight">
            {w.title}
          </h3>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-[var(--muted-foreground)]">
            <span
              className={
                "rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider " +
                (grounded
                  ? "border-emerald-400/35 bg-emerald-400/15 text-emerald-300"
                  : "border-amber-400/35 bg-amber-400/15 text-amber-300")
              }
            >
              {grounded ? "MCP-grounded" : "no tools"}
            </span>
            {row.lesson_title ? (
              <span>
                Lesson: <span className="text-[var(--foreground)]">{row.lesson_title}</span>
              </span>
            ) : null}
            <span>•</span>
            <span>
              {w.mcqs.length} MCQ
              {hasShortAnswers ? ` · ${w.short_answers.length} SA` : ""}
              {hasWorkedExample ? " · 1 worked" : ""}
            </span>
          </div>
          {w.intro?.trim() ? (
            <p className="mt-2 text-[12.5px] leading-snug text-[var(--muted-foreground)]">
              {w.intro}
            </p>
          ) : null}
          {row.prompt ? (
            <p className="mt-2 truncate font-mono text-[10.5px] text-[var(--muted-foreground)]">
              prompt: {row.prompt}
            </p>
          ) : null}
        </div>
      </header>

      <section className="space-y-5 px-5 py-4">
        <div>
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
            Multiple choice
          </h4>
          <ol className="space-y-3">
            {w.mcqs.map((m, i) => (
              <McqItem key={i} idx={i} mcq={m} />
            ))}
          </ol>
        </div>

        {hasShortAnswers ? (
          <div>
            <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
              <PencilLine className="h-3 w-3" />
              Short answer
            </h4>
            <ol className="space-y-2">
              {w.short_answers.map((s, i) => (
                <ShortAnswerItem key={i} idx={i} sa={s} />
              ))}
            </ol>
          </div>
        ) : null}

        {hasWorkedExample ? (
          <div>
            <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
              <Lightbulb className="h-3 w-3" />
              Worked example
            </h4>
            <WorkedExampleItem we={w.worked_example} />
          </div>
        ) : null}
      </section>
    </article>
  );
}

function McqItem({
  idx,
  mcq,
}: {
  idx: number;
  mcq: Worksheet["mcqs"][number];
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const [reveal, setReveal] = useState(false);
  const correct = picked !== null && picked === mcq.correct_index;
  return (
    <li className="rounded-lg border border-[var(--border)] bg-[var(--background)]/40 px-3 py-2.5">
      <div className="flex gap-2">
        <span className="mt-0.5 font-mono text-[10.5px] text-[var(--muted-foreground)]">
          Q{idx + 1}
        </span>
        <p className="text-[12.5px] font-medium leading-snug text-[var(--foreground)]">
          {mcq.question}
        </p>
      </div>
      <ul className="mt-2 grid gap-1">
        {mcq.options.map((opt, i) => {
          const chosen = picked === i;
          const isCorrect = i === mcq.correct_index;
          return (
            <li key={i}>
              <button
                type="button"
                onClick={() => {
                  setPicked(i);
                  setReveal(true);
                }}
                className={
                  "flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-[12px] transition " +
                  (chosen
                    ? isCorrect
                      ? "border-emerald-400/45 bg-emerald-400/10 text-emerald-200"
                      : "border-[var(--destructive)]/45 bg-[var(--destructive)]/10 text-[var(--destructive)]"
                    : reveal && isCorrect
                      ? "border-emerald-400/35 bg-emerald-400/5 text-emerald-200"
                      : "border-[var(--border)] hover:border-[var(--primary)]/30 hover:bg-[var(--muted)]/30")
                }
              >
                <span className="font-mono text-[10px] text-[var(--muted-foreground)]">
                  {String.fromCharCode(65 + i)}
                </span>
                <span className="flex-1">{opt}</span>
                {chosen ? (
                  isCorrect ? (
                    <CheckCircle2 className="h-3 w-3" />
                  ) : (
                    <XCircle className="h-3 w-3" />
                  )
                ) : reveal && isCorrect ? (
                  <CheckCircle2 className="h-3 w-3 opacity-70" />
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      {reveal ? (
        <p
          className={
            "mt-2 rounded-md border px-2.5 py-1.5 text-[11.5px] leading-snug " +
            (correct
              ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
              : "border-[var(--border)] bg-[var(--muted)]/30 text-[var(--muted-foreground)]")
          }
        >
          <span className="font-semibold">Why: </span>
          {mcq.explanation}
        </p>
      ) : null}
    </li>
  );
}

function ShortAnswerItem({
  idx,
  sa,
}: {
  idx: number;
  sa: Worksheet["short_answers"][number];
}) {
  const [reveal, setReveal] = useState(false);
  return (
    <li className="rounded-lg border border-[var(--border)] bg-[var(--background)]/40 px-3 py-2.5">
      <div className="flex gap-2">
        <span className="mt-0.5 font-mono text-[10.5px] text-[var(--muted-foreground)]">
          S{idx + 1}
        </span>
        <p className="text-[12.5px] font-medium leading-snug text-[var(--foreground)]">
          {sa.prompt}
        </p>
      </div>
      <button
        type="button"
        onClick={() => setReveal((v) => !v)}
        className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-[var(--primary)] hover:opacity-90"
      >
        {reveal ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        {reveal ? "Hide model answer" : "Show model answer"}
      </button>
      {reveal ? (
        <p className="mt-1.5 rounded-md border border-[var(--border)] bg-[var(--muted)]/30 px-2.5 py-1.5 text-[11.5px] leading-snug text-[var(--foreground)]">
          {sa.model_answer}
        </p>
      ) : null}
    </li>
  );
}

function WorkedExampleItem({
  we,
}: {
  we: Worksheet["worked_example"];
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--background)]/40 px-3 py-2.5">
      <p className="text-[12.5px] font-medium leading-snug text-[var(--foreground)]">
        {we.prompt}
      </p>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-[12px] leading-snug text-[var(--muted-foreground)] marker:text-[var(--primary)]">
        {we.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      <p className="mt-2 rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1.5 text-[11.5px] text-emerald-200">
        <span className="font-semibold">Answer: </span>
        {we.final_answer}
      </p>
    </div>
  );
}

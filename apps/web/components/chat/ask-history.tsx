"use client";

import {
  ClipboardList,
  CornerDownRight,
  HelpCircle,
  Sparkles,
} from "lucide-react";
import type { AgentInterrupt } from "@mpfe/shared";

/**
 * Permanent Q&A trail. Each entry is rendered inline by ChatPane,
 * anchored to the assistant turn that issued it (matched via the
 * verbatim user-answer text). This file exports the single-entry
 * component so ChatPane can interleave it into the message list, plus
 * a multi-entry wrapper used by tests and any callers that just want
 * the trail dumped at the bottom.
 */
export function AskHistory({ entries }: { entries: AgentInterrupt[] }) {
  const resolved = entries.filter((e) => e.answer);
  if (!resolved.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {resolved.map((e) => (
        <ResolvedAskInline key={e.id} entry={e} />
      ))}
    </div>
  );
}

/**
 * Single resolved-ask bubble (question on top, user's answer underneath).
 * Exported so ChatPane can render it inline immediately *before* the
 * user message that holds the answer — i.e. anchored to the assistant
 * turn that asked. If the answer was a suggestion flagged recommended,
 * the badge is preserved so the trail tells the full story.
 */
export function ResolvedAskInline({ entry }: { entry: AgentInterrupt }) {
  const answer = entry.answer!;
  const matched = entry.suggestions.find((s) => s.id === answer.suggestion_id);
  const wasRecommended = matched?.recommended === true;
  // Intake-form entries get a different header label and icon — the answer
  // body is the synthesized "[Intake] Audience level: …" string from the
  // server, which is human-readable enough to render verbatim. Future
  // pass: render the structured intake_answer as a chip table instead.
  const isIntake = entry.kind === "intake_form";
  return (
    <section className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)]/70">
      <header className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--muted)]/30 px-3 py-1.5">
        {isIntake ? (
          <ClipboardList className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
        ) : (
          <HelpCircle className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
        )}
        <span className="text-[12px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
          {isIntake ? "Setup submitted" : "Agent asked"}
        </span>
      </header>
      <div className="space-y-2 px-3 py-2.5">
        <p className="text-[13px] leading-relaxed text-[var(--foreground)]">
          {entry.question}
        </p>
        <div className="flex items-start gap-2 rounded-md border border-[var(--border)] bg-[var(--background)]/50 px-2.5 py-1.5">
          <CornerDownRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--primary)]" />
          <div className="flex flex-1 flex-wrap items-center gap-1.5">
            <span className="text-[13px] text-[var(--foreground)]">
              {answer.text}
            </span>
            {wasRecommended ? (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-[var(--secondary)]/20 px-1.5 py-px font-mono text-[9px] uppercase tracking-wider text-[var(--secondary)]">
                <Sparkles className="h-2.5 w-2.5" />
                recommended
              </span>
            ) : !isIntake && answer.source === "free_text" ? (
              <span className="rounded-full border border-[var(--border)] px-1.5 py-px font-mono text-[9px] uppercase tracking-wider text-[var(--muted-foreground)]">
                typed
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

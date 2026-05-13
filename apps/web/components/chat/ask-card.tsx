"use client";

import { useState } from "react";
import { HelpCircle, Send, Sparkles } from "lucide-react";
import type { AgentInterrupt, AskSuggestion } from "@mpfe/shared";

/**
 * Inline question card rendered when the supervisor's `ask` action sets
 * `interrupt_payload`. The user picks a suggestion (or types their own
 * answer) and we submit it as the next chat message — that resumes the
 * graph by feeding the answer back as the next human turn.
 *
 * Suggestions are typed objects with an optional `recommended` flag; the
 * card surfaces a small "Recommended" tag next to that one.
 */
export function AskCard({
  interrupt,
  disabled,
  onAnswer,
}: {
  interrupt: AgentInterrupt;
  disabled?: boolean;
  onAnswer: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");

  const submitSuggestion = (s: AskSuggestion) => {
    if (disabled) return;
    onAnswer(s.value);
  };

  const submitDraft = (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    const text = draft.trim();
    if (!text) return;
    onAnswer(text);
    setDraft("");
  };

  const suggestions = interrupt.suggestions ?? [];

  return (
    <section className="animate-fade-in overflow-hidden rounded-lg border border-[var(--secondary)]/45 bg-[var(--card)] shadow-[0_8px_32px_-12px_rgba(252,175,65,0.25)]">
      <header className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--secondary)]/10 px-3 py-2">
        <HelpCircle className="h-3.5 w-3.5 text-[var(--secondary)]" />
        <span className="text-[13px] font-semibold text-[var(--secondary)]">
          Agent is asking
        </span>
      </header>
      <div className="space-y-3 px-3 py-3">
        <p className="text-[13.5px] leading-relaxed">{interrupt.question}</p>
        {suggestions.length ? (
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <button
                key={s.id}
                type="button"
                disabled={disabled}
                onClick={() => submitSuggestion(s)}
                className={
                  "group inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] transition disabled:opacity-50 " +
                  (s.recommended
                    ? "border-[var(--secondary)]/70 bg-[var(--secondary)]/15 text-[var(--secondary)] hover:bg-[var(--secondary)]/25"
                    : "border-[var(--border)] bg-[var(--background)]/60 hover:border-[var(--secondary)] hover:bg-[var(--secondary)]/10 hover:text-[var(--secondary)]")
                }
              >
                <span>{s.label ?? s.value}</span>
                {s.recommended ? (
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-[var(--secondary)]/20 px-1.5 py-px font-mono text-[9px] uppercase tracking-wider text-[var(--secondary)]">
                    <Sparkles className="h-2.5 w-2.5" />
                    rec
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
        {interrupt.allow_free_text ? (
          <form onSubmit={submitDraft} className="flex gap-1.5">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={disabled}
              placeholder="Or type your own answer…"
              className="flex-1 rounded-md border border-[var(--border)] bg-[var(--background)] px-2.5 py-1.5 text-[13px] outline-none transition focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]/40 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={disabled || !draft.trim()}
              className="inline-flex items-center justify-center rounded-md bg-[var(--primary)] px-3 py-1.5 text-[var(--primary-foreground)] transition hover:opacity-95 disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </form>
        ) : null}
      </div>
    </section>
  );
}

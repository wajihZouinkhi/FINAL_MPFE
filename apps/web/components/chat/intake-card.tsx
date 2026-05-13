"use client";

import { useMemo, useState, type KeyboardEvent } from "react";
import { ClipboardList, Send, Sparkles, X } from "lucide-react";
import type { AgentInterrupt, IntakeFormAnswer } from "@mpfe/shared";

/**
 * Structured intake form rendered when the supervisor's `intake` action sets
 * an interrupt with `kind === "intake_form"`. Replaces the freeform AskCard
 * for the FIRST-turn pedagogical intake (audience level, prior knowledge,
 * duration, language, target outcome) so the user submits typed JSON
 * instead of prose, removing the natural-language parsing brittleness for
 * non-English replies and letting the API validate before resuming the
 * graph.
 *
 * The supervisor pre-fills `interrupt.intake.defaults` for any field it
 * could infer from the user's first message; we wire those into the form's
 * initial state. Only the fields listed in `interrupt.intake.fields` are
 * rendered — the supervisor omits anything the user already stated upfront
 * so the form doesn't re-ask known values.
 */
const ALL_LEVELS = [
  { value: "school", label: "School / K-12" },
  { value: "undergrad", label: "Undergraduate" },
  { value: "grad", label: "Graduate" },
  { value: "professional", label: "Professional / industry" },
] as const;

type AudienceLevel = (typeof ALL_LEVELS)[number]["value"];

export function IntakeCard({
  interrupt,
  disabled,
  onSubmit,
}: {
  interrupt: AgentInterrupt;
  disabled?: boolean;
  onSubmit: (answer: IntakeFormAnswer) => void;
}) {
  const spec = interrupt.intake;
  const fields = useMemo(
    () =>
      new Set(
        spec?.fields ?? [
          "audience_level",
          "prior_knowledge",
          "duration_hours",
          "language",
          "target_outcome",
        ],
      ),
    [spec],
  );

  const [audienceLevel, setAudienceLevel] = useState<AudienceLevel>(
    (spec?.defaults?.audience_level as AudienceLevel | undefined) ?? "undergrad",
  );
  const [priorKnowledge, setPriorKnowledge] = useState<string[]>(
    spec?.defaults?.prior_knowledge ?? [],
  );
  const [priorDraft, setPriorDraft] = useState("");
  const [durationHours, setDurationHours] = useState<string>(
    spec?.defaults?.duration_hours
      ? String(spec.defaults.duration_hours)
      : "6",
  );
  const [language, setLanguage] = useState<string>(
    spec?.defaults?.language ?? "English",
  );
  const [targetOutcome, setTargetOutcome] = useState<string>(
    spec?.defaults?.target_outcome ?? "",
  );

  const commitPriorDraft = () => {
    const v = priorDraft.trim();
    if (!v) return;
    if (!priorKnowledge.includes(v)) {
      setPriorKnowledge([...priorKnowledge, v]);
    }
    setPriorDraft("");
  };

  const onPriorKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commitPriorDraft();
    } else if (e.key === "Backspace" && !priorDraft && priorKnowledge.length) {
      setPriorKnowledge(priorKnowledge.slice(0, -1));
    }
  };

  const removePrior = (idx: number) =>
    setPriorKnowledge(priorKnowledge.filter((_, i) => i !== idx));

  const durationNumber = Number(durationHours);
  const canSubmit =
    !disabled &&
    Number.isFinite(durationNumber) &&
    durationNumber > 0 &&
    language.trim().length > 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    // Commit any pending prior-knowledge draft so a user who typed and
    // hit Submit without pressing Enter still gets their value through.
    const finalPrior =
      priorDraft.trim() && !priorKnowledge.includes(priorDraft.trim())
        ? [...priorKnowledge, priorDraft.trim()]
        : priorKnowledge;
    const answer: IntakeFormAnswer = {
      audience_level: audienceLevel,
      prior_knowledge: finalPrior,
      duration_hours: durationNumber,
      language: language.trim(),
      target_outcome: targetOutcome.trim(),
      answered_at: new Date().toISOString(),
    };
    onSubmit(answer);
  };

  return (
    <section className="animate-fade-in overflow-hidden rounded-lg border border-[var(--secondary)]/45 bg-[var(--card)] shadow-[0_8px_32px_-12px_rgba(252,175,65,0.25)]">
      <header className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--secondary)]/10 px-3 py-2">
        <ClipboardList className="h-3.5 w-3.5 text-[var(--secondary)]" />
        <span className="text-[13px] font-semibold text-[var(--secondary)]">
          Setup
        </span>
        <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-[var(--secondary)]/15 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-[var(--secondary)]">
          <Sparkles className="h-2.5 w-2.5" />
          intake
        </span>
      </header>
      <form
        onSubmit={submit}
        className="space-y-4 px-3 py-3 text-[13px] text-[var(--foreground)]"
      >
        {interrupt.question ? (
          <p className="text-[13.5px] leading-relaxed text-[var(--muted-foreground)]">
            {interrupt.question}
          </p>
        ) : null}

        {fields.has("audience_level") ? (
          <div className="space-y-1.5">
            <div
              id="intake-audience-level-label"
              className="font-mono text-[10.5px] uppercase tracking-wider text-[var(--muted-foreground)]"
            >
              Audience level
            </div>
            {/*
             * Audit §4.3: these read as a 4-button grid but behave as
             * a single-select radio group. Without `role="radiogroup"`
             * + `role="radio"` + `aria-checked`, screen readers
             * announce four independent buttons and Tab cycles through
             * each one instead of focusing the group as a unit. The
             * arrow-key handler below mirrors native radio behaviour:
             * left/up moves backward, right/down moves forward, both
             * wrap around, and Home / End jump to the ends. Disabled
             * state takes precedence over the keyboard handler so the
             * form can lock down during submission.
             */}
            <div
              role="radiogroup"
              aria-labelledby="intake-audience-level-label"
              className="grid grid-cols-2 gap-1.5"
              onKeyDown={(e) => {
                if (disabled) return;
                if (
                  e.key !== "ArrowLeft" &&
                  e.key !== "ArrowRight" &&
                  e.key !== "ArrowUp" &&
                  e.key !== "ArrowDown" &&
                  e.key !== "Home" &&
                  e.key !== "End"
                )
                  return;
                e.preventDefault();
                const currentIdx = ALL_LEVELS.findIndex(
                  (o) => o.value === audienceLevel,
                );
                let nextIdx = currentIdx;
                if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                  nextIdx =
                    currentIdx <= 0 ? ALL_LEVELS.length - 1 : currentIdx - 1;
                } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                  nextIdx =
                    currentIdx === ALL_LEVELS.length - 1 ? 0 : currentIdx + 1;
                } else if (e.key === "Home") nextIdx = 0;
                else if (e.key === "End") nextIdx = ALL_LEVELS.length - 1;
                setAudienceLevel(ALL_LEVELS[nextIdx].value);
              }}
            >
              {ALL_LEVELS.map((opt) => {
                const checked = audienceLevel === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    // Roving tabindex: only the checked option (or the
                    // first one when nothing is selected yet) is in the
                    // tab order, so Tab moves into and out of the group
                    // as a unit rather than visiting every option.
                    tabIndex={checked ? 0 : -1}
                    disabled={disabled}
                    onClick={() => setAudienceLevel(opt.value)}
                    className={
                      "rounded-md border px-2.5 py-1.5 text-left text-[12.5px] transition disabled:opacity-50 " +
                      (checked
                        ? "border-[var(--secondary)] bg-[var(--secondary)]/15 text-[var(--secondary)]"
                        : "border-[var(--border)] bg-[var(--background)]/60 hover:border-[var(--secondary)]/60 hover:bg-[var(--secondary)]/5")
                    }
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {fields.has("prior_knowledge") ? (
          <div className="space-y-1.5">
            <label className="font-mono text-[10.5px] uppercase tracking-wider text-[var(--muted-foreground)]">
              Prior knowledge
              <span className="ml-1 text-[var(--muted-foreground)]/70 normal-case">
                (press Enter or comma to add)
              </span>
            </label>
            <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 focus-within:border-[var(--primary)] focus-within:ring-1 focus-within:ring-[var(--primary)]/40">
              {priorKnowledge.map((tag, i) => (
                <span
                  key={`${tag}-${i}`}
                  className="inline-flex items-center gap-1 rounded-full bg-[var(--secondary)]/15 px-2 py-0.5 text-[12px] text-[var(--secondary)]"
                >
                  {tag}
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => removePrior(i)}
                    className="rounded-full hover:bg-[var(--secondary)]/25 disabled:opacity-50"
                    aria-label={`Remove ${tag}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <input
                value={priorDraft}
                onChange={(e) => setPriorDraft(e.target.value)}
                onKeyDown={onPriorKey}
                onBlur={commitPriorDraft}
                disabled={disabled}
                placeholder={
                  priorKnowledge.length
                    ? ""
                    : "e.g. basic algebra, intro to functions"
                }
                className="min-w-[8ch] flex-1 bg-transparent text-[12.5px] outline-none disabled:opacity-50"
              />
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          {fields.has("duration_hours") ? (
            <div className="space-y-1.5">
              <label
                htmlFor="intake-duration"
                className="font-mono text-[10.5px] uppercase tracking-wider text-[var(--muted-foreground)]"
              >
                Duration (hours)
              </label>
              <input
                id="intake-duration"
                type="number"
                min={0.5}
                step={0.5}
                value={durationHours}
                onChange={(e) => setDurationHours(e.target.value)}
                disabled={disabled}
                className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2.5 py-1.5 text-[13px] outline-none transition focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]/40 disabled:opacity-50"
              />
            </div>
          ) : null}

          {fields.has("language") ? (
            <div className="space-y-1.5">
              <label
                htmlFor="intake-lang"
                className="font-mono text-[10.5px] uppercase tracking-wider text-[var(--muted-foreground)]"
              >
                Language
              </label>
              <input
                id="intake-lang"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                disabled={disabled}
                placeholder="English"
                className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2.5 py-1.5 text-[13px] outline-none transition focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]/40 disabled:opacity-50"
              />
            </div>
          ) : null}
        </div>

        {fields.has("target_outcome") ? (
          <div className="space-y-1.5">
            <label
              htmlFor="intake-outcome"
              className="font-mono text-[10.5px] uppercase tracking-wider text-[var(--muted-foreground)]"
            >
              Target outcome
              <span className="ml-1 text-[var(--muted-foreground)]/70 normal-case">
                (one sentence — what students should be able to do)
              </span>
            </label>
            <textarea
              id="intake-outcome"
              value={targetOutcome}
              onChange={(e) => setTargetOutcome(e.target.value)}
              disabled={disabled}
              rows={2}
              placeholder="e.g. Apply derivative rules to one-variable optimization problems."
              className="w-full resize-none rounded-md border border-[var(--border)] bg-[var(--background)] px-2.5 py-1.5 text-[13px] outline-none transition focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]/40 disabled:opacity-50"
            />
          </div>
        ) : null}

        <div className="flex justify-end pt-1">
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--primary)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--primary-foreground)] transition hover:opacity-95 disabled:opacity-50"
          >
            <Send className="h-3.5 w-3.5" />
            Start research
          </button>
        </div>
      </form>
    </section>
  );
}

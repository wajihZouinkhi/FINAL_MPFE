"use client";

import { useMemo, useState } from "react";
import { ClipboardList, Send, Sparkles } from "lucide-react";
import type {
  ActivityDifficulty,
  ActivityIntakeFormAnswer,
  AgentInterrupt,
} from "@mpfe/shared";

/**
 * Structured intake form rendered when an activity-generator agent emits
 * an interrupt with `kind === "activity_intake"`. Mirrors IntakeCard's UX
 * (typed JSON resume payload, server-side Zod validation, persisted in
 * `interrupt_history` for the Q&A trail) with worksheet-specific fields.
 *
 * Lesson selection is rendered ONLY when the agent provides a non-empty
 * `lessons_menu` — the toolless agent leaves it empty and the form
 * skips that section entirely.
 */
const DIFFICULTIES: Array<{
  value: ActivityDifficulty;
  label: string;
  hint: string;
}> = [
  { value: "easy", label: "Easy", hint: "Recall and recognition" },
  { value: "medium", label: "Medium", hint: "Apply and explain" },
  { value: "hard", label: "Hard", hint: "Synthesize and evaluate" },
];

export function ActivityIntakeCard({
  interrupt,
  disabled,
  onSubmit,
}: {
  interrupt: AgentInterrupt;
  disabled?: boolean;
  onSubmit: (answer: ActivityIntakeFormAnswer) => void;
}) {
  const spec = interrupt.activity_intake;
  const fields = useMemo(
    () =>
      new Set(
        spec?.fields ?? [
          "difficulty",
          "mcq_count",
          "short_answer_count",
          "include_worked_example",
          "language",
        ],
      ),
    [spec],
  );
  const lessonsMenu = spec?.lessons_menu ?? [];

  const [lessonIds, setLessonIds] = useState<string[]>(
    spec?.defaults?.lesson_ids?.length
      ? spec.defaults.lesson_ids
      : lessonsMenu[0]
        ? [lessonsMenu[0].id]
        : [],
  );
  const [difficulty, setDifficulty] = useState<ActivityDifficulty>(
    (spec?.defaults?.difficulty as ActivityDifficulty | undefined) ?? "medium",
  );
  const [mcqCount, setMcqCount] = useState<number>(
    spec?.defaults?.mcq_count ?? 4,
  );
  const [shortAnswerCount, setShortAnswerCount] = useState<number>(
    spec?.defaults?.short_answer_count ?? 1,
  );
  const [includeWorkedExample, setIncludeWorkedExample] = useState<boolean>(
    spec?.defaults?.include_worked_example ?? true,
  );
  const [language, setLanguage] = useState<string>(
    spec?.defaults?.language ?? "English",
  );

  const toggleLesson = (id: string) => {
    setLessonIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  // Lesson picker is required only when the agent supplied a menu (tooled
  // mode). Toolless mode leaves lessonsMenu empty and lesson_ids defaults
  // to the empty array, which the API accepts.
  const needsLesson = lessonsMenu.length > 0 && fields.has("lesson_ids");
  const canSubmit =
    !disabled &&
    (!needsLesson || lessonIds.length > 0) &&
    mcqCount >= 1 &&
    mcqCount <= 8 &&
    shortAnswerCount >= 0 &&
    shortAnswerCount <= 3 &&
    language.trim().length > 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const answer: ActivityIntakeFormAnswer = {
      lesson_ids: needsLesson ? lessonIds : [],
      difficulty,
      mcq_count: mcqCount,
      short_answer_count: shortAnswerCount,
      include_worked_example: includeWorkedExample,
      language: language.trim(),
      answered_at: new Date().toISOString(),
    };
    onSubmit(answer);
  };

  return (
    <section className="animate-fade-in overflow-hidden rounded-lg border border-[var(--secondary)]/45 bg-[var(--card)] shadow-[0_8px_32px_-12px_rgba(252,175,65,0.25)]">
      <header className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--secondary)]/10 px-3 py-2">
        <ClipboardList className="h-3.5 w-3.5 text-[var(--secondary)]" />
        <span className="text-[13px] font-semibold text-[var(--secondary)]">
          Worksheet setup
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

        {needsLesson ? (
          <fieldset className="space-y-1.5">
            <legend className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
              Lessons to ground in
            </legend>
            <div className="max-h-44 overflow-y-auto rounded border border-[var(--border)] bg-[var(--background)]/40">
              {lessonsMenu.map((l) => {
                const checked = lessonIds.includes(l.id);
                return (
                  <label
                    key={l.id}
                    className={
                      "flex cursor-pointer items-start gap-2 border-b border-[var(--border)]/50 px-2.5 py-2 last:border-b-0 hover:bg-[var(--secondary)]/5 " +
                      (checked ? "bg-[var(--secondary)]/10" : "")
                    }
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-[var(--secondary)]"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggleLesson(l.id)}
                    />
                    <span className="flex min-w-0 flex-col leading-tight">
                      <span className="truncate text-[13px] font-medium">
                        {l.title}
                      </span>
                      {l.chapter_title ? (
                        <span className="truncate text-[11px] text-[var(--muted-foreground)]">
                          {l.chapter_title}
                        </span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="text-[10.5px] text-[var(--muted-foreground)]">
              Pick at least one. The first selected lesson is used for this
              worksheet; extras are saved for follow-up turns.
            </p>
          </fieldset>
        ) : null}

        {fields.has("difficulty") ? (
          <fieldset className="space-y-1.5">
            <legend
              id="activity-intake-difficulty-label"
              className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]"
            >
              Difficulty
            </legend>
            {/*
             * Audit §4.3: same buttons-as-radios fix as the syllabus
             * intake. role="radiogroup" + role="radio" + aria-checked
             * announce single-select semantics; arrow keys navigate
             * within the group with wrap-around; Home/End jump to ends;
             * a roving tabindex keeps Tab moving into/out of the
             * group as a unit instead of visiting every option.
             */}
            <div
              role="radiogroup"
              aria-labelledby="activity-intake-difficulty-label"
              className="grid grid-cols-3 gap-1.5"
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
                const currentIdx = DIFFICULTIES.findIndex(
                  (d) => d.value === difficulty,
                );
                let nextIdx = currentIdx;
                if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                  nextIdx =
                    currentIdx <= 0 ? DIFFICULTIES.length - 1 : currentIdx - 1;
                } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                  nextIdx =
                    currentIdx === DIFFICULTIES.length - 1 ? 0 : currentIdx + 1;
                } else if (e.key === "Home") nextIdx = 0;
                else if (e.key === "End") nextIdx = DIFFICULTIES.length - 1;
                setDifficulty(DIFFICULTIES[nextIdx].value);
              }}
            >
              {DIFFICULTIES.map((d) => {
                const checked = difficulty === d.value;
                return (
                  <button
                    key={d.value}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    tabIndex={checked ? 0 : -1}
                    disabled={disabled}
                    onClick={() => setDifficulty(d.value)}
                    className={
                      "rounded border px-2 py-1.5 text-left text-[12px] transition-colors " +
                      (checked
                        ? "border-[var(--secondary)] bg-[var(--secondary)]/15 text-[var(--foreground)]"
                        : "border-[var(--border)] bg-[var(--background)]/40 text-[var(--muted-foreground)] hover:border-[var(--secondary)]/50")
                    }
                  >
                    <span className="block text-[12.5px] font-semibold capitalize">
                      {d.label}
                    </span>
                    <span className="block text-[10.5px] opacity-80">
                      {d.hint}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          {fields.has("mcq_count") ? (
            <fieldset className="space-y-1">
              <legend className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                MCQs ({mcqCount})
              </legend>
              <input
                type="range"
                min={1}
                max={8}
                step={1}
                value={mcqCount}
                disabled={disabled}
                onChange={(e) => setMcqCount(Number(e.target.value))}
                className="w-full accent-[var(--secondary)]"
              />
            </fieldset>
          ) : null}
          {fields.has("short_answer_count") ? (
            <fieldset className="space-y-1">
              <legend className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                Short answers ({shortAnswerCount})
              </legend>
              <input
                type="range"
                min={0}
                max={3}
                step={1}
                value={shortAnswerCount}
                disabled={disabled}
                onChange={(e) => setShortAnswerCount(Number(e.target.value))}
                className="w-full accent-[var(--secondary)]"
              />
            </fieldset>
          ) : null}
        </div>

        {fields.has("include_worked_example") ? (
          <label className="flex cursor-pointer items-center gap-2 text-[12.5px]">
            <input
              type="checkbox"
              className="accent-[var(--secondary)]"
              checked={includeWorkedExample}
              disabled={disabled}
              onChange={(e) => setIncludeWorkedExample(e.target.checked)}
            />
            <span>Include a worked example</span>
          </label>
        ) : null}

        {fields.has("language") ? (
          <fieldset className="space-y-1">
            <legend className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
              Output language
            </legend>
            <input
              type="text"
              value={language}
              disabled={disabled}
              onChange={(e) => setLanguage(e.target.value)}
              placeholder="English"
              className="w-full rounded border border-[var(--border)] bg-[var(--background)]/40 px-2 py-1.5 text-[13px] focus:border-[var(--secondary)] focus:outline-none"
            />
          </fieldset>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="submit"
            disabled={!canSubmit}
            className={
              "inline-flex items-center gap-1.5 rounded-md bg-[var(--secondary)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--secondary-foreground)] transition-opacity " +
              (!canSubmit ? "opacity-50" : "hover:opacity-90")
            }
          >
            <Send className="h-3 w-3" />
            Generate worksheet
          </button>
        </div>
      </form>
    </section>
  );
}

"use client";

/**
 * Pedagogical-contract chips for the Viewer.
 *
 * The contract (audience / scope / pedagogy at the syllabus level;
 * outcomes / prerequisites at the chapter level; learning objectives /
 * prerequisites / key terms / worked-example seed / assessment idea /
 * duration at the lesson level) is now produced by the supervisor v2
 * prompt and stored in Postgres alongside the lesson markdown. Without
 * surfacing it visually, a teacher reading the lesson can't see WHY the
 * lesson is shaped the way it is or what the syllabus design intent was.
 *
 * These three components render the contract as inline chip rows /
 * cards that sit ABOVE the markdown body. They render nothing when the
 * contract is empty (pre-v2 rows / partial supervisor output), so old
 * threads keep looking exactly the same.
 */

import {
  BookOpen,
  Clock,
  GraduationCap,
  Layers,
  Link2,
  ListChecks,
  Sparkles,
  Target,
  Wrench,
} from "lucide-react";
import type {
  Audience,
  ChapterRow,
  LearningObjective,
  LessonRow,
  Pedagogy,
  Scope,
  SyllabusRow,
} from "@mpfe/shared";

// ─── helpers ───────────────────────────────────────────────────────────────

/**
 * Format an integer minute count as a compact human label. 0 / negative
 * collapses to null so the chip can be hidden entirely.
 */
function formatDuration(min: number | null | undefined): string | null {
  if (!min || min <= 0) return null;
  if (min < 60) return `${min} min`;
  const hours = min / 60;
  // Trim trailing .0 so 60 → "1h", 90 → "1.5h", 180 → "3h".
  const trimmed = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  return `${trimmed}h`;
}

/**
 * Sum the duration_min across every lesson in a chapter / syllabus.
 * Returns 0 if no lesson carries a duration so callers can collapse the
 * chip rather than rendering "0 min".
 */
function sumLessonDurations(lessons: LessonRow[]): number {
  return lessons.reduce((n, l) => n + (l.duration_min ?? 0), 0);
}

/**
 * Capitalised, human-readable Bloom badge text. The enum values are
 * already lowercase English; this just title-cases them so the chip
 * reads as "Apply" not "apply".
 */
function bloomLabel(level: LearningObjective["bloom_level"]): string {
  return level.charAt(0).toUpperCase() + level.slice(1);
}

/**
 * Map a Bloom level to a tailwind colour class. Higher levels in
 * Bloom's revised taxonomy get warmer colours; this matches the
 * intuition that "create" is more demanding than "remember".
 */
function bloomColor(level: LearningObjective["bloom_level"]): string {
  switch (level) {
    case "remember":
      return "bg-slate-500/15 text-slate-300";
    case "understand":
      return "bg-sky-500/15 text-sky-300";
    case "apply":
      return "bg-emerald-500/15 text-emerald-300";
    case "analyze":
      return "bg-amber-500/15 text-amber-300";
    case "evaluate":
      return "bg-orange-500/15 text-orange-300";
    case "create":
      return "bg-fuchsia-500/15 text-fuchsia-300";
    default:
      return "bg-slate-500/15 text-slate-300";
  }
}

// ─── primitives ────────────────────────────────────────────────────────────

/** Generic outlined chip — used by every contract field. */
function Chip({
  icon,
  label,
  title,
  className,
}: {
  icon?: React.ReactNode;
  label: string;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={
        "inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--card)]/60 px-2 py-0.5 text-[11px] text-[var(--foreground)]/85 " +
        (className ?? "")
      }
    >
      {icon}
      {label}
    </span>
  );
}

/** Section title used inside the lesson-contract band. */
function SectionLabel({
  icon,
  text,
}: {
  icon: React.ReactNode;
  text: string;
}) {
  return (
    <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
      {icon}
      {text}
    </div>
  );
}

// ─── per-lesson header band ────────────────────────────────────────────────

/**
 * Renders ABOVE the lesson markdown when the contract is non-empty.
 * Layout:
 *   [audience · duration · top-bloom chips row]
 *   [Learning objectives card with Bloom badge per LO]
 *   [Prerequisites chip row]
 *   [Depends on chip row — links back to the dep lessons]
 *   [Key terms chip row]
 *   [Optional collapsed worked-example seed / assessment idea]
 *
 * Audience is passed in separately because it lives on the syllabus row,
 * not the lesson row, but is the most relevant context for reading the
 * lesson. We thread it through from the Viewer.
 */
export function LessonContractHeader({
  lesson,
  audience,
  dependencies,
  onPickLesson,
}: {
  lesson: LessonRow;
  audience?: Audience | null;
  /**
   * Resolved view of `lesson.depends_on`. The Viewer walks the
   * snapshot to translate UUIDs into titles + chapter labels (it's
   * the only place that has the snapshot in scope) so the header
   * can render a chip per dep without having to reach into the
   * agent store. Empty / omitted means "no deps to show".
   */
  dependencies?: ReadonlyArray<{
    id: string;
    title: string;
    chapterTitle: string;
  }>;
  /**
   * Called when the teacher clicks one of the dependency chips. Wired
   * by the Viewer to its `setActiveLesson` action so clicking a chip
   * navigates the right pane to that lesson. Omitted in read-only
   * surfaces — the chips render as static labels in that case.
   */
  onPickLesson?: (lessonId: string) => void;
}) {
  const objectives = lesson.learning_objectives ?? [];
  const prerequisites = lesson.prerequisites ?? [];
  const keyTerms = lesson.key_terms ?? [];
  const seed = lesson.worked_example_seed ?? "";
  const assessment = lesson.assessment_idea ?? "";
  const duration = formatDuration(lesson.duration_min);

  // Calculate the highest Bloom level reached across the LOs so the
  // header gives an at-a-glance "this is an apply-level lesson" cue
  // without making the teacher count badges.
  const topBloom = topBloomLevel(objectives);

  const deps = dependencies ?? [];

  // If there's literally nothing to show (pre-v2 row / partial output),
  // return null so the Viewer falls back to its current layout.
  const hasAnything =
    objectives.length > 0 ||
    prerequisites.length > 0 ||
    keyTerms.length > 0 ||
    duration ||
    audience?.level ||
    seed ||
    assessment ||
    deps.length > 0;
  if (!hasAnything) return null;

  return (
    <div className="not-prose mb-6 space-y-3 rounded-xl border border-[var(--border)] bg-[var(--card)]/40 p-4">
      {/* Top row — high-level chips that summarize the lesson at a glance. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {audience?.level ? (
          <Chip
            icon={<GraduationCap className="h-3 w-3" />}
            label={audience.level}
            title="Audience level"
            className="capitalize"
          />
        ) : null}
        {duration ? (
          <Chip
            icon={<Clock className="h-3 w-3" />}
            label={duration}
            title="Lesson duration"
          />
        ) : null}
        {topBloom ? (
          <Chip
            icon={<Sparkles className="h-3 w-3" />}
            label={`Bloom: ${bloomLabel(topBloom)}`}
            title="Highest Bloom level reached by this lesson's objectives"
            className={bloomColor(topBloom)}
          />
        ) : null}
      </div>

      {objectives.length > 0 ? (
        <div className="space-y-1.5">
          <SectionLabel
            icon={<Target className="h-3 w-3" />}
            text="Learning objectives"
          />
          <ul className="space-y-1">
            {objectives.map((o, i) => (
              <li
                key={i}
                className="flex items-start gap-2 text-[12.5px] leading-snug text-[var(--foreground)]/90"
              >
                <span
                  className={
                    "mt-0.5 inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wider " +
                    bloomColor(o.bloom_level)
                  }
                  title={`Bloom level: ${bloomLabel(o.bloom_level)}`}
                >
                  {bloomLabel(o.bloom_level)}
                </span>
                <span className="flex-1">{o.text}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {prerequisites.length > 0 ? (
        <div className="space-y-1.5">
          <SectionLabel
            icon={<ListChecks className="h-3 w-3" />}
            text="Prerequisites"
          />
          <div className="flex flex-wrap gap-1.5">
            {prerequisites.map((p, i) => (
              <Chip key={i} label={p} />
            ))}
          </div>
        </div>
      ) : null}

      {deps.length > 0 ? (
        <div className="space-y-1.5">
          <SectionLabel
            icon={<Link2 className="h-3 w-3" />}
            text="Depends on"
          />
          <div className="flex flex-wrap gap-1.5">
            {deps.map((d) =>
              onPickLesson ? (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => onPickLesson(d.id)}
                  title={`Open “${d.title}” (chapter: ${d.chapterTitle})`}
                  className="inline-flex max-w-[14rem] items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--card)]/60 px-2 py-0.5 text-[11px] text-[var(--foreground)]/85 transition hover:border-[var(--secondary)]/50 hover:text-[var(--secondary)]"
                >
                  <Link2 className="h-3 w-3 shrink-0" />
                  <span className="truncate">{d.title}</span>
                </button>
              ) : (
                <Chip
                  key={d.id}
                  icon={<Link2 className="h-3 w-3" />}
                  label={d.title}
                  title={`Chapter: ${d.chapterTitle}`}
                />
              ),
            )}
          </div>
        </div>
      ) : null}

      {keyTerms.length > 0 ? (
        <div className="space-y-1.5">
          <SectionLabel
            icon={<BookOpen className="h-3 w-3" />}
            text="Key terms"
          />
          <div className="flex flex-wrap gap-1.5">
            {keyTerms.map((t, i) => (
              <Chip key={i} label={t} />
            ))}
          </div>
        </div>
      ) : null}

      {seed || assessment ? (
        // Wrap seed + assessment idea in a <details> so the band stays
        // compact by default — these are design notes for the teacher,
        // useful but secondary to the lesson body.
        <details className="group rounded-md border border-[var(--border)]/60 bg-[var(--background)]/40 p-2.5">
          <summary className="flex cursor-pointer items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-[var(--muted-foreground)] outline-none">
            <Wrench className="h-3 w-3" />
            Design notes
          </summary>
          <div className="mt-2 space-y-2 text-[12.5px] leading-snug text-[var(--foreground)]/85">
            {seed ? (
              <div>
                <span className="mr-1 text-[10.5px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
                  Worked-example seed
                </span>
                <p className="mt-0.5">{seed}</p>
              </div>
            ) : null}
            {assessment ? (
              <div>
                <span className="mr-1 text-[10.5px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
                  Assessment idea
                </span>
                <p className="mt-0.5">{assessment}</p>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}

/** Pick the highest Bloom level present across a list of objectives. */
function topBloomLevel(
  objectives: LearningObjective[],
): LearningObjective["bloom_level"] | null {
  if (objectives.length === 0) return null;
  const order: LearningObjective["bloom_level"][] = [
    "remember",
    "understand",
    "apply",
    "analyze",
    "evaluate",
    "create",
  ];
  let best = -1;
  for (const o of objectives) {
    const idx = order.indexOf(o.bloom_level);
    if (idx > best) best = idx;
  }
  return best === -1 ? null : order[best];
}

// ─── per-chapter header ────────────────────────────────────────────────────

/**
 * Renders ABOVE the chapter lesson list in the chapter-summary view.
 * Surfaces chapter-level outcomes / prerequisites + a duration roll-up
 * across the chapter's lessons. Returns null when nothing is set.
 */
export function ChapterContractHeader({
  chapter,
  lessons,
}: {
  chapter: ChapterRow;
  lessons: LessonRow[];
}) {
  const outcomes = chapter.outcomes ?? [];
  const prerequisites = chapter.prerequisites ?? [];
  const totalMin = sumLessonDurations(lessons);
  const duration = formatDuration(totalMin);
  if (outcomes.length === 0 && prerequisites.length === 0 && !duration)
    return null;

  return (
    <div className="not-prose mb-5 space-y-3 rounded-xl border border-[var(--border)] bg-[var(--card)]/40 p-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {duration ? (
          <Chip
            icon={<Clock className="h-3 w-3" />}
            label={duration}
            title="Total chapter duration (sum of lesson durations)"
          />
        ) : null}
      </div>

      {outcomes.length > 0 ? (
        <div className="space-y-1.5">
          <SectionLabel
            icon={<Target className="h-3 w-3" />}
            text="Chapter outcomes"
          />
          <ul className="ml-4 list-disc space-y-0.5 text-[12.5px] leading-snug text-[var(--foreground)]/90">
            {outcomes.map((o, i) => (
              <li key={i}>{o}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {prerequisites.length > 0 ? (
        <div className="space-y-1.5">
          <SectionLabel
            icon={<ListChecks className="h-3 w-3" />}
            text="Prerequisites"
          />
          <div className="flex flex-wrap gap-1.5">
            {prerequisites.map((p, i) => (
              <Chip key={i} label={p} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── per-syllabus header ───────────────────────────────────────────────────

/**
 * Renders ABOVE the chapter list in the overview. Shows the audience
 * level / language / scope target + pedagogy style/assessment as chips.
 * Returns null when nothing is set.
 *
 * `audience` / `scope` / `pedagogy` come from the SyllabusRow and may
 * legitimately be null on pre-v2 rows. We accept them as `unknown`
 * here and narrow inline to keep the call site at the Viewer simple.
 */
export function SyllabusContractHeader({
  syllabus,
  totalDurationMin,
}: {
  syllabus: SyllabusRow;
  totalDurationMin: number;
}) {
  const audience = (syllabus.audience ?? null) as Audience | null;
  const scope = (syllabus.scope ?? null) as Scope | null;
  const pedagogy = (syllabus.pedagogy ?? null) as Pedagogy | null;
  const duration = formatDuration(totalDurationMin);

  const chips: React.ReactNode[] = [];
  if (audience?.level)
    chips.push(
      <Chip
        key="level"
        icon={<GraduationCap className="h-3 w-3" />}
        label={audience.level}
        title="Audience level"
        className="capitalize"
      />,
    );
  if (audience?.language && audience.language.toLowerCase() !== "english")
    chips.push(
      <Chip
        key="language"
        label={audience.language}
        title="Lesson language"
      />,
    );
  if (duration)
    chips.push(
      <Chip
        key="duration"
        icon={<Clock className="h-3 w-3" />}
        label={duration}
        title="Total syllabus duration (sum of lesson durations)"
      />,
    );
  if (pedagogy?.style)
    chips.push(
      <Chip
        key="style"
        icon={<Layers className="h-3 w-3" />}
        label={pedagogy.style.replace("_", " ")}
        title="Pedagogy style"
        className="capitalize"
      />,
    );
  if (pedagogy?.assessment)
    chips.push(
      <Chip
        key="assessment"
        label={`${pedagogy.assessment} assessment`}
        title="Assessment mode"
        className="capitalize"
      />,
    );

  if (chips.length === 0 && !scope?.target_outcome) return null;

  return (
    <div className="mb-6 space-y-2 rounded-xl border border-[var(--border)] bg-[var(--card)]/40 p-4">
      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">{chips}</div>
      ) : null}
      {scope?.target_outcome ? (
        <p className="text-[12.5px] leading-snug text-[var(--foreground)]/85">
          <span className="mr-1 font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
            Target outcome:
          </span>
          {scope.target_outcome}
        </p>
      ) : null}
    </div>
  );
}

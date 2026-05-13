import { Injectable, Logger } from "@nestjs/common";
import {
  GraphStateType,
  patchManifestItem,
  patchTodoStep,
} from "../state";
import { LlmConfigService } from "../../config/llm-config.service";
import { CacheService } from "../../cache/cache.service";
import { SupabaseService } from "../../supabase/supabase.service";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { dispatchLlmUsage } from "../streaming/llm-usage-event";
import { z } from "zod";
import type {
  ManifestItem,
  PlannedLesson,
  SyllabusPlan,
  TodoPlan,
} from "@mpfe/shared";
import {
  applySearchReplaceBlocks,
  parseSearchReplaceBlocks,
} from "./patch";

// Critic v2 output — severity-aware so the orchestrator can force-pass on
// `warn`/`nit` issues while NEVER force-passing on `block` issues. The MVP
// critic returned a binary {pass, issues}; that meant a draft with one
// nitpick about phrasing got the same treatment as a draft that
// hallucinated a fact, which produced lessons committed despite real
// pedagogical defects. The new shape carries a category so the FE can
// surface them ("LO alignment failed" vs. "wording")
// and the writer's revision prompt can target the right issue first.
const CriticIssueSeverity = z.enum(["block", "warn", "nit"]);
const CriticIssueCategory = z.enum([
  "lo_alignment",
  "grounding",
  "language",
  "pedagogy",
  "structure",
  "duplication",
  "wording",
  "leakage",
  "other",
]);
const CriticIssue = z.object({
  severity: CriticIssueSeverity,
  category: CriticIssueCategory,
  detail: z.string().min(1),
});
const CriticOutput = z.object({
  pass: z.boolean(),
  issues: z.array(CriticIssue).default([]),
});
type CriticIssueT = z.infer<typeof CriticIssue>;

// Single-shot critic contract: the writer is invoked once, the critic is
// invoked AT MOST once, and on a critic failure the writer is invoked
// exactly one more time (in revision mode against the critic's issues)
// before the lesson is committed. The committed-after-revision case is
// COMMITTED AS-ACCEPTED — we deliberately do NOT re-critique to verify
// the revision (that would re-introduce a loop) and we deliberately
// drop the critic's findings on the floor at persist time so the FE
// doesn't have to surface a "review me" badge a teacher would only have
// to dismiss manually. Zero trace of the revision lands on the lesson
// row, manifest, or todo plan; the writer's second pass is its own
// reward.
//
// Concretely: on a fresh lesson the orchestrator does up to one writer
// call, one critic call, and one revision-mode writer call (patch path
// with full-rewrite fallback). The fingerprint-deadlock short-circuit
// from the prior multi-revision design is gone — with a single revision
// budget there is no "two cycles produced the same block-issues"
// comparison to make.
const MAX_REVISIONS = 1;

/**
 * Audience-aware word-count target for a single lesson. School learners
 * benefit from short, focused lessons; grad / professional learners can
 * absorb longer, denser content. The critic enforces ±200 around these.
 */
function wordTargetForAudience(level: string): { lo: number; hi: number } {
  switch (level) {
    case "school":
      return { lo: 500, hi: 900 };
    case "grad":
    case "professional":
      return { lo: 1000, hi: 1800 };
    case "undergrad":
    default:
      return { lo: 800, hi: 1500 };
  }
}

/** Block before warn before nit, used to sort revision instructions. */
function severityRank(s: "block" | "warn" | "nit"): number {
  return s === "block" ? 0 : s === "warn" ? 1 : 2;
}

/**
 * Approximate word count of a Markdown body via whitespace splitting.
 * Used to truncate prereq-lesson excerpts to a fixed ceiling so a deep
 * dependency chain doesn't blow the writer-tier context window.
 */
function takeWords(text: string, maxWords: number): string {
  const tokens = text.trim().split(/\s+/);
  if (tokens.length <= maxWords) return text.trim();
  return tokens.slice(0, maxWords).join(" ") + "\u2026";
}

/**
 * Per-prereq excerpt cap. ~600 words covers the H1 + Learning
 * objectives + Concept walkthrough opener of a typical undergrad
 * lesson, which is what a dependent lesson normally needs to reference
 * ("the recursion pattern from Lesson 1.2"). Past that, the writer
 * tends to fixate on tangents instead of building forward.
 */
const PREREQ_EXCERPT_WORDS = 600;

/**
 * Command nodes: write lessons into Supabase.
 *   seed_plans → commit_syllabus → write_one (ONE WAVE per invocation:
 *   every lesson whose `depends_on` set is already in
 *   `committed_lesson_ids` is processed in parallel via Promise.all;
 *   each one runs writer → critic → if pass commit, else
 *   writer-revision-once → commit. Findings are dropped after the
 *   commit — see MAX_REVISIONS comment) → finalize (flips phase back
 *   to `chatting`).
 *
 *   Single critic call per lesson, at most one revision pass, no loop
 *   per lesson. Chapters AND lessons within a chapter are written in
 *   parallel — the only ordering constraint is `lesson.depends_on`.
 *
 * These nodes are wired DIRECTLY into the parent graph (no compiled
 * subgraph). Compiled subgraphs in LangGraph JS execute as a single
 * parent step: their internal node returns are NOT propagated to the
 * parent's checkpointer until the subgraph completes, AND their inner
 * `on_chain_end` events are not surfaced on the parent's `streamEvents`
 * v2 stream. That made `/state` return `todo_plan: null` mid-write and
 * the FE TodoCard never received per-lesson updates over SSE — even
 * though the per-lesson graph cycle was correctly emitting them inside
 * the subgraph. Inlining the nodes means every WAVE transition is a
 * parent-level checkpoint, and per-lesson status flips inside the wave
 * are still surfaced live via `dispatchCustomEvent("todo_progress")`
 * (the chat controller re-emits them over SSE). Reload mid-wave
 * resumes from the last committed snapshot.
 *
 * Idempotency: the syllabus / chapter / lesson UUIDs are pre-allocated by
 * the supervisor in `state.syllabus_plan`, so retries become UPSERTs by
 * primary key — no duplicate rows on transient failures.
 */
@Injectable()
export class CommandSubgraph {
  private readonly logger = new Logger(CommandSubgraph.name);

  constructor(
    private readonly llm: LlmConfigService,
    private readonly cache: CacheService,
    private readonly supa: SupabaseService,
  ) {}

  /** Total number of lessons across all chapters in the current plan. */
  totalLessons(state: GraphStateType): number {
    return (state.syllabus_plan?.chapters ?? []).reduce(
      (n, c) => n + c.lessons.length,
      0,
    );
  }

  /**
   * Seed both `todo_plan` and `manifest` from the structured plan so the
   * frontend has the full syllabus shape before any lesson starts writing.
   * Also resets `committed_lesson_ids` so re-entries (a thread asking
   * the supervisor to rewrite from scratch) start the wave scheduler
   * from an empty committed set.
   *
   * The manifest entries carry `depends_on` from the plan so the FE
   * FileTree can render the "depends on …" inline line under each
   * lesson title from the very first slice, before any lesson is
   * committed.
   */
  async seedPlans(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    const plan = state.syllabus_plan;
    if (!plan) return {};
    let todo: TodoPlan | null = { steps: [] };
    let manifest: ManifestItem[] = [];
    for (const ch of plan.chapters) {
      for (const l of ch.lessons) {
        todo = patchTodoStep(todo, {
          id: l.id,
          chapter_ref: ch.title,
          name: l.title,
          status: "pending",
          attempts: 0,
        });
        manifest = patchManifestItem(manifest, {
          id: l.id,
          title: l.title,
          chapter_title: ch.title,
          status: "pending",
          db_id: null,
          depends_on: l.depends_on ?? [],
        });
      }
    }
    return {
      phase: "writing",
      todo_plan: todo,
      manifest,
      committed_lesson_ids: [],
    };
  }

  /** Idempotent UPSERT of syllabus + chapters before any lesson is written. */
  async commitSyllabus(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    const plan = state.syllabus_plan;
    if (!plan) return {};
    const supa = this.supa.client;

    const { error: sErr } = await supa.from("syllabuses").upsert(
      {
        id: plan.syllabus_id,
        thread_id: state.thread_id,
        title: plan.title,
        description: plan.description,
        // Pedagogical contract — stored as JSON so the FE Viewer can
        // render audience / scope / pedagogy chips on the syllabus
        // overview page. Null on v1 plans.
        audience: plan.audience ?? null,
        scope: plan.scope ?? null,
        pedagogy: plan.pedagogy ?? null,
      },
      { onConflict: "id" },
    );
    if (sErr) throw sErr;

    const chapterRows = plan.chapters.map((c) => ({
      id: c.id,
      syllabus_id: plan.syllabus_id,
      title: c.title,
      order_index: c.order_index,
      outcomes: c.outcomes ?? [],
      prerequisites: c.prerequisites ?? [],
    }));
    const { error: cErr } = await supa
      .from("chapters")
      .upsert(chapterRows, { onConflict: "id" });
    if (cErr) throw cErr;

    return {};
  }

  /**
   * Find every uncommitted lesson whose `depends_on` set is already in
   * `committed_lesson_ids` — i.e. the set of lessons that are eligible
   * to run RIGHT NOW. Used by `writeOne` to schedule a wave and by
   * `graph.service`'s conditional edge to decide loop-vs-finalize
   * (the loop terminates when this returns an empty array even though
   * lessons remain pending — a deadlock that the supervisor's
   * forward-ref drop in `buildPlan` should prevent in practice, but
   * we guard against it defensively so a malformed plan can't hang the
   * graph).
   */
  readyLessons(state: GraphStateType): Array<{
    ch: SyllabusPlan["chapters"][number];
    lesson: PlannedLesson;
    li: number;
  }> {
    const plan = state.syllabus_plan;
    if (!plan) return [];
    const committed = new Set(state.committed_lesson_ids ?? []);
    const ready: Array<{
      ch: SyllabusPlan["chapters"][number];
      lesson: PlannedLesson;
      li: number;
    }> = [];
    for (const ch of plan.chapters) {
      for (let li = 0; li < ch.lessons.length; li++) {
        const l = ch.lessons[li];
        if (committed.has(l.id)) continue;
        const deps = l.depends_on ?? [];
        if (deps.every((d) => committed.has(d))) {
          ready.push({ ch, lesson: l, li });
        }
      }
    }
    return ready;
  }

  /**
   * Process ONE WAVE of ready lessons in parallel and commit them all
   * before returning. The conditional edge in `graph.service` re-routes
   * back into this node for the next wave until every lesson is
   * committed (or `readyLessons` returns empty, defensively breaking
   * a malformed-plan deadlock — see comment on `readyLessons`).
   *
   * Each lesson runs through the same writer → critic →
   * writer-revision-once gate that the sequential implementation used.
   * Per-lesson status flips are dispatched as
   * `dispatchCustomEvent("todo_progress")` from inside the wave so the
   * FE TodoCard / FileTree see live transitions; the chat controller
   * subscribes and re-emits the typed slice over SSE. Promise.all
   * keeps the lessons truly concurrent (the long pole is the LLM
   * round-trip; Node will overlap N writer+critic calls at the network
   * boundary). Shared closure mutations of `todo` / `manifest` are
   * safe under Node's single-threaded event loop because each
   * `patchTodoStep` / `patchManifestItem` call is atomic between
   * `await` points; id-keyed merges mean sibling branches
   * concurrently writing different lesson ids never clobber each
   * other.
   *
   * If a lesson declares `depends_on` UUIDs, this method fetches each
   * prereq lesson's committed body from Supabase and threads them into
   * the writer + critic prompts as `PRIOR LESSONS YOU DEPEND ON`.
   * Because deps must be in `committed_lesson_ids` for the lesson to
   * be in the wave at all, those rows are guaranteed to be readable.
   */
  async writeOne(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    const plan = state.syllabus_plan;
    if (!plan) return {};

    const ready = this.readyLessons(state);
    if (ready.length === 0) {
      // Either every lesson is committed already (the conditional edge
      // will route to finalize) or the plan is deadlocked. Either way,
      // returning empty is safe — the edge does the routing.
      return {};
    }

    // Mutable shared closures. Each parallel branch reads + writes
    // these via id-keyed merges; under Node's event loop the
    // read-modify-write between `await` points is atomic so different
    // ids never collide.
    let todo = state.todo_plan;
    let manifest = state.manifest;

    const dispatch = async () => {
      try {
        await dispatchCustomEvent("todo_progress", {
          todo_plan: todo,
          manifest,
        });
      } catch (err) {
        this.logger.warn(
          `dispatchCustomEvent(todo_progress) failed: ${(err as Error).message}`,
        );
      }
    };

    // Flip every ready lesson to "writing" up front and emit one
    // initial dispatch so the FE shows the whole wave in flight,
    // rather than the rows lighting up one at a time as Node happens
    // to schedule each branch's first `await`.
    for (const { lesson } of ready) {
      todo = patchTodoStep(todo, {
        id: lesson.id,
        status: "writing",
        attempts: 1,
      });
      manifest = patchManifestItem(manifest, {
        id: lesson.id,
        status: "writing",
      });
    }
    await dispatch();

    const draftCacheIds: Record<string, string> = {};
    const newlyCommitted: string[] = [];

    await Promise.all(
      ready.map(async ({ ch, lesson, li }) => {
        const prereqContext = await this.buildPrereqContext(plan, lesson);

        const onCycle = async (patch: {
          status: "writing" | "critiquing";
          attempts: number;
        }) => {
          todo = patchTodoStep(todo, { id: lesson.id, ...patch });
          await dispatch();
        };

        const { markdown, attempts, accepted } = await this.generate(
          state,
          plan,
          ch.title,
          lesson,
          prereqContext,
          onCycle,
        );
        const cacheKey = `draft:${state.thread_id}:${lesson.id}`;
        await this.cache.set(cacheKey, markdown, 60 * 30);
        draftCacheIds[lesson.id] = cacheKey;

        // Zero-trace persist: regardless of whether the critic passed
        // the first draft or the writer revised once against blocking
        // findings, the lesson commits as accepted with empty
        // review/block/critic fields. The FE renders these committed
        // rows as ordinary accepted lessons — no "review me" badge,
        // no critic-notes panel, no "forced" status — so a teacher
        // never has to dismiss a flag they didn't ask for. The
        // writer's revision pass still happened upstream; we just
        // don't surface the receipts.
        try {
          const { error } = await this.supa.client.from("lessons").upsert(
            {
              id: lesson.id,
              chapter_id: ch.id,
              title: lesson.title,
              content: markdown,
              order_index: li,
              // Pedagogical contract columns. Left null/empty for v1
              // plans (where the supervisor didn't populate them) —
              // the FE Viewer suppresses the corresponding chips when
              // arrays are empty.
              learning_objectives: lesson.learning_objectives ?? [],
              prerequisites: lesson.prerequisites ?? [],
              key_terms: lesson.key_terms ?? [],
              worked_example_seed: lesson.worked_example_seed || null,
              assessment_idea: lesson.assessment_idea || null,
              duration_min: lesson.duration_min || null,
              review_required: false,
              block_issues: [],
              critic_issues: [],
              depends_on: lesson.depends_on ?? [],
            },
            { onConflict: "id" },
          );
          if (error) throw error;
          todo = patchTodoStep(todo, {
            id: lesson.id,
            status: "accepted",
            attempts,
          });
          manifest = patchManifestItem(manifest, {
            id: lesson.id,
            status: "done",
            db_id: lesson.id,
            review_required: false,
            block_issues: [],
            critic_issues: [],
            depends_on: lesson.depends_on ?? [],
          });
          newlyCommitted.push(lesson.id);
          const revised = !accepted;
          this.logger.log(
            `committed lesson ${lesson.title}${revised ? " (writer revised once before commit; findings dropped)" : ""}`,
          );
        } catch (err) {
          this.logger.error(
            `commit lesson failed: ${(err as Error).message}`,
          );
          todo = patchTodoStep(todo, {
            id: lesson.id,
            status: "failed",
            attempts,
          });
          manifest = patchManifestItem(manifest, {
            id: lesson.id,
            status: "failed",
          });
        }
        await dispatch();
      }),
    );

    return {
      todo_plan: todo,
      manifest,
      draft_cache_ids: draftCacheIds,
      committed_lesson_ids: newlyCommitted,
    };
  }

  /**
   * Flip the phase back to `chatting` once every lesson has been
   * written and signal the supervisor to produce a wrap-up reply.
   * Kept as its own node (rather than rolled into the last write_one)
   * so the FE sees an explicit chatting transition emitted as its
   * own `on_chain_end`, which is also what the controller uses to
   * know the writing phase is complete.
   *
   * `command_just_finalized: true` is the trigger the supervisor
   * reads on its next entry — it bypasses the Decision LLM and goes
   * straight to a closing message. The supervisor clears the flag on
   * the way out.
   */
  async finalize(
    _state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    return { phase: "chatting", command_just_finalized: true };
  }

  /**
   * Look up each `depends_on` lesson's committed body from Supabase
   * and format the result as a `PRIOR LESSONS YOU DEPEND ON` block
   * suitable for splicing into the writer and critic prompts.
   *
   * Each excerpt is truncated to PREREQ_EXCERPT_WORDS so a deep
   * dependency chain (lesson 5 → 4 → 3 → …) doesn't blow the writer
   * tier's context window. Order matches `lesson.depends_on` so the
   * supervisor's intended priority survives into the prompt.
   *
   * Returns the empty string when the lesson has no deps OR when all
   * looked-up rows were missing/empty — callers compose against a
   * plain string in either case.
   */
  private async buildPrereqContext(
    plan: SyllabusPlan,
    lesson: PlannedLesson,
  ): Promise<string> {
    const depIds = (lesson.depends_on ?? []).filter(
      (id) => typeof id === "string" && id.length > 0,
    );
    if (depIds.length === 0) return "";

    // Walk the plan once to capture the (chapter, lesson) labels for
    // the dep ids — cheaper than another DB round-trip and keeps the
    // labels matching what the supervisor produced.
    const planLessonById = new Map<
      string,
      { title: string; chapterTitle: string }
    >();
    for (const ch of plan.chapters) {
      for (const l of ch.lessons) {
        planLessonById.set(l.id, {
          title: l.title,
          chapterTitle: ch.title,
        });
      }
    }

    const { data, error } = await this.supa.client
      .from("lessons")
      .select("id,title,content")
      .in("id", depIds);
    if (error) {
      this.logger.warn(
        `prereq lookup failed for ${lesson.title}: ${error.message}`,
      );
      return "";
    }
    const rowsById = new Map<
      string,
      { title: string; content: string }
    >();
    for (const row of data ?? []) {
      rowsById.set(row.id as string, {
        title: (row.title as string) ?? "",
        content: (row.content as string) ?? "",
      });
    }

    const sections: string[] = [];
    for (const id of depIds) {
      const planMeta = planLessonById.get(id);
      const dbRow = rowsById.get(id);
      const title = dbRow?.title || planMeta?.title || "(unknown lesson)";
      const chapter = planMeta?.chapterTitle || "(unknown chapter)";
      const body = (dbRow?.content || "").trim();
      if (!body) {
        this.logger.warn(
          `prereq lesson ${id} (${title}) has empty body — skipping`,
        );
        continue;
      }
      const excerpt = takeWords(body, PREREQ_EXCERPT_WORDS);
      sections.push(
        `--- PRIOR LESSON: "${title}" (chapter "${chapter}")\n${excerpt}`,
      );
    }
    if (sections.length === 0) return "";

    return (
      `PRIOR LESSONS YOU DEPEND ON — the supervisor flagged these as` +
      ` dependencies of the current lesson. The current lesson must` +
      ` reference (not redefine) the terms, examples, and notation` +
      ` introduced below. Cite by lesson title when you mention them.\n` +
      sections.join("\n\n") +
      `\n--- END PRIOR LESSONS\n`
    );
  }

  private async generate(
    state: GraphStateType,
    plan: SyllabusPlan,
    chapterTitle: string,
    lesson: PlannedLesson,
    prereqContext: string,
    onCycle?: (patch: {
      status: "writing" | "critiquing";
      attempts: number;
    }) => Promise<void>,
  ): Promise<{
    markdown: string;
    attempts: number;
    accepted: boolean;
    blockIssues: string[];
    /**
     * Full structured critic output from the final cycle. Every severity
     * (`block` / `warn` / `nit`), every category. Empty when the critic
     * passed the draft cleanly with no observations. Audit §2.7 — the
     * lesson row + manifest both store this so the FE banner can render
     * severity-coloured chips.
     */
    criticIssues: CriticIssueT[];
  }> {
    const writer = this.llm.get("writer", { temperature: 0.4 });
    const writerModel = this.llm.rawConfig("writer").model;
    // Critic runs on its own dedicated tier (audit §6.1). Pedagogical
    // evaluation against a 14-point JSON checklist is structurally a
    // classification task: the supervisor tier is overkill (per-revision
    // cost was 3–5× higher than necessary), but the utility tier is too
    // cheap when the critic has to reason about LO coverage and language
    // consistency on long drafts. The `critic` tier defaults to the
    // utility provider (§2.4 fallback) and ops can point CRITIC_LLM_*
    // at a medium model without affecting the picker / language detector.
    const critic = this.llm.get("critic", { temperature: 0 });
    const criticModel = this.llm.rawConfig("critic").model;
    const research = (state.search_summary ?? "").slice(0, 6000);

    // Pull pedagogical contract values, falling back gracefully when the
    // supervisor v1 prompt produced a plan without them.
    const audience = plan.audience;
    const pedagogy = plan.pedagogy;
    const language = audience?.language ?? "English";
    const audienceLevel = audience?.level ?? "undergrad";
    const wordTarget = wordTargetForAudience(audienceLevel);
    const los = lesson.learning_objectives ?? [];
    const prereqs = lesson.prerequisites ?? [];
    const keyTerms = lesson.key_terms ?? [];
    const seed = lesson.worked_example_seed ?? "";
    const assessment = lesson.assessment_idea ?? "";
    const durationMin = lesson.duration_min ?? 0;
    const hasContract = los.length > 0; // v2 plan vs. v1 fallback

    // ── Writer prompt v2 ────────────────────────────────────────────────────
    //
    // The MVP writer treated every lesson as "H1 + 2-4 sections + 1 worked
    // example + closing", capped at 1000 words. That's an explainer, not a
    // lesson — there's no place for prerequisites, no formative checks, no
    // graded practice, no callout for common pitfalls. The v2 writer is
    // contract-driven (uses the LOs, prereqs, key terms, worked-example
    // seed, and assessment idea the supervisor allocated) and produces a
    // full lesson template that maps onto how lessons are actually taught.
    const sysWriter = new SystemMessage(
      `You write ONE complete, teacher-usable lesson in Markdown for the syllabus "${plan.title}", chapter "${chapterTitle}". ` +
        `Your lesson must be deliverable to a real classroom of ${audienceLevel} learners as-is, not a summary or a primer.\n\n` +
        // ── language ─────────────────────────────────────────────────────
        `LANGUAGE: write the entire lesson in ${language}. ALL section headings (e.g. "Learning objectives", "Prerequisites", "Key terms", "Worked example", "Check for understanding", "Practice", "Summary", "Going further"), labels, captions, and prose must be translated into ${language} (preserve the same semantic meaning). ` +
        `If the research summary is in another language, translate the facts you use; do NOT leak English fragments unless they are proper nouns / code identifiers / standardized terms. The critic fails the draft on language inconsistency.\n\n` +
        // ── structure ────────────────────────────────────────────────────
        `Output ONLY the lesson Markdown. Use this structure, in this order:\n\n` +
        `# ${lesson.title}\n` +
        `_(1–2 sentence opening framing — why this lesson matters in the chapter, ${audience ? `for ${audienceLevel} learners` : "for the target audience"}.)_\n\n` +
        `## Learning objectives\n` +
        (hasContract
          ? `- Render each of these objectives VERBATIM as a bullet (translate to ${language} where needed, but keep the action verb and Bloom level intent intact). DO NOT invent new objectives or drop any:\n${los.map((o) => `  - "${o.text}" [${o.bloom_level}]`).join("\n")}\n`
          : `- Write 2–4 measurable objectives starting with "By the end of this lesson, you will be able to <action verb> …". Avoid vague verbs (understand / know / be familiar with).\n`) +
        `\n## Prerequisites\n` +
        (prereqs.length
          ? `- Render each prerequisite as a short bullet:\n${prereqs.map((p) => `  - ${p}`).join("\n")}\n`
          : `- Bullet 1–3 things the learner must already know to engage with this lesson. If the lesson is the first in the syllabus, link to general background instead.\n`) +
        `\n## Key terms\n` +
        (keyTerms.length
          ? `- Define each of these terms in 1 sentence, in the order given:\n${keyTerms.map((t) => `  - ${t}`).join("\n")}\n`
          : `- Define 3–6 key terms the lesson uses, in 1 sentence each.\n`) +
        `\n## Concept walkthrough\n` +
        `- 2–4 sub-sections (use ### subheadings) building the concept up. ` +
        `Each sub-section MUST end with a "**Common pitfall:** …" callout (one sentence) drawn from the "Common misconceptions" section of the research summary, when present.\n` +
        `- Use code blocks for any code, commands, config. Use numbered lists for procedures and bulleted lists for comparisons.\n` +
        `\n## Worked example\n` +
        (seed
          ? `- Develop the following worked-example seed step by step, narrating the reasoning ("Step 1: …", "Step 2: …", culminating in the answer): "${seed}". ` +
            `Show your thinking aloud — the goal is for a learner to learn the *process*, not just see the answer. Use code blocks for any code.\n`
          : `- Pick ONE concrete scenario from the research summary's "Worked example seeds" section and develop it step by step, narrating the reasoning. Show your thinking aloud.\n`) +
        `\n## Check for understanding\n` +
        `- 3 short questions a teacher can ask in class to verify the lesson landed. Each question MUST exercise at least one of the lesson's learning objectives. ` +
        `Provide answers under a Markdown details/summary block so they're collapsed by default. Use this exact pattern (translate the summary text to ${language} but keep the HTML tags intact):\n` +
        `  Q1. <question>\n` +
        `  <details><summary>Answer</summary>\n  <answer>\n  </details>\n` +
        `\n## Practice\n` +
        `- 3 practice problems graded by Bloom level: 1 at "remember/understand" (e.g. recall, classify), 1 at "apply" (e.g. carry out a procedure on a new input), 1 at "analyze/evaluate/create" (e.g. compare approaches, design a small artifact, debug a flawed example). ` +
        `Label each problem with its Bloom level in brackets, e.g. "[apply]". Do NOT include solutions for these — these are for the learner to attempt.\n` +
        `\n## Summary\n` +
        `- Recap in 2–4 bullets, EACH bullet mapping back to one of the learning objectives by paraphrase (do NOT just restate the title). Do NOT introduce new content here.\n` +
        `\n## Going further\n` +
        `- 1–3 suggestions for the curious learner: a follow-up topic, a hands-on extension, or a real-world application. Plain prose, not URLs.\n\n` +
        // ── pedagogy nudges ──────────────────────────────────────────────
        (pedagogy
          ? `Pedagogy style is "${pedagogy.style}", assessment is "${pedagogy.assessment}". For "lab" style, weight examples toward code-along; for "lecture", weight toward narrative explanation; for "flipped", front-load definitions and reserve examples for in-class; for "self_study", make Check for Understanding more substantial. For "summative" assessment, make at least one Practice item resemble an exam item.\n\n`
          : "") +
        // ── prior lessons (depends_on) ──────────────────────────────────
        (prereqContext
          ? `DEPENDENCIES: this lesson explicitly builds on one or more earlier lessons. Their committed bodies are appended to the user message under "PRIOR LESSONS YOU DEPEND ON". When you mention a term, example, notation, or result that was established in one of those lessons, REFERENCE it by lesson title ("as introduced in '<title>'…") instead of redefining it. Do not contradict definitions or notation set there. The critic compares your draft against those bodies and fails the lesson on incoherent or duplicate definitions.\n\n`
          : "") +
        // ── grounding ────────────────────────────────────────────────────
        `GROUNDING: every factual claim, statistic, mechanism, or definition MUST be supported by the background research summary below. ` +
        `If the research is silent on a fact you'd like to include, OMIT it rather than inventing one. The critic compares the draft against the research summary and fails the lesson on hallucinations.\n\n` +
        // ── length ───────────────────────────────────────────────────────
        `LENGTH: target ${wordTarget.lo}–${wordTarget.hi} words total (${audienceLevel}). ` +
        (durationMin > 0
          ? `Allocated lesson time is ${durationMin} min, so scale density to fit. `
          : "") +
        `Quality > word count — don't pad.\n\n` +
        // ── housekeeping ─────────────────────────────────────────────────
        `Do NOT include frontmatter, commentary, JSON, tool-call traces, or "I will now …" preambles. Do NOT cite URLs. Do NOT repeat the lesson title in the closing.`,
    );

    // ── Critic prompt v2 ────────────────────────────────────────────────────
    //
    // The MVP critic checked surface mechanics only (word count, H1, JSON
    // leakage). It never saw the LOs and never saw the research summary,
    // so it couldn't catch hallucinations or off-objective drift — which
    // are the two failure modes that make a lesson unteachable. The v2
    // critic is given (a) the contract for THIS lesson, (b) the research
    // summary, and (c) the draft, and returns severity-tagged issues so
    // the orchestrator can force-pass on warn/nit but never on block.
    const losBullet = los.length
      ? los.map((o) => `  - ${o.text} [${o.bloom_level}]`).join("\n")
      : "  - (none provided — fall back to mechanical checks only for LO alignment)";
    const sysCritic = new SystemMessage(
      `You are a strict pedagogical reviewer. You evaluate ONE drafted lesson against (1) the lesson contract, (2) the background research, and (3) hard structural rules. ` +
        `You return STRICT JSON ONLY with this schema:\n` +
        `{"pass": <boolean>, "issues": [{"severity":"block"|"warn"|"nit","category":"<one of: lo_alignment, grounding, language, pedagogy, structure, duplication, wording, leakage, other>","detail":"<≤200 chars; quote the offending phrase or location>"}, ...]}\n\n` +
        `Severity rules — these are mandatory:\n` +
        `- "block" : the lesson is NOT teachable as-is. Examples: a learning objective is missing or contradicted; a factual claim is unsupported by the research; the lesson is in the wrong language; a section header is missing; the worked example does not exercise any LO; vague action verbs (understand / know / be familiar with) appear in objectives; the practice has no item at "apply" or higher; check-for-understanding answers are missing; the H1 is wrong or missing.\n` +
        `- "warn"  : the lesson is teachable but has a meaningful pedagogical defect. Examples: a "common pitfall" callout is missing in a sub-section; key terms are not defined; the worked example seed isn't fully developed; one LO is barely covered.\n` +
        `- "nit"   : surface polish. Examples: awkward phrasing, near-duplicate paragraphs, minor structural inconsistency.\n` +
        `Set "pass": true if and only if there are NO "block" issues. warn- and nit-severity findings are ALWAYS tolerated for "pass": true — surface them in the issues array so the writer can address them on the next pass if budget remains, but do NOT set pass:false purely because of them. The revision loop has a hard cap, and force-failing on cosmetic / non-blocking findings burns it without improving teachability. Reserve pass:false strictly for block-severity defects.\n\n` +
        // ── checks ──────────────────────────────────────────────────────
        `Run these checks, in order, and emit issues for each one that triggers:\n` +
        `1. STRUCTURE: lesson MUST contain H1 matching "${lesson.title}" and section headers (in any language) for: Learning objectives, Prerequisites, Key terms, Concept walkthrough, Worked example, Check for understanding, Practice, Summary, Going further. Missing section header → block (category=structure).\n` +
        `2. LO ALIGNMENT: every learning objective in the contract MUST appear (verbatim or close paraphrase) under "Learning objectives" AND be exercised by either the Worked example or at least one Practice item. ` +
        `If even one LO is missing or unexercised → block (category=lo_alignment, detail names the missing LO).\n` +
        `3. NO VAGUE VERBS: objectives that contain "understand", "know", "be familiar with", "appreciate", "be aware of" → block (category=lo_alignment, detail quotes the verb).\n` +
        `4. BLOOM CEILING: at least ONE Practice item must be labelled [apply], [analyze], [evaluate], or [create]. If all three are at remember/understand → block (category=pedagogy).\n` +
        `5. GROUNDING: every factual claim in the draft prose, sub-sections, worked-example narration, and check-for-understanding answers MUST be supportable by the research summary. ` +
        `Quote up to 2 unsupported claims as block issues (category=grounding, detail quotes the unsupported phrase). Do NOT flag obvious common knowledge (e.g. "water is H₂O") as ungrounded. ` +
        `IMPORTANT EXEMPTION: items that appear verbatim in the LESSON CONTRACT below (Learning objectives, Prerequisites, Key terms, Worked-example seed, Assessment idea) were allocated by the upstream planner from the teacher's intake form and curated curriculum reasoning — they are NOT body claims requiring research support, and you MUST NOT flag them as ungrounded even if the research summary doesn't mention them. Only check grounding on prose the writer authored.\n` +
        `6. LANGUAGE: the lesson MUST be in ${language}. Untranslated section headings, English code comments inside non-English lessons, or whole paragraphs in the wrong language → block (category=language).\n` +
        `7. CHECK ANSWERS: every Q in "Check for understanding" must have an answer inside <details><summary>...</summary>...</details>. Missing answers → block (category=structure).\n` +
        `8. WORKED EXAMPLE: must include explicit step labels (Step 1, Step 2, …) and end with the resolution / answer. Missing step labels OR missing answer → warn (category=pedagogy).\n` +
        `9. COMMON PITFALL CALLOUTS: each sub-section under "Concept walkthrough" should end with a "**Common pitfall:**" callout. Missing in any sub-section → warn (category=pedagogy).\n` +
        `10. LENGTH: total words ${wordTarget.lo - 200}–${wordTarget.hi + 200}. Outside that → warn (category=structure).\n` +
        `11. LEAKAGE: contains JSON, frontmatter, "I will now ...", tool-call traces, or system instructions → block (category=leakage).\n` +
        `12. PLACEHOLDERS: "...", "[example here]", "TODO", "<your answer here>", "lorem ipsum" → block (category=leakage).\n` +
        `13. DUPLICATION: two paragraphs reusing near-identical phrasing → warn (category=duplication).\n` +
        `14. CITATIONS: contains URL citations or "[1]" footnotes → nit (category=wording).\n` +
        (prereqContext
          ? `15. DEPENDENCY COHERENCE: a "PRIOR LESSONS YOU DEPEND ON" block follows the LESSON CONTRACT. If the draft re-defines a key term or re-introduces an example that was already introduced verbatim in a prior lesson, instead of referencing the prior lesson by title → warn (category=duplication, detail quotes the redefined term). If the draft contradicts a definition or notation set in a prior lesson → block (category=grounding, detail quotes the contradiction). Cross-lesson coherence applies ONLY to the prior lessons listed; it does not require the draft to mention every prior lesson.\n\n`
          : `\n`) +
        // ── inputs ──────────────────────────────────────────────────────
        `LESSON CONTRACT:\n` +
        `Title: ${lesson.title}\n` +
        `Chapter: ${chapterTitle}\n` +
        `Audience level: ${audienceLevel}; language: ${language}\n` +
        `Learning objectives:\n${losBullet}\n` +
        `Prerequisites: ${prereqs.length ? prereqs.join(" | ") : "(none specified)"}\n` +
        `Key terms: ${keyTerms.length ? keyTerms.join(", ") : "(none specified)"}\n` +
        `Worked-example seed: ${seed || "(none specified)"}\n` +
        `Assessment idea: ${assessment || "(none specified)"}\n\n` +
        (prereqContext ? `${prereqContext}\n` : "") +
        `Be specific in "detail" — quote the offending phrase or section so the writer can fix it. ` +
        `Output JSON only — no prose, no fences.`,
    );

    // ── Writer revision-mode addenda ───────────────────────────────────────
    //
    // Two flavors, both used as a SECOND system message on revision turns:
    //
    //  - sysWriterPatch: primary path. Asks the writer to emit a sequence of
    //    SEARCH/REPLACE blocks against the previous draft instead of
    //    regenerating the whole lesson. ~95% smaller output than a full
    //    rewrite, much less drift, and the applier (parseSearchReplaceBlocks
    //    + applySearchReplaceBlocks) refuses to apply ambiguous matches so
    //    a malformed block fails loudly instead of silently corrupting the
    //    draft.
    //  - sysWriterReviseFull: fallback path. Same prompt as v1's
    //    revision-mode addendum — re-emit the entire revised lesson. Used
    //    only when the patch path produces no parseable blocks or the
    //    blocks fail to apply, so we never deliver a stale draft when the
    //    writer's diff output is malformed.
    const sysWriterPatch = new SystemMessage(
      `REVISION MODE — PATCH OUTPUT: the previous draft and a critic's issue list are appended to the user message. ` +
        `Do NOT regenerate the whole lesson. Instead, output a sequence of SEARCH/REPLACE blocks describing the surgical edits needed to fix the critic's issues, in this exact format (one block per logical edit, blocks separated by a blank line):\n\n` +
        `<<<<<<< SEARCH\n` +
        `<exact text from the previous draft to be replaced — copy it byte-for-byte, including original whitespace>\n` +
        `=======\n` +
        `<replacement text>\n` +
        `>>>>>>> REPLACE\n\n` +
        `Rules:\n` +
        `- Each SEARCH chunk must appear EXACTLY ONCE in the previous draft. If a phrase appears multiple times, include enough surrounding context lines to make the SEARCH unique.\n` +
        `- Address [block] issues first (mandatory), then [warn], then [nit]. Skip an issue rather than emit a guess that doesn't fix it.\n` +
        `- To ADD a new section at the end, emit one block with an EMPTY SEARCH and the new content as the REPLACE.\n` +
        `- Do NOT remove or rename contract-allocated items (Learning objectives bullets, Prerequisites bullets, Key terms entries) — they are mandated by the planner. Patch their wording only if a block-severity issue specifically targets them.\n` +
        `- Output ONLY the SEARCH/REPLACE blocks. No commentary, no diff fences (no \`\`\`), no "here are the changes" preamble. ` +
        `If you cannot express a fix as one or more clean SEARCH/REPLACE blocks, output the marker line "FALLBACK_FULL_REWRITE" and nothing else; the orchestrator will retry in full-rewrite mode.`,
    );
    const sysWriterReviseFull = new SystemMessage(
      `REVISION MODE — FULL REWRITE FALLBACK: the previous draft and a critic's issue list are appended to the user message. ` +
        `Your job is to PATCH the previous draft, not regenerate it from scratch. ` +
        `Preserve every section, paragraph, code block, and bullet that was NOT flagged by the critic — keep them byte-for-byte where possible. ` +
        `For each flagged issue, apply the smallest edit that resolves it: rewrite the offending phrase, replace the unsupported claim with one grounded in the research, add the missing section/answer/Bloom level, etc. ` +
        `Address [block] issues first (mandatory), then [warn], then [nit]. ` +
        `Do NOT remove or rename the contract-allocated items (Learning objectives bullets, Prerequisites bullets, Key terms entries) — they are mandated by the planner. ` +
        `Output ONLY the revised lesson Markdown — same format as the original, no commentary, no diff syntax, no "here is the revised lesson" preamble.`,
    );

    // ── Per-lesson cache continuity ───────────────────────────────────────
    //
    // Lesson UUIDs are pre-allocated by the supervisor before writing
    // starts, so the same UUID identifies the same lesson across graph
    // re-entries (e.g. user re-issues a "rewrite syllabus" command). When
    // we have a previous draft and a previous critic issue list cached,
    // seed the loop in revision mode against them instead of restarting
    // blind. This makes follow-up writer runs converge — repeated runs
    // tighten the same lesson rather than rolling new dice each time —
    // and gives the critic continuity over the lesson's history.
    //
    // 30-min TTL matches the per-lesson commit cache below; long enough
    // for any single graph run, short enough that abandoned drafts age
    // out cleanly.
    const draftKey = `draft:${state.thread_id}:${lesson.id}`;
    const issuesKey = `critic_issues:${state.thread_id}:${lesson.id}`;
    let draft = "";
    let lastIssues: CriticIssueT[] = [];
    let priorContextSeeded = false;
    try {
      const [priorDraft, priorIssuesRaw] = await Promise.all([
        this.cache.get(draftKey),
        this.cache.get(issuesKey),
      ]);
      if (priorDraft && priorDraft.trim().length > 0) {
        draft = priorDraft;
        priorContextSeeded = true;
        this.logger.log(
          `lesson "${lesson.title}" rehydrated prior draft (${priorDraft.length} chars) from cache — entering revision mode on attempt 0`,
        );
      }
      if (priorIssuesRaw) {
        try {
          const parsed = z
            .array(CriticIssue)
            .safeParse(JSON.parse(priorIssuesRaw));
          if (parsed.success) lastIssues = parsed.data;
        } catch (err) {
          this.logger.warn(
            `prior critic issues unparseable: ${(err as Error).message}`,
          );
        }
      }
    } catch (err) {
      // Cache is best-effort. A miss/error means we start fresh — the
      // writer/critic loop still works, it just doesn't carry continuity.
      this.logger.warn(
        `cache rehydrate failed for ${draftKey}: ${(err as Error).message}`,
      );
    }

    // Counts physical writer LLM invocations — incremented for every
    // model call (including the full-rewrite fallback after a failed
    // patch). Distinct from the "attempts" cycle counter, which is what
    // we surface to the FE / todo plan; one revision cycle can do two
    // physical writer calls if the patch path needed to fall back.
    let writerInvocations = 0;
    // Tracks the last completed cycle so the failure return uses a
    // consistent "attempts" semantics with the success path (number of
    // writer/critic cycles, not raw LLM call count).
    let cyclesCompleted = 0;
    let exitReason:
      | "max_revisions"
      | "critic_parse_failed" = "max_revisions";
    for (let attempt = 0; attempt <= MAX_REVISIONS; attempt++) {
      if (attempt > 0 && onCycle) {
        await onCycle({ status: "writing", attempts: attempt + 1 });
      }
      // Revision mode applies on attempt > 0 OR when seeded from cache.
      const inRevisionMode = priorContextSeeded || attempt > 0;
      const prevIssues =
        inRevisionMode && lastIssues.length
          ? // Sort issues for the writer: blocks first (must fix), warns,
            // then nits. The writer addresses them in order so block fixes
            // don't get lost in a flood of nits.
            "\n\nThe previous draft had these issues — fix them in order (blocks are mandatory):\n" +
            [...lastIssues]
              .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
              .map(
                (i) => `- [${i.severity}/${i.category}] ${i.detail}`,
              )
              .join("\n") +
            `\n\nPrevious draft:\n${draft}`
          : inRevisionMode && draft
            ? `\n\nPrevious draft (no critic issues from this graph turn — apply only the standing constraints above):\n${draft}`
            : "";
      const userMsg = new HumanMessage(
        `Lesson title: ${lesson.title}\n` +
          `Lesson brief: ${lesson.brief}\n\n` +
          (los.length
            ? `Learning objectives (render verbatim as bullets, in the lesson's language):\n${los
                .map((o) => `- ${o.text} [${o.bloom_level}]`)
                .join("\n")}\n\n`
            : "") +
          (prereqs.length ? `Prerequisites: ${prereqs.join(" | ")}\n` : "") +
          (keyTerms.length ? `Key terms: ${keyTerms.join(", ")}\n` : "") +
          (seed ? `Worked-example seed: ${seed}\n` : "") +
          (assessment ? `Assessment idea: ${assessment}\n` : "") +
          (durationMin > 0 ? `Duration: ${durationMin} min\n` : "") +
          (prereqContext ? `\n${prereqContext}` : "") +
          `\nBackground research summary (use as ground truth — do not invent facts not present here, do not cite URLs):\n${research}` +
          prevIssues,
      );

      if (!inRevisionMode) {
        // Fresh first attempt — no previous draft to patch against.
        const out = await writer.invoke([sysWriter, userMsg]);
        await dispatchLlmUsage(out, {
          node: "command:writer",
          tier: "writer",
          model: writerModel,
        });
        draft = String(out.content ?? "").trim();
        writerInvocations += 1;
      } else {
        // Revision: try the patch path first, fall back to full rewrite
        // if the writer can't or won't produce a clean diff.
        const previousDraft = draft;
        const patchOut = await writer.invoke([
          sysWriter,
          sysWriterPatch,
          userMsg,
        ]);
        await dispatchLlmUsage(patchOut, {
          node: "command:writer_patch",
          tier: "writer",
          model: writerModel,
        });
        writerInvocations += 1;
        const rawPatch = String(patchOut.content ?? "").trim();
        const explicitFallback = /^FALLBACK_FULL_REWRITE\s*$/m.test(rawPatch);
        let appliedViaPatch = false;
        if (!explicitFallback) {
          const blocks = parseSearchReplaceBlocks(rawPatch);
          const result = applySearchReplaceBlocks(previousDraft, blocks);
          if (result.ok) {
            draft = result.text.trim();
            appliedViaPatch = true;
            this.logger.log(
              `lesson "${lesson.title}" attempt ${attempt + 1}: applied ${blocks.length} patch block(s)`,
            );
          } else {
            this.logger.warn(
              `lesson "${lesson.title}" attempt ${attempt + 1}: patch apply failed (reason=${result.reason}, blocks=${blocks.length}, applied=${result.applied}) — falling back to full rewrite`,
            );
          }
        } else {
          this.logger.log(
            `lesson "${lesson.title}" attempt ${attempt + 1}: writer signaled FALLBACK_FULL_REWRITE — invoking full-rewrite path`,
          );
        }
        if (!appliedViaPatch) {
          const fullOut = await writer.invoke([
            sysWriter,
            sysWriterReviseFull,
            userMsg,
          ]);
          await dispatchLlmUsage(fullOut, {
            node: "command:writer_revise_full",
            tier: "writer",
            model: writerModel,
          });
          writerInvocations += 1;
          draft = String(fullOut.content ?? "").trim();
        }
      }

      // Persist the freshly-produced draft so a subsequent graph turn
      // (or a crash + resume) can pick up where we left off. Best-effort
      // — a write failure shouldn't kill the run.
      try {
        await this.cache.set(draftKey, draft, 60 * 30);
      } catch (err) {
        this.logger.warn(
          `cache draft persist failed: ${(err as Error).message}`,
        );
      }
      cyclesCompleted = attempt + 1;

      if (attempt === MAX_REVISIONS) break;

      if (onCycle) {
        await onCycle({ status: "critiquing", attempts: attempt + 1 });
      }
      const reviewOut = await critic.invoke([
        sysCritic,
        new HumanMessage(
          `Lesson title: ${lesson.title}\n\n` +
            `=== RESEARCH SUMMARY (for grounding check) ===\n${research}\n=== END ===\n\n` +
            `=== DRAFT (review this) ===\n${draft}\n=== END ===`,
        ),
      ]);
      await dispatchLlmUsage(reviewOut, {
        node: "command:critic",
        tier: "critic",
        model: criticModel,
      });
      const json = this.extractJson(String(reviewOut.content ?? ""));
      const parsed = CriticOutput.safeParse(json);
      if (!parsed.success) {
        exitReason = "critic_parse_failed";
        break;
      }
      lastIssues = parsed.data.issues;
      // Persist the latest issue list alongside the draft so a follow-up
      // graph turn rehydrates BOTH and the writer can target the same
      // findings instead of re-deriving them. Best-effort.
      try {
        await this.cache.set(
          issuesKey,
          JSON.stringify(lastIssues),
          60 * 30,
        );
      } catch (err) {
        this.logger.warn(
          `cache issues persist failed: ${(err as Error).message}`,
        );
      }
      const blockCount = lastIssues.filter((i) => i.severity === "block").length;
      // Treat critic-issued pass:true as authoritative ONLY when there are
      // no block-severity issues. Otherwise we ignore the pass flag and
      // force a revision — a critic that says "pass: true" with a block
      // issue is contradicting itself, and we'd rather waste a revision
      // than commit a block-level defect.
      if (parsed.data.pass && blockCount === 0) {
        this.logger.log(
          `lesson "${lesson.title}" passed critic on attempt ${attempt + 1} (${lastIssues.length} non-block issues)`,
        );
        return {
          markdown: draft,
          attempts: attempt + 1,
          accepted: true,
          blockIssues: [],
          // Surface warn/nit observations from the passing cycle too —
          // they still merit a banner ("the critic noted, while still
          // passing the lesson, that …") even when no block issue is
          // outstanding. Empty when the critic passed without comment.
          criticIssues: lastIssues,
        };
      }
      this.logger.log(
        `lesson "${lesson.title}" failed critic on attempt ${attempt + 1}: ${lastIssues
          .map((i) => `[${i.severity}] ${i.detail}`)
          .join("; ")}`,
      );
      // Single-shot critic contract: with MAX_REVISIONS = 1, the next
      // iteration will run the revision-mode writer pass and then exit
      // the loop without invoking the critic again. The fingerprint /
      // deadlock short-circuit from the multi-revision design is gone
      // because there is no "two consecutive cycles flagged the same
      // blocks" comparison left to make.
    }
    // Force-pass path. The critic flagged blocks (or returned
    // unparseable output), the revision-mode writer pass produced a
    // best-effort fix, and we deliberately do NOT re-critique — we
    // commit with `accepted: false` so the FE renders a 'review me'
    // badge listing the original critic findings for human inspection.
    // We surface block-issue details so
    // the wrap-up message and the FileTree can flag affected lessons.
    if (exitReason === "critic_parse_failed") {
      this.logger.warn(
        `lesson "${lesson.title}" critic returned unparseable output on cycle ${cyclesCompleted} (${writerInvocations} writer call(s)) — force-pass`,
      );
    } else {
      this.logger.warn(
        `lesson "${lesson.title}" critic flagged blocks; committed after one revision pass (${writerInvocations} writer call(s)) — review_required`,
      );
    }
    const blockIssues = lastIssues
      .filter((i) => i.severity === "block")
      .map((i) => `[${i.category}] ${i.detail}`);
    return {
      markdown: draft,
      attempts: cyclesCompleted || 1,
      accepted: false,
      blockIssues,
      // The full structured set so the FE can render severity-coloured
      // chips, not just the legacy block-only formatted strings.
      criticIssues: lastIssues,
    };
  }

  private extractJson(txt: string): unknown {
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

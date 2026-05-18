import {
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { DeepAgentService } from "../agents-v2/deepagent.service";
import { EntitiesService } from "./entities.service";
import {
  buildCurriculumContext,
  type GenerationTarget,
  type SyllabusOutline,
} from "./curriculum-context";

export type GenerateScope = "syllabus" | "unity" | "activity";

/**
 * Drives the "generate" half of the `name first, generate second`
 * flow. The new REST controllers (`SyllabusesController`,
 * `UnitiesController`, `ActivitiesController`) delegate here.
 *
 * Responsibilities:
 *
 *   1. Resolve the scoped entity's parent ids (syllabus_id, thread_id)
 *      so the supervisor's synthesised user message has full context.
 *   2. Build the synthesised user message that tells the supervisor
 *      "your job for this turn is to fill in <scope>" \u2014 see
 *      `buildScopedPrompt`.
 *   3. Forward to `DeepAgentService` and pipe the typed `DeepAgentChunk`
 *      stream out as bare-bones SSE on the Express response.
 *
 * Wire format (intentionally simpler than the v5 UI Message Stream
 * served by the existing `/api/chat/:threadId`):
 *
 *   data: {"type":"<chunk-type>",...}\n\n
 *   ...
 *   data: [DONE]\n\n
 *
 * Each line is one `DeepAgentChunk` JSON-encoded as-is. The richer
 * Vercel AI SDK v5 UI Message Stream remains the canonical client
 * surface for chat; these scoped /generate endpoints are a thinner
 * adapter intended for headless / scripted clients.
 */
@Injectable()
export class ScopedGenerateService {
  private readonly logger = new Logger(ScopedGenerateService.name);

  constructor(
    private readonly entities: EntitiesService,
    private readonly deepAgent: DeepAgentService,
  ) {}

  async streamScoped(opts: {
    scope: GenerateScope;
    entityId: string;
    res: Response;
  }): Promise<void> {
    const { scope, entityId, res } = opts;

    // Resolve parent ids so the supervisor knows what to fill in.
    const ctx = await this.resolveContext(scope, entityId);

    // Pre-load the curriculum outline for the syllabus so the
    // supervisor enters the pass already knowing what siblings
    // exist. Empty string when there's nothing meaningful to
    // inject (first-time generate on an empty syllabus). Best-
    // effort: a failure here MUST NOT block generation — log and
    // continue without the block.
    let curriculumContext = "";
    if (ctx.syllabusId) {
      try {
        const outline = await this.entities.getSyllabusOutline(
          ctx.syllabusId,
        );
        const target = makeTarget(scope, ctx);
        if (target) {
          curriculumContext = buildCurriculumContext(outline, target);
        }
      } catch (err) {
        this.logger.warn(
          `curriculum-context pre-load failed (syllabus_id=${ctx.syllabusId}): ${(err as Error).message}`,
        );
      }
    }

    const prompt = this.buildScopedPrompt(
      scope,
      entityId,
      ctx,
      curriculumContext,
    );

    // The deep-agent runner is keyed by thread_id for checkpointing.
    // We deliberately allocate a FRESH random thread_id for every
    // /generate call instead of reusing the syllabus's bound
    // thread_id or the entity_id itself.
    //
    // Why a fresh per-call thread (vs. ctx.threadId ?? entityId):
    //
    //   1. Cancellation cascade. The DeepAgentRunner's stream() is
    //      keyed by threadId; two concurrent calls with the same
    //      threadId would clobber each other through the
    //      LangGraph checkpointer (one wins, the other is treated
    //      as a resumed-and-cancelled run). When the user clicked
    //      "Gen" on a unity while the syllabus-scoped run was
    //      still in flight (both keyed by syllabus.thread_id under
    //      the old logic), the syllabus run aborted mid-stream and
    //      the worksheet writes that depend on its supervisor
    //      decisions never happened.
    //
    //   2. No need for cross-call memory. The Partie A curriculum-
    //      context block is re-injected on every /generate call
    //      (see `buildCurriculumContext` above), so the supervisor
    //      always re-enters with full knowledge of what already
    //      exists in the syllabus tree. We don't need the thread's
    //      message history to carry over from the previous Gen
    //      click. Each /generate is a self-contained "fill in this
    //      one scope" task.
    //
    //   3. Legacy chat threads. `ctx.threadId` is bound to the
    //      legacy `/api/chat/:threadId` flow and may already have
    //      a user turn at its tail; appending a synthesised
    //      supervisor prompt into that thread would interleave
    //      with the user's real chat history.
    //
    // The trade-off is that the deep-agent checkpointer accumulates
    // one row per /generate call instead of reusing rows per
    // entity. That's acceptable — the checkpoint tables in the
    // `deep_agent` schema are small (a few KB per run) and the
    // user benefits from being able to "see what happened" on the
    // specific run that just finished without it being clobbered
    // by the next click.
    const threadId = randomUUID();
    this.logger.log(
      `scoped generate starting ` +
        `scope=${scope} ` +
        `entityId=${entityId} ` +
        `threadId=${threadId} ` +
        `syllabusId=${ctx.syllabusId ?? "null"}`,
    );

    // Set SSE headers + flush before the runner starts streaming.
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    // AbortSignal so the runner stops if the client disconnects.
    const ac = new AbortController();
    res.on("close", () => ac.abort());

    try {
      for await (const chunk of this.deepAgent.stream(threadId, prompt, {
        signal: ac.signal,
      })) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        if (chunk.type === "done") break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `scoped generate failed (scope=${scope} entityId=${entityId}): ${message}`,
      );
      res.write(
        `data: ${JSON.stringify({ type: "error", message })}\n\n`,
      );
    } finally {
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }

  private async resolveContext(
    scope: GenerateScope,
    entityId: string,
  ): Promise<{
    syllabusId: string | null;
    unityId: string | null;
    activityId: string | null;
    threadId: string | null;
    syllabusTitle: string | null;
    unityTitle: string | null;
    activityTitle: string | null;
  }> {
    let syllabusId: string | null = null;
    let unityId: string | null = null;
    let activityId: string | null = null;
    let threadId: string | null = null;
    let syllabusTitle: string | null = null;
    let unityTitle: string | null = null;
    let activityTitle: string | null = null;

    if (scope === "syllabus") {
      const s = await this.entities.getSyllabus(entityId);
      syllabusId = s.id;
      syllabusTitle = s.title;
      threadId = s.thread_id;
    } else if (scope === "unity") {
      const u = await this.entities.getUnity(entityId);
      unityId = u.id;
      unityTitle = u.title;
      syllabusId = u.syllabus_id;
      const s = await this.entities.getSyllabus(u.syllabus_id);
      syllabusTitle = s.title;
      threadId = s.thread_id;
    } else if (scope === "activity") {
      // For activities we need to climb back to syllabus via unity.
      syllabusId = await this.entities.syllabusIdForActivity(entityId);
      if (!syllabusId) {
        throw new NotFoundException(
          `Activity ${entityId} not found or missing unity_id`,
        );
      }
      activityId = entityId;
      const s = await this.entities.getSyllabus(syllabusId);
      syllabusTitle = s.title;
      threadId = s.thread_id;
    }

    return {
      syllabusId,
      unityId,
      activityId,
      threadId,
      syllabusTitle,
      unityTitle,
      activityTitle,
    };
  }

  private buildScopedPrompt(
    scope: GenerateScope,
    entityId: string,
    ctx: {
      syllabusId: string | null;
      unityId: string | null;
      activityId: string | null;
      syllabusTitle: string | null;
      unityTitle: string | null;
      activityTitle: string | null;
    },
    curriculumContext: string = "",
  ): string {
    const lines: string[] = [];
    lines.push(
      `[scoped-generate] scope=${scope} entity_id=${entityId}`,
    );
    if (ctx.syllabusId) {
      lines.push(
        `syllabus_id=${ctx.syllabusId}` +
          (ctx.syllabusTitle ? ` title=\"${ctx.syllabusTitle}\"` : ""),
      );
    }
    if (ctx.unityId) {
      lines.push(
        `unity_id=${ctx.unityId}` +
          (ctx.unityTitle ? ` title=\"${ctx.unityTitle}\"` : ""),
      );
    }
    if (ctx.activityId) {
      lines.push(
        `activity_id=${ctx.activityId}` +
          (ctx.activityTitle ? ` title=\"${ctx.activityTitle}\"` : ""),
      );
    }
    lines.push("");

    // Inject the curriculum-context block (when non-empty) BEFORE
    // the scope-specific instructions so the agent reads "what
    // already exists" before "what to do". The formatter returns
    // empty when there's nothing meaningful to inject.
    if (curriculumContext) {
      lines.push(curriculumContext);
      lines.push("");
    }

    if (scope === "syllabus") {
      lines.push(
        `An empty syllabus row was created via POST /api/syllabuses with the title above. Please run the standard \"build a syllabus\" recipe for this syllabus: first call update_syllabus(syllabus_id=${ctx.syllabusId}, audience=..., scope=..., pedagogy=...) to fill in the top-level metadata on the existing row (do NOT call create_syllabus), then dispatch the pedagogy_planner to produce /pedagogy_plan.md, then the writer to create the unities + activities (calling find_related_activities before each create to avoid duplicating existing content under syllabus_id=${ctx.syllabusId}). Use create_unity / create_activity with the existing syllabus_id=${ctx.syllabusId}.`,
      );
    } else if (scope === "unity") {
      lines.push(
        `An empty unity row (unity_id=${ctx.unityId}) exists under syllabus_id=${ctx.syllabusId} with the title above. Please run the writer subagent scoped to *this unity only*. First, the writer should call update_unity(unity_id=${ctx.unityId}, outcomes=[...], prerequisites=[...]) to fill in the unity's metadata on the existing row (do NOT call create_unity \u2014 the row is already there). Then produce 2-4 activities under unity_id=${ctx.unityId} with cours bodies (use create_activity with the existing unity_id). The writer MUST call find_related_activities(syllabus_id=${ctx.syllabusId}, query_text=<title + objectives>) before each create. Do NOT touch other unities.`,
      );
    } else if (scope === "activity") {
      lines.push(
        `An empty activity row (activity_id=${ctx.activityId}) exists with the title above. Please populate its cours body + worksheet on the EXISTING row \u2014 do NOT create a duplicate. Dispatch the writer subagent to fill in the markdown cours via update_activity(activity_id=${ctx.activityId}, content=\"...\", learning_objectives=[...], key_terms=[...], ...); then dispatch the activity_maker subagent to attach the worksheet jsonb via update_activity_worksheet(activity_id=${ctx.activityId}, worksheet={...}). The writer MUST call find_related_activities(syllabus_id=${ctx.syllabusId}, query_text=<title + objectives>) before composing the cours.`,
      );
    }

    return lines.join("\n");
  }
}

/**
 * Build the `GenerationTarget` discriminated union expected by
 * `buildCurriculumContext` from the resolved scope + context.
 * Returns `null` when ids are missing (treat as "skip the block").
 */
function makeTarget(
  scope: GenerateScope,
  ctx: {
    syllabusId: string | null;
    unityId: string | null;
    activityId: string | null;
  },
): GenerationTarget | null {
  if (scope === "syllabus" && ctx.syllabusId) {
    return { kind: "syllabus", syllabus_id: ctx.syllabusId };
  }
  if (scope === "unity" && ctx.unityId) {
    return { kind: "unity", unity_id: ctx.unityId };
  }
  if (scope === "activity" && ctx.activityId) {
    return { kind: "activity", activity_id: ctx.activityId };
  }
  return null;
}

// Re-export types so tests / callers can build mocks without
// depending on the internal curriculum-context module path.
export type { GenerationTarget, SyllabusOutline };

import {
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { Response } from "express";
import { DeepAgentService } from "../agents-v2/deepagent.service";
import { EntitiesService } from "./entities.service";

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

    const prompt = this.buildScopedPrompt(scope, entityId, ctx);

    // The deep-agent runner is keyed by thread_id for checkpointing.
    // We use the entity_id itself as the synthetic thread_id when no
    // real thread is bound; this gives every entity a stable thread
    // for the runner's checkpoint cache without colliding with
    // legacy chat threads.
    const threadId = ctx.threadId ?? entityId;

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

    if (scope === "syllabus") {
      lines.push(
        `An empty syllabus row was created via POST /api/syllabuses with the title above. Please run the standard \"build a syllabus\" recipe for this syllabus: dispatch the pedagogy_planner to produce /pedagogy_plan.md, then the writer to create the unities + activities (calling find_related_activities before each create to avoid duplicating existing content under syllabus_id=${ctx.syllabusId}). Use create_unity / create_activity with the existing syllabus_id=${ctx.syllabusId}; do NOT call create_syllabus.`,
      );
    } else if (scope === "unity") {
      lines.push(
        `An empty unity row exists under syllabus_id=${ctx.syllabusId} with the title above. Please run the writer subagent scoped to *this unity only*: produce 2-4 activities under unity_id=${ctx.unityId} with cours bodies (use create_activity with the existing unity_id). The writer MUST call find_related_activities(syllabus_id=${ctx.syllabusId}, query_text=<title + objectives>) before each create. Do NOT touch other unities.`,
      );
    } else if (scope === "activity") {
      lines.push(
        `An empty activity row exists with the title above. Please populate its cours body + worksheet: dispatch the writer subagent to fill in the markdown cours via update_activity (or, if the row's body is empty, by writing to the existing row \u2014 do NOT create a duplicate row), then dispatch the activity_maker subagent to attach the worksheet jsonb via update_activity_worksheet(activity_id=${ctx.activityId}, worksheet={...}). The writer MUST call find_related_activities(syllabus_id=${ctx.syllabusId}, query_text=<title + objectives>) before composing the cours.`,
      );
    }

    return lines.join("\n");
  }
}

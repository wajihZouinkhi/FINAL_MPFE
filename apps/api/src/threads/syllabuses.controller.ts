import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { ThreadsService } from "./threads.service";
import { EntitiesService } from "./entities.service";
import { ScopedGenerateService } from "./scoped-generate.service";

/**
 * Read-only by-id surface for syllabuses.
 *
 * The deep-agent supervisor embeds inline `<artifact kind="syllabus"
 * id="<syllabus_id>" />` chips in chat. Clicking the chip opens
 * `/syllabuses/<id>` on the FE, which calls this endpoint to render
 * the chapter / lesson tree without needing the originating thread's
 * chat state.
 *
 * The existing `GET /api/threads/:id/snapshot` is keyed on
 * `thread_id` and returns the *most recent* syllabus for that
 * thread. That's the right shape for thread-bound viewers (the
 * syllabus thread page) but not for the deep-agent click-through,
 * because:
 *
 *   1. A deep-agent thread can produce multiple syllabuses across
 *      its lifetime (the supervisor is a generalist), so the
 *      "latest by created_at" disambiguation isn't safe.
 *   2. The FE link only carries the syllabus id, not the thread.
 *
 * Hence: `/api/syllabuses/:id/snapshot` keyed directly on the
 * syllabus row's primary key.
 */
@Controller("api/syllabuses")
export class SyllabusesController {
  constructor(
    private readonly threads: ThreadsService,
    private readonly entities: EntitiesService,
    private readonly scoped: ScopedGenerateService,
  ) {}

  @Get(":id/snapshot")
  snapshot(@Param("id") id: string) {
    return this.threads.snapshotBySyllabusId(id);
  }

  /**
   * Name-first create: inserts an empty syllabus row carrying just
   * the title (+ optional description). The supervisor + writer
   * subagent later populate the rest via `POST /api/syllabuses/:id/generate`.
   *
   * Body: `{ title: string, description?: string, thread_id?: string }`.
   * `thread_id` is optional — if absent, a synthetic deep-agent thread
   * is allocated so the generate step has somewhere to checkpoint.
   */
  @Post()
  create(
    @Body()
    body: { title?: string; description?: string; thread_id?: string },
  ) {
    return this.entities.createSyllabus({
      title: body?.title ?? "Untitled syllabus",
      description: body?.description ?? "",
      thread_id: body?.thread_id ?? null,
    });
  }

  /**
   * Generate: streams the deep-agent's pass scoped to *this syllabus*.
   * The supervisor receives a synthesised user message reminding it of
   * the syllabus title + description and asking it to flesh out the
   * unities + activities for this syllabus.
   *
   * Wire: bare-bones SSE — one `data: <chunk-json>\n\n` line per
   * `DeepAgentChunk` from the runner. The richer Vercel AI SDK v5 UI
   * Message Stream remains on `POST /api/chat/:threadId`.
   */
  @Post(":id/generate")
  async generate(@Param("id") id: string, @Res() res: Response) {
    await this.scoped.streamScoped({
      scope: "syllabus",
      entityId: id,
      res,
    });
  }
}

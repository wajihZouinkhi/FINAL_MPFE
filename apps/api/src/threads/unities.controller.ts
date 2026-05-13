import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { EntitiesService } from "./entities.service";
import { ScopedGenerateService } from "./scoped-generate.service";

/**
 * REST surface for unities (the post-rename `chapters`).
 *
 * Read: `GET /api/unities/:id` returns the unity row + its activities.
 * Write: `POST /api/unities` inserts an empty named unity for the
 *        `name first, generate second` flow.
 * Generate: `POST /api/unities/:id/generate` streams the deep-agent's
 *           pass scoped to this unity (populates its activities).
 */
@Controller("api/unities")
export class UnitiesController {
  constructor(
    private readonly entities: EntitiesService,
    private readonly scoped: ScopedGenerateService,
  ) {}

  @Get(":id")
  get(@Param("id") id: string) {
    return this.entities.getUnity(id);
  }

  /**
   * Name-first create: inserts an empty unity under a syllabus carrying
   * just the title. The writer subagent later fills in the activities
   * via `POST /api/unities/:id/generate`.
   *
   * Body: `{ syllabus_id: string, title: string, order_index?: number }`.
   */
  @Post()
  create(
    @Body()
    body: {
      syllabus_id?: string;
      title?: string;
      order_index?: number;
    },
  ) {
    return this.entities.createUnity({
      syllabus_id: body?.syllabus_id ?? "",
      title: body?.title ?? "Untitled unity",
      order_index: body?.order_index ?? 0,
    });
  }

  /**
   * Generate: streams the deep-agent's pass scoped to *this unity*.
   * The supervisor receives a synthesised user message that includes
   * the parent syllabus's audience / scope / pedagogy + the unity's
   * title, and dispatches the writer subagent to produce the unity's
   * activities (each calling `find_related_activities` first to avoid
   * duplicates with the rest of the syllabus).
   *
   * Wire: bare-bones SSE.
   */
  @Post(":id/generate")
  async generate(@Param("id") id: string, @Res() res: Response) {
    await this.scoped.streamScoped({
      scope: "unity",
      entityId: id,
      res,
    });
  }
}

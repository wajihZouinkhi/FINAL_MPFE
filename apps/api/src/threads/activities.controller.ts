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
 * Read-only by-id surface for individual activity rows (worksheets).
 *
 * The deep-agent supervisor embeds inline `<artifact kind="worksheet"
 * id="<activity_id>" />` chips in chat. Clicking the chip opens
 * `/activities/<id>` on the FE, which calls this endpoint and hands
 * the row to the existing `ActivityWorksheet` component for
 * rendering.
 *
 * The existing `GET /api/threads/:id/activities` returns the *list*
 * of activity rows for a thread — the right shape for activity
 * thread views (which render a feed) but not for the deep-agent
 * click-through, because:
 *
 *   1. A deep-agent thread can hold many activities (different
 *      lessons / standalone worksheets), and the link target is one
 *      specific activity.
 *   2. The FE link only carries the activity id, not the thread.
 *
 * Hence: `/api/activities/:id` keyed directly on the activity row's
 * primary key.
 */
@Controller("api/activities")
export class ActivitiesController {
  constructor(
    private readonly threads: ThreadsService,
    private readonly entities: EntitiesService,
    private readonly scoped: ScopedGenerateService,
  ) {}

  @Get(":id")
  activity(@Param("id") id: string) {
    return this.threads.activityById(id);
  }

  /**
   * Name-first create: inserts an empty activity row under a unity
   * carrying just the title. The writer subagent later fills in the
   * markdown cours body via `POST /api/activities/:id/generate`, and
   * `activity_maker` attaches the worksheet jsonb on its dispatch.
   *
   * Body: `{ unity_id: string, title: string, order_index?: number }`.
   */
  @Post()
  create(
    @Body()
    body: {
      unity_id?: string;
      title?: string;
      order_index?: number;
    },
  ) {
    return this.entities.createActivity({
      unity_id: body?.unity_id ?? "",
      title: body?.title ?? "Untitled activity",
      order_index: body?.order_index ?? 0,
    });
  }

  /**
   * Generate: streams the deep-agent's pass scoped to *this activity*.
   * The supervisor receives a synthesised user message that includes
   * the parent unity context and asks the writer + activity_maker to
   * populate the cours body and the worksheet jsonb.
   *
   * Wire: bare-bones SSE — see `SyllabusesController#generate`.
   */
  @Post(":id/generate")
  async generate(@Param("id") id: string, @Res() res: Response) {
    await this.scoped.streamScoped({
      scope: "activity",
      entityId: id,
      res,
    });
  }
}

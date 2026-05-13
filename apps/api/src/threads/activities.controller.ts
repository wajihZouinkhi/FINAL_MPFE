import { Controller, Get, Param } from "@nestjs/common";
import { ThreadsService } from "./threads.service";

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
  constructor(private readonly threads: ThreadsService) {}

  @Get(":id")
  activity(@Param("id") id: string) {
    return this.threads.activityById(id);
  }
}

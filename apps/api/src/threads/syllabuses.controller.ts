import { Controller, Get, Param } from "@nestjs/common";
import { ThreadsService } from "./threads.service";

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
  constructor(private readonly threads: ThreadsService) {}

  @Get(":id/snapshot")
  snapshot(@Param("id") id: string) {
    return this.threads.snapshotBySyllabusId(id);
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import type {
  AgentKind,
  ThreadListEntryStatus,
  ThreadListResponse,
} from "@mpfe/shared";
import { ThreadsService } from "./threads.service";

interface CreateThreadBody {
  agent?: AgentKind;
  bound_syllabus_thread_id?: string | null;
}

const KNOWN_AGENTS = new Set<AgentKind>([
  "syllabus-generator",
  "activity-generator-tooled",
  "activity-generator-toolless",
  "deepagent",
]);

const KNOWN_STATUSES = new Set<ThreadListEntryStatus>([
  "idle",
  "running",
  "interrupted",
  "completed",
  "failed",
]);

@Controller("api/threads")
export class ThreadsController {
  constructor(private readonly threads: ThreadsService) {}

  /**
   * Paginated thread list.
   *
   * Query params (all optional):
   *   agent  — AgentKind. If set, only threads for that agent are returned.
   *   status — ThreadListEntryStatus. Client-side filter hint.
   *   q      — freetext filter. Matched against title + last_user_message.
   *   cursor — opaque cursor returned by the previous page (`next_cursor`).
   *   limit  — page size (default 30, max 100).
   */
  @Get()
  async list(
    @Res() res: Response,
    @Headers("if-none-match") ifNoneMatch?: string,
    @Query("agent") agent?: string,
    @Query("status") status?: string,
    @Query("q") q?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ): Promise<void> {
    const parsedLimit = this.parseLimit(limit);
    const agentKind = this.parseAgent(agent);
    const statusKind = this.parseStatus(status);
    const trimmedQ = q?.trim() ? q.trim() : undefined;
    const trimmedCursor = cursor?.trim() ? cursor.trim() : undefined;

    // Audit §3.2 — first-page polls (no cursor) get an ETag-based 304
    // short-circuit when nothing on the visible page has changed. The
    // signature folds in MAX(updated_at) + COUNT(*) for the agent
    // filter plus the request-shape inputs (status / q / limit) so
    // requests with different filter combinations don't collide.
    // Paged calls (cursor set) bypass etagging — the page they're
    // resuming at is already historical, polling doesn't re-request
    // them, and computing a per-cursor signature would be redundant.
    let etag: string | null = null;
    if (!trimmedCursor) {
      const sig = await this.threads.listSignature(agentKind);
      const filterKey = [
        agentKind ?? "_",
        statusKind ?? "_",
        trimmedQ ?? "_",
        String(parsedLimit),
      ].join("|");
      etag = `W/"v1:${filterKey}:${sig}"`;
      if (ifNoneMatch && ifNoneMatch === etag) {
        // 304 — body MUST be empty per RFC 7232. Setting ETag again so
        // clients that drop it on 304 don't lose the validator.
        res.setHeader("ETag", etag);
        res.status(304).end();
        return;
      }
    }

    const body = await this.threads.list({
      agent: agentKind,
      status: statusKind,
      q: trimmedQ,
      cursor: trimmedCursor,
      limit: parsedLimit,
    });
    if (etag) res.setHeader("ETag", etag);
    res.status(200).json(body satisfies ThreadListResponse);
  }

  private parseLimit(raw: string | undefined): number {
    if (!raw) return 30;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 30;
    return Math.min(Math.floor(n), 100);
  }

  private parseAgent(raw: string | undefined): AgentKind | undefined {
    if (!raw) return undefined;
    if (!KNOWN_AGENTS.has(raw as AgentKind)) {
      throw new BadRequestException(`Unknown agent filter: ${raw}`);
    }
    return raw as AgentKind;
  }

  private parseStatus(
    raw: string | undefined,
  ): ThreadListEntryStatus | undefined {
    if (!raw) return undefined;
    if (!KNOWN_STATUSES.has(raw as ThreadListEntryStatus)) {
      throw new BadRequestException(`Unknown status filter: ${raw}`);
    }
    return raw as ThreadListEntryStatus;
  }

  /**
   * Create a new thread bound to a specific agent. The body is
   * optional for back-compat with old callers that don't know about
   * agents — those default to `syllabus-generator`.
   *
   * Body:
   *   {
   *     agent?: "syllabus-generator" | "activity-generator-tooled"
   *           | "activity-generator-toolless",
   *     bound_syllabus_thread_id?: string  // required for tooled
   *   }
   */
  @Post()
  create(@Body() body: CreateThreadBody | undefined) {
    return this.threads.create({
      agent: body?.agent,
      bound_syllabus_thread_id: body?.bound_syllabus_thread_id ?? null,
    });
  }

  @Get(":id/snapshot")
  snapshot(@Param("id") id: string) {
    return this.threads.snapshot(id);
  }

  /**
   * Activity-thread snapshot: returns the activity rows for a thread
   * plus the bound syllabus thread id (if any). The FE thread page
   * branches on `thread.agent` and calls this endpoint instead of
   * /snapshot for activity threads.
   */
  @Get(":id/activities")
  activities(@Param("id") id: string) {
    return this.threads.activitySnapshot(id);
  }

  /**
   * Mark a force-passed lesson as manually reviewed, clearing its amber
   * "review me" badge across all open tabs (Realtime UPDATE row
   * propagates the cleared `review_required` to every subscriber).
   *
   * Idempotent: re-calling on an already-cleared lesson is a no-op
   * (UPDATE just rewrites the same false / new timestamp).
   */
  @Patch(":id/lessons/:lessonId/review")
  markLessonReviewed(
    @Param("id") id: string,
    @Param("lessonId") lessonId: string,
  ) {
    return this.threads.markLessonReviewed(id, lessonId);
  }
}

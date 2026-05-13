import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { v4 as uuidv4 } from "uuid";
import { SupabaseService } from "../supabase/supabase.service";
import type {
  ActivityRow,
  AgentKind,
  SyllabusSnapshot,
  ThreadListCounts,
  ThreadListEntry,
  ThreadListEntryStatus,
  ThreadListResponse,
} from "@mpfe/shared";

const KNOWN_AGENTS: AgentKind[] = [
  "syllabus-generator",
  "activity-generator-tooled",
  "activity-generator-toolless",
  "deepagent",
];

interface ThreadListQuery {
  agent?: AgentKind;
  status?: ThreadListEntryStatus;
  q?: string;
  cursor?: string;
  limit?: number;
}

interface Cursor {
  updated_at: string;
  id: string;
}

@Injectable()
export class ThreadsService {
  constructor(private readonly supa: SupabaseService) {}

  /**
   * Paginated, filterable thread list for the /threads index page.
   *
   * Returns one page of {items, next_cursor, counts}. The page is
   * sorted by updated_at DESC with id as a tiebreaker; `next_cursor`
   * encodes the (updated_at, id) of the last DB row scanned so the
   * next call can fetch the next page without needing OFFSET.
   *
   * Because `status` is derived from agent_runs (not a column on
   * `threads`) and `q` is a freetext match on the joined title /
   * user-message, both filters are applied in-memory after the page
   * is hydrated. To keep the paging contract honest we KEEP SCANNING
   * additional DB pages until we have `limit` filtered items or we've
   * exhausted the table — otherwise a filter could discard an entire
   * DB page and the client would see an empty result even though
   * matches exist further down. A safety cap on the number of DB
   * round-trips prevents a pathological filter from walking the
   * whole table in one request; if the cap fires, `next_cursor` is
   * set so the client can keep going.
   *
   * `counts` is returned on every call so the UI can render per-agent
   * tab badges without a separate request. The facet counts are
   * computed across all agent kinds regardless of the `agent` filter.
   */
  async list(query: ThreadListQuery = {}): Promise<ThreadListResponse> {
    const limit = query.limit ?? 30;
    let cursor = this.decodeCursor(query.cursor);

    const collected: ThreadListEntry[] = [];
    let nextCursor: string | null = null;
    let scans = 0;
    const MAX_SCANS = 6;

    while (collected.length < limit && scans < MAX_SCANS) {
      scans += 1;

      const { rows, hasMoreDb } = await this.fetchThreadsPage({
        cursor,
        agent: query.agent,
        limit,
      });
      if (rows.length === 0) {
        nextCursor = null;
        break;
      }

      const mapped = await this.hydrateRows(rows);
      const filtered = this.applyMemoryFilters(mapped, query);
      for (const item of filtered) {
        if (collected.length >= limit) break;
        collected.push(item);
      }

      // Cursor always advances by the last SCANNED row, not the last
      // MATCHED item, so pagination continues past filter misses.
      const lastRow = rows[rows.length - 1];
      const nextKey: Cursor = {
        updated_at: lastRow.updated_at,
        id: lastRow.id,
      };

      if (!hasMoreDb) {
        // We've reached the end of the underlying table.
        nextCursor = null;
        break;
      }
      if (collected.length >= limit) {
        nextCursor = this.encodeCursor(nextKey);
        break;
      }
      cursor = nextKey;
      // Loop — keep scanning until we fill `limit` or exhaust the table.
    }

    // If we broke out of the loop because of MAX_SCANS (not because the
    // table is exhausted), we still have a usable cursor and the client
    // can keep loading. `cursor` already points at the last row we
    // scanned on the final iteration; re-encode it directly so the next
    // request resumes strictly AFTER that row (the keyset predicate is
    // `< cursor`, so encoding `cursor` itself — not the next unseen row
    // — is what preserves "no rows skipped, no rows duplicated").
    if (nextCursor === null && scans >= MAX_SCANS && collected.length < limit) {
      if (cursor) nextCursor = this.encodeCursor(cursor);
    }

    const counts = await this.countByAgent();
    return { items: collected, next_cursor: nextCursor, counts };
  }

  /**
   * One round-trip against `threads`, keyset-paginated. Returns the
   * raw rows (no hydration) plus a `hasMoreDb` flag derived from the
   * `limit+1` fetch trick. Kept separate so the main scan loop can
   * call it repeatedly without reinvoking the hydration joins on
   * empty pages.
   */
  private async fetchThreadsPage(opts: {
    cursor: Cursor | null;
    agent: AgentKind | undefined;
    limit: number;
  }): Promise<{
    rows: Array<{
      id: string;
      created_at: string;
      updated_at: string;
      agent: string | null;
      bound_syllabus_thread_id: string | null;
    }>;
    hasMoreDb: boolean;
  }> {
    let q = this.supa.client
      .from("threads")
      .select("id, created_at, updated_at, agent, bound_syllabus_thread_id")
      .order("updated_at", { ascending: false })
      .order("id", { ascending: false });
    if (opts.agent) q = q.eq("agent", opts.agent);
    if (opts.cursor) {
      // Defence in depth: `decodeCursor` already rejects anything that
      // isn't a strict ISO timestamp + UUID, so these values can't
      // contain commas/parens that would break out of the .or() filter
      // and inject sibling conditions (see decodeCursor regex).
      q = q.or(
        `updated_at.lt.${opts.cursor.updated_at},` +
          `and(updated_at.eq.${opts.cursor.updated_at},id.lt.${opts.cursor.id})`,
      );
    }
    q = q.limit(opts.limit + 1);
    const { data, error } = await q;
    if (error) throw error;
    const rows = data ?? [];
    const hasMoreDb = rows.length > opts.limit;
    return { rows: rows.slice(0, opts.limit), hasMoreDb };
  }

  private async hydrateRows(
    rows: Array<{
      id: string;
      created_at: string;
      updated_at: string;
      agent: string | null;
      bound_syllabus_thread_id: string | null;
    }>,
  ): Promise<ThreadListEntry[]> {
    const ids = rows.map((t) => t.id);
    const [{ data: syllabuses, error: sylErr }, { data: runs, error: runErr }] =
      await Promise.all([
        this.supa.client
          .from("syllabuses")
          .select("thread_id, title, created_at")
          .in("thread_id", ids)
          .order("created_at", { ascending: false }),
        this.supa.client
          .from("agent_runs")
          .select(
            "thread_id, status, user_message, started_at, finished_at, created_at, error",
          )
          .in("thread_id", ids)
          .order("created_at", { ascending: false }),
      ]);
    if (sylErr) throw sylErr;
    if (runErr) throw runErr;

    const titleByThread = new Map<string, string>();
    for (const s of syllabuses ?? []) {
      if (!titleByThread.has(s.thread_id)) {
        titleByThread.set(s.thread_id, s.title);
      }
    }
    type RunRow = {
      thread_id: string;
      status: string;
      user_message: string | null;
      started_at: string | null;
      finished_at: string | null;
      created_at: string;
      error: string | null;
    };
    const lastRunByThread = new Map<string, RunRow>();
    for (const r of (runs ?? []) as RunRow[]) {
      if (!lastRunByThread.has(r.thread_id)) {
        lastRunByThread.set(r.thread_id, r);
      }
    }
    return rows.map((t): ThreadListEntry => {
      const run = lastRunByThread.get(t.id) ?? null;
      const title = titleByThread.get(t.id) ?? null;
      const status: ThreadListEntryStatus = !run
        ? "idle"
        : run.status === "running" || run.status === "queued"
          ? "running"
          : run.status === "paused"
            ? "interrupted"
            : run.status === "completed"
              ? "completed"
              : "failed";
      const agent = (t.agent ?? "syllabus-generator") as AgentKind;
      return {
        id: t.id,
        created_at: t.created_at,
        updated_at: t.updated_at,
        title,
        last_user_message: run?.user_message ?? null,
        status,
        last_run_at: run?.started_at ?? run?.created_at ?? null,
        last_run_error: run?.error ?? null,
        agent,
        bound_syllabus_thread_id: t.bound_syllabus_thread_id ?? null,
      };
    });
  }

  private applyMemoryFilters(
    items: ThreadListEntry[],
    query: ThreadListQuery,
  ): ThreadListEntry[] {
    return items.filter((item) => {
      if (query.status && item.status !== query.status) return false;
      if (query.q) {
        const needle = query.q.toLowerCase();
        const hay = [item.title, item.last_user_message, item.id]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }

  /**
   * Cheap "did anything change?" signature for the threads list, used
   * by the controller to short-circuit silent polls with HTTP 304 when
   * the visible first page hasn't changed (audit §3.2).
   *
   * The list response in `hydrateRows` derives fields from three
   * tables — `threads` (id, timestamps, agent), `agent_runs` (status,
   * user_message, error, started_at, finished_at, created_at) and
   * `syllabuses` (title) — so the signature must move whenever ANY
   * of those three tables changes a value the response cares about.
   * The previous shape (`MAX(threads.updated_at):COUNT(threads)`) was
   * incomplete: `threads.updated_at` is set on insert and never
   * touched again — nothing in the codebase calls
   * `.update().from("threads")`, and the generic `set_updated_at`
   * trigger in 0001 only fires on direct `UPDATE threads`. Run
   * lifecycle transitions (running → completed / paused / failed) and
   * syllabus title creation therefore did NOT bump the ETag, so
   * conditional polls served stale 304s and the FE list froze.
   *
   * Shape (colon-joined, deterministic order):
   *
   *     threads.max_updated_at
   *   : threads.count                 (filtered by `agent` if set)
   *   : agent_runs.max_created_at     (covers new run inserts —
   *                                    queued/running rows)
   *   : agent_runs.max_finished_at    (covers terminal transitions
   *                                    set by run-recorder.complete /
   *                                    pause / fail)
   *   : agent_runs.count
   *   : syllabuses.max_updated_at     (covers title insert + edit)
   *   : syllabuses.count
   *
   * `last_heartbeat` is intentionally excluded — including it would
   * bump the signature on every heartbeat tick of every running run,
   * defeating the 304 optimisation while a worker is active even
   * though no displayed field has changed. Inserts and the three
   * terminal transitions are the only state changes the threads-list
   * UI surfaces.
   *
   * `agent_runs` and `syllabuses` are queried globally rather than
   * scoped to the `agent` filter (which would require a join). The
   * controller already folds the `agent` value into the ETag string,
   * so different tabs never share an ETag — the only cost of the
   * global scope is that activity in one tab's data eagerly
   * invalidates other tabs' ETags, which is acceptable for a polling
   * endpoint that already runs every 8s per tab.
   *
   * Cost: four parallel index probes (see migration
   * `0010_thread_list_signature_idx.sql`). Each is an index-only
   * `ORDER BY ... DESC LIMIT 1` plus a head-only `count: "exact"`,
   * so aggregate latency stays well under the ~14 KB JSON body we
   * save per polled tab when the 304 fires.
   */
  async listSignature(agent?: AgentKind): Promise<string> {
    let threadsQ = this.supa.client
      .from("threads")
      .select("updated_at", { count: "exact", head: false })
      .order("updated_at", { ascending: false })
      .limit(1);
    if (agent) threadsQ = threadsQ.eq("agent", agent);

    const runsCreatedQ = this.supa.client
      .from("agent_runs")
      .select("created_at", { count: "exact", head: false })
      .order("created_at", { ascending: false })
      .limit(1);

    const runsFinishedQ = this.supa.client
      .from("agent_runs")
      .select("finished_at")
      .not("finished_at", "is", null)
      .order("finished_at", { ascending: false })
      .limit(1);

    const sylQ = this.supa.client
      .from("syllabuses")
      .select("updated_at", { count: "exact", head: false })
      .order("updated_at", { ascending: false })
      .limit(1);

    const [threads, runsCreated, runsFinished, syl] = await Promise.all([
      threadsQ,
      runsCreatedQ,
      runsFinishedQ,
      sylQ,
    ]);

    if (threads.error) throw threads.error;
    if (runsCreated.error) throw runsCreated.error;
    if (runsFinished.error) throw runsFinished.error;
    if (syl.error) throw syl.error;

    const threadsMax =
      threads.data && threads.data.length > 0 ? threads.data[0].updated_at : "0";
    const runsCreatedMax =
      runsCreated.data && runsCreated.data.length > 0
        ? runsCreated.data[0].created_at
        : "0";
    const runsFinishedMax =
      runsFinished.data && runsFinished.data.length > 0
        ? runsFinished.data[0].finished_at
        : "0";
    const sylMax =
      syl.data && syl.data.length > 0 ? syl.data[0].updated_at : "0";

    return [
      threadsMax,
      threads.count ?? 0,
      runsCreatedMax,
      runsFinishedMax,
      runsCreated.count ?? 0,
      sylMax,
      syl.count ?? 0,
    ].join(":");
  }

  private async countByAgent(): Promise<ThreadListCounts> {
    const [syl, tooled, toolless, deep] = await Promise.all(
      KNOWN_AGENTS.map(async (agent) => {
        const { count, error } = await this.supa.client
          .from("threads")
          .select("id", { count: "exact", head: true })
          .eq("agent", agent);
        if (error) throw error;
        return count ?? 0;
      }),
    );
    return {
      "syllabus-generator": syl,
      "activity-generator-tooled": tooled,
      "activity-generator-toolless": toolless,
      "deepagent": deep,
    };
  }

  private encodeCursor(c: Cursor): string {
    return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
  }

  /**
   * Decode + strictly validate an opaque cursor. The decoded values
   * are later interpolated into a PostgREST `.or()` filter string, so
   * anything with commas/parens would let a caller inject sibling OR
   * branches and bypass the `.eq("agent", …)` constraint. We require
   * `updated_at` to match a canonical ISO 8601 shape and `id` to be a
   * UUID. Any other shape (or any JSON parse failure) is silently
   * treated as "no cursor, return the first page".
   */
  private decodeCursor(raw: string | undefined): Cursor | null {
    if (!raw) return null;
    try {
      const json = Buffer.from(raw, "base64url").toString("utf8");
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== "object") return null;
      const asObj = parsed as Record<string, unknown>;
      const updatedAt = asObj.updated_at;
      const id = asObj.id;
      if (typeof updatedAt !== "string" || typeof id !== "string") return null;
      // Strict ISO 8601 datetime: `YYYY-MM-DDTHH:MM:SS[.fff][+HH:MM|Z]`.
      // The supabase-js client serialises Postgres `timestamptz` in
      // exactly this shape.
      const ISO_RE =
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
      // UUID v4 layout (8-4-4-4-12 hex, case-insensitive).
      const UUID_RE =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!ISO_RE.test(updatedAt) || !UUID_RE.test(id)) return null;
      return { updated_at: updatedAt, id };
    } catch {
      // Invalid cursor → treat as first page.
    }
    return null;
  }

  /**
   * Create a new thread.
   *
   * The `agent` field decides which compiled LangGraph the API runs
   * for this thread (see GraphService registry). For
   * activity-generator-tooled threads, `bound_syllabus_thread_id` is
   * required and must reference an existing syllabus-generator
   * thread; we validate both at this layer rather than relying on the
   * DB CHECK constraint alone so the FE gets a 400 with a useful
   * message rather than a generic 500.
   */
  async create(
    opts: {
      agent?: AgentKind;
      bound_syllabus_thread_id?: string | null;
    } = {},
  ): Promise<{
    id: string;
    agent: AgentKind;
    bound_syllabus_thread_id: string | null;
  }> {
    const agent = (opts.agent ?? "syllabus-generator") as AgentKind;
    if (!KNOWN_AGENTS.includes(agent)) {
      throw new BadRequestException(`Unknown agent kind: ${agent}`);
    }
    const boundId = opts.bound_syllabus_thread_id ?? null;
    if (agent === "activity-generator-tooled") {
      if (!boundId) {
        throw new BadRequestException(
          "activity-generator-tooled threads require bound_syllabus_thread_id",
        );
      }
      // Confirm the source thread exists and is itself a syllabus thread.
      const { data: parent, error: pErr } = await this.supa.client
        .from("threads")
        .select("id, agent")
        .eq("id", boundId)
        .maybeSingle();
      if (pErr) throw pErr;
      if (!parent) {
        throw new BadRequestException(
          `bound_syllabus_thread_id ${boundId} not found`,
        );
      }
      if (parent.agent && parent.agent !== "syllabus-generator") {
        throw new BadRequestException(
          `bound_syllabus_thread_id must reference a syllabus-generator thread (got ${parent.agent})`,
        );
      }
    } else if (boundId) {
      throw new BadRequestException(
        "Only activity-generator-tooled threads may set bound_syllabus_thread_id",
      );
    }
    const id = uuidv4();
    const { error } = await this.supa.client
      .from("threads")
      .insert({ id, agent, bound_syllabus_thread_id: boundId })
      .select("id")
      .single();
    if (error) throw error;
    return { id, agent, bound_syllabus_thread_id: boundId };
  }

  /**
   * Look up the agent + bound syllabus thread for a single thread.
   * Used by the chat controller to dispatch each turn to the correct
   * compiled graph in the registry. Returns null when the thread
   * doesn't exist.
   */
  async getAgent(
    threadId: string,
  ): Promise<{ agent: AgentKind; bound_syllabus_thread_id: string | null } | null> {
    const { data, error } = await this.supa.client
      .from("threads")
      .select("agent, bound_syllabus_thread_id")
      .eq("id", threadId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      agent: ((data.agent as string | null) ??
        "syllabus-generator") as AgentKind,
      bound_syllabus_thread_id:
        (data.bound_syllabus_thread_id as string | null) ?? null,
    };
  }

  /**
   * Activity-thread snapshot. Pulls the rows from `activities` for the
   * thread plus the bound syllabus thread id (so the FE can render a
   * "binds to syllabus X" link on tooled threads). Mirrors the
   * read-once-then-Realtime pattern of `snapshot()`.
   */
  async activitySnapshot(threadId: string): Promise<{
    thread_id: string;
    agent: AgentKind;
    bound_syllabus_thread_id: string | null;
    activities: ActivityRow[];
  }> {
    const meta = await this.getAgent(threadId);
    if (!meta) {
      throw new NotFoundException(`Thread ${threadId} not found`);
    }
    const { data, error } = await this.supa.client
      .from("activities")
      .select(
        "id, thread_id, lesson_id, kind, prompt, lesson_title, content, created_at, updated_at",
      )
      .eq("thread_id", threadId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return {
      thread_id: threadId,
      agent: meta.agent,
      bound_syllabus_thread_id: meta.bound_syllabus_thread_id,
      activities: (data ?? []) as ActivityRow[],
    };
  }

  /**
   * Read the full syllabus tree for a thread. Used by the frontend
   * once on mount; afterwards Supabase Realtime pushes deltas.
   */
  async snapshot(threadId: string): Promise<SyllabusSnapshot> {
    const { data: syllabus, error: syllErr } = await this.supa.client
      .from("syllabuses")
      .select("id, thread_id, title, description, audience, scope, pedagogy")
      .eq("thread_id", threadId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (syllErr) throw syllErr;

    if (!syllabus) {
      return { thread_id: threadId, syllabus: null, chapters: [] };
    }

    return this.hydrateSyllabusSnapshot(threadId, syllabus);
  }

  /**
   * Read the full syllabus tree for a syllabus id (independent of
   * which thread originally produced it). Used by the FE artifact
   * card click-through: the deep-agent embeds `<artifact
   * kind="syllabus" id="<syllabus_id>" />` chips in chat, and the
   * `/syllabuses/[id]` page calls this to render a stand-alone
   * read-only viewer.
   *
   * Returns the same `SyllabusSnapshot` shape as `snapshot()`. The
   * `thread_id` field is the originating thread id from the syllabus
   * row — useful for "back to chat" affordances on the viewer.
   */
  async snapshotBySyllabusId(syllabusId: string): Promise<SyllabusSnapshot> {
    const { data: syllabus, error: syllErr } = await this.supa.client
      .from("syllabuses")
      .select("id, thread_id, title, description, audience, scope, pedagogy")
      .eq("id", syllabusId)
      .maybeSingle();
    if (syllErr) throw syllErr;
    if (!syllabus) {
      throw new NotFoundException(`Syllabus ${syllabusId} not found`);
    }
    return this.hydrateSyllabusSnapshot(syllabus.thread_id, syllabus);
  }

  /**
   * Shared chapter+lesson loader used by both `snapshot()` (look-up
   * by thread) and `snapshotBySyllabusId()` (look-up by id). Takes a
   * pre-resolved syllabus row to avoid a redundant round-trip.
   */
  private async hydrateSyllabusSnapshot(
    threadId: string,
    syllabus: NonNullable<SyllabusSnapshot["syllabus"]>,
  ): Promise<SyllabusSnapshot> {
    const { data: chapters, error: chapErr } = await this.supa.client
      .from("chapters")
      .select("id, syllabus_id, title, order_index, outcomes, prerequisites")
      .eq("syllabus_id", syllabus.id)
      .order("order_index", { ascending: true });
    if (chapErr) throw chapErr;

    const chapterIds = (chapters ?? []).map((c) => c.id);
    const { data: lessons, error: lessErr } = chapterIds.length
      ? await this.supa.client
          .from("lessons")
          .select(
            "id, chapter_id, title, content, order_index, learning_objectives, prerequisites, key_terms, worked_example_seed, assessment_idea, duration_min, review_required, block_issues, critic_issues, depends_on",
          )
          .in("chapter_id", chapterIds)
          .order("order_index", { ascending: true })
      : { data: [], error: null };
    if (lessErr) throw lessErr;

    const lessonsByChapter = new Map<string, typeof lessons>();
    for (const l of lessons ?? []) {
      const arr = lessonsByChapter.get(l.chapter_id) ?? [];
      arr.push(l);
      lessonsByChapter.set(l.chapter_id, arr);
    }

    return {
      thread_id: threadId,
      syllabus,
      chapters: (chapters ?? []).map((c) => ({
        ...c,
        lessons: lessonsByChapter.get(c.id) ?? [],
      })),
    };
  }

  /**
   * Look up a single activity row by its primary key. Used by the FE
   * artifact card click-through for `<artifact kind="worksheet"
   * id="<activity_id>" />` chips: the `/activities/[id]` page calls
   * this to render the existing `ActivityWorksheet` component
   * stand-alone (no chat). 404s if the row is missing.
   */
  async activityById(activityId: string): Promise<ActivityRow> {
    const { data, error } = await this.supa.client
      .from("activities")
      .select(
        "id, thread_id, lesson_id, kind, prompt, lesson_title, content, created_at, updated_at",
      )
      .eq("id", activityId)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      throw new NotFoundException(`Activity ${activityId} not found`);
    }
    return data as ActivityRow;
  }

  /**
   * Mark a force-passed lesson as manually reviewed by the teacher,
   * clearing the amber "review me" badge from the FE. Sets
   * `review_required` to false (which the FileTree badge and the
   * LessonContractHeader banner gate on) and records `review_cleared_at`
   * for audit.
   *
   * The Supabase Realtime channel propagates the UPDATE row to all
   * subscribed clients, so the badge clears in every open tab without
   * an explicit refetch.
   *
   * Scoped by `(threadId, lessonId)` so a lesson from one thread can't
   * clear a lesson from another (defence-in-depth — the FE only ever
   * issues the call for lessons it owns, but the constraint at this
   * layer keeps that property even if a stale tab fires the request).
   *
   * Returns the updated lesson row (so the caller has the canonical
   * post-update state without round-tripping through Realtime).
   */
  async markLessonReviewed(
    threadId: string,
    lessonId: string,
  ): Promise<{ id: string; review_required: boolean; review_cleared_at: string | null }> {
    // Resolve the lesson's owning syllabus → thread to confirm scope. A
    // single SQL join via PostgREST keeps this to one round-trip.
    const { data: lesson, error: lookupErr } = await this.supa.client
      .from("lessons")
      .select("id, chapter_id, chapters!inner(syllabus_id, syllabuses!inner(thread_id))")
      .eq("id", lessonId)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!lesson) {
      throw new NotFoundException(`Lesson ${lessonId} not found`);
    }
    const owningThreadId =
      // PostgREST nested-select shape: chapters is an object (one-to-one
      // because we joined on chapter_id), and chapters.syllabuses is the
      // syllabus row.
      (lesson as unknown as {
        chapters: { syllabuses: { thread_id: string } };
      }).chapters?.syllabuses?.thread_id;
    if (owningThreadId !== threadId) {
      throw new ForbiddenException(
        `Lesson ${lessonId} does not belong to thread ${threadId}`,
      );
    }

    const { data: updated, error: updErr } = await this.supa.client
      .from("lessons")
      .update({
        review_required: false,
        review_cleared_at: new Date().toISOString(),
      })
      .eq("id", lessonId)
      .select("id, review_required, review_cleared_at")
      .single();
    if (updErr) throw updErr;
    return updated;
  }
}

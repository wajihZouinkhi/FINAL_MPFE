import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { McpClientService } from "../graph/activity/mcp-client.service";
import { SupabaseService } from "../supabase/supabase.service";

/**
 * Render a `number[]` as a pgvector literal string (e.g.
 * ``"[0.123456,-0.000123,...]"``). Mirrors the Python helper
 * `vector_literal` in `apps/mcp-supabase/.../embeddings.py` so the
 * REST path and the MCP path write the same on-disk shape into
 * `activity_embeddings.embedding` / `unity_embeddings.embedding`.
 *
 * pgvector accepts the literal directly when the column is typed
 * `vector(384)`; PostgREST (Supabase's REST layer) forwards the
 * string verbatim and Postgres casts on insert.
 */
function vectorLiteral(vec: number[]): string {
  return "[" + vec.map((x) => x.toFixed(6)).join(",") + "]";
}

/**
 * SHA-1 hex digest of the canonicalised text. Stored alongside the
 * embedding so re-embedding logic can short-circuit when the
 * source text has not changed. Mirrors the Python `content_hash`
 * helper for byte-for-byte equality across the two write paths.
 */
function contentHash(text: string): string {
  return createHash("sha1").update(text || "").digest("hex");
}

/**
 * Low-level INSERT / SELECT for the post-merge entity model:
 *
 *   Syllabus -> Unity -> Activity (cours body + worksheet jsonb)
 *
 * Used by the `name first, generate second` REST controllers
 * (`SyllabusesController`, `UnitiesController`, `ActivitiesController`).
 * The "generate" half of the flow lives in `ScopedGenerateService` and
 * delegates to `DeepAgentService.runScoped`.
 *
 * This is intentionally a thin wrapper over Supabase \u2014 the rich query
 * helpers + snapshot hydration live on `ThreadsService` and continue to
 * be used by the legacy /api/chat flow. Splitting the writes into a
 * separate service keeps the legacy chat-flow code path untouched.
 */
@Injectable()
export class EntitiesService {
  private readonly logger = new Logger(EntitiesService.name);

  constructor(
    private readonly supa: SupabaseService,
    private readonly mcp: McpClientService,
  ) {}

  /**
   * Compute the MCP `embed_text` vector for a string, falling back to
   * a zero vector if the MCP call fails. Errors are logged but never
   * thrown — the REST create endpoints must still succeed when the
   * MCP server is briefly unreachable; the row's embedding can be
   * backfilled later via `scripts/backfill-activity-embeddings.ts`.
   */
  private async embedText(text: string): Promise<number[] | null> {
    if (!text || !text.trim()) {
      // Match the Python helper: empty source -> all-zero 384-d vector.
      return new Array<number>(384).fill(0);
    }
    try {
      const result = await this.mcp.callTool("embed_text", { text });
      // FastMCP wraps a `list[float]` return as `{result: [...]}` in
      // `structuredContent`; `McpClientService.callTool` unwraps the
      // `.result` key for us so we should get the array directly.
      if (Array.isArray(result)) {
        return (result as unknown[]).map((x) => Number(x));
      }
      // Defensive fallback: some MCP transports may surface a single-
      // element wrapper array of the actual vector when content blocks
      // pass through the text-content path.
      if (
        Array.isArray(result) === false &&
        result &&
        typeof result === "object" &&
        Array.isArray((result as { result?: unknown }).result)
      ) {
        return ((result as { result: unknown[] }).result).map((x) =>
          Number(x),
        );
      }
      this.logger.warn(
        `embed_text returned unexpected shape: ${JSON.stringify(result).slice(0, 200)}`,
      );
      return null;
    } catch (err) {
      this.logger.warn(
        `embed_text MCP call failed: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Upsert into `activity_embeddings` for a freshly-created activity
   * row, using the same `title + body + LOs + key_terms` source the
   * MCP `create_activity` tool uses. Best-effort: any failure is
   * logged and swallowed so the REST `POST /api/activities` response
   * still goes back 201.
   */
  private async upsertActivityEmbedding(opts: {
    activity_id: string;
    syllabus_id: string;
    title: string;
    body: string;
    learning_objectives?: unknown;
    key_terms?: unknown;
  }): Promise<void> {
    try {
      const loStrs = Array.isArray(opts.learning_objectives)
        ? (opts.learning_objectives as unknown[]).map((lo) => {
            if (lo && typeof lo === "object" && "text" in (lo as object)) {
              const t = (lo as { text?: unknown }).text;
              return typeof t === "string" ? t : String(lo);
            }
            return String(lo);
          })
        : [];
      const ktStrs = Array.isArray(opts.key_terms)
        ? (opts.key_terms as unknown[]).map((k) => String(k))
        : [];
      const source = [
        opts.title,
        opts.body,
        loStrs.join(", "),
        ktStrs.join(", "),
      ]
        .filter((p) => p)
        .join("\n");
      const vec = await this.embedText(source);
      if (!vec) return;
      const { error } = await this.supa.client
        .from("activity_embeddings")
        .upsert(
          {
            activity_id: opts.activity_id,
            syllabus_id: opts.syllabus_id,
            content_hash: contentHash(source),
            embedding: vectorLiteral(vec),
          },
          { onConflict: "activity_id" },
        );
      if (error) {
        this.logger.warn(
          `activity_embeddings upsert failed for ${opts.activity_id}: ${error.message}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `activity_embeddings upsert threw for ${opts.activity_id}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Upsert into `unity_embeddings` for a freshly-created unity row.
   * Mirrors the MCP `create_unity` tool's auto-upsert path so the
   * `find_related_unities` retrieval sees unities created by the REST
   * `POST /api/unities` handler as well.
   */
  private async upsertUnityEmbedding(opts: {
    unity_id: string;
    syllabus_id: string;
    title: string;
    outcomes?: unknown;
    prerequisites?: unknown;
  }): Promise<void> {
    try {
      const outcomesStrs = Array.isArray(opts.outcomes)
        ? (opts.outcomes as unknown[]).map((o) => String(o))
        : [];
      const prereqsStrs = Array.isArray(opts.prerequisites)
        ? (opts.prerequisites as unknown[]).map((p) => String(p))
        : [];
      const source = [
        opts.title,
        outcomesStrs.join(", "),
        prereqsStrs.join(", "),
      ]
        .filter((p) => p)
        .join("\n");
      const vec = await this.embedText(source);
      if (!vec) return;
      const { error } = await this.supa.client
        .from("unity_embeddings")
        .upsert(
          {
            unity_id: opts.unity_id,
            syllabus_id: opts.syllabus_id,
            content_hash: contentHash(source),
            embedding: vectorLiteral(vec),
          },
          { onConflict: "unity_id" },
        );
      if (error) {
        this.logger.warn(
          `unity_embeddings upsert failed for ${opts.unity_id}: ${error.message}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `unity_embeddings upsert threw for ${opts.unity_id}: ${(err as Error).message}`,
      );
    }
  }

  // \u2500\u2500\u2500 syllabuses \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  async createSyllabus(opts: {
    title: string;
    description: string;
    thread_id: string | null;
  }): Promise<{ id: string; title: string; thread_id: string }> {
    if (!opts.title?.trim()) {
      throw new BadRequestException("title is required");
    }

    // syllabuses.thread_id is NOT NULL with an ON DELETE CASCADE FK to
    // threads(id). When the caller doesn't supply a thread id, allocate
    // a synthetic deep-agent thread up-front so the syllabus has
    // somewhere to checkpoint when /generate runs.
    let threadId = opts.thread_id;
    if (!threadId) {
      const newThreadId = uuidv4();
      const { error: threadErr } = await this.supa.client
        .from("threads")
        .insert({ id: newThreadId, agent: "deepagent" })
        .select("id")
        .single();
      if (threadErr) throw threadErr;
      threadId = newThreadId;
    }

    const id = uuidv4();
    const { error } = await this.supa.client
      .from("syllabuses")
      .insert({
        id,
        title: opts.title.trim(),
        description: opts.description,
        thread_id: threadId,
      })
      .select("id")
      .single();
    if (error) throw error;
    return { id, title: opts.title.trim(), thread_id: threadId };
  }

  async getSyllabus(syllabusId: string): Promise<{
    id: string;
    title: string;
    description: string;
    thread_id: string | null;
    audience: unknown;
    scope: unknown;
    pedagogy: unknown;
  }> {
    const { data, error } = await this.supa.client
      .from("syllabuses")
      .select("id, title, description, thread_id, audience, scope, pedagogy")
      .eq("id", syllabusId)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      throw new NotFoundException(`Syllabus ${syllabusId} not found`);
    }
    return data as {
      id: string;
      title: string;
      description: string;
      thread_id: string | null;
      audience: unknown;
      scope: unknown;
      pedagogy: unknown;
    };
  }

  // \u2500\u2500\u2500 unities \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  async createUnity(opts: {
    syllabus_id: string;
    title: string;
    order_index: number;
  }): Promise<{ id: string; syllabus_id: string; title: string }> {
    if (!opts.syllabus_id) {
      throw new BadRequestException("syllabus_id is required");
    }
    if (!opts.title?.trim()) {
      throw new BadRequestException("title is required");
    }
    const id = uuidv4();
    const title = opts.title.trim();
    const { error } = await this.supa.client
      .from("unities")
      .insert({
        id,
        syllabus_id: opts.syllabus_id,
        title,
        order_index: opts.order_index,
      })
      .select("id")
      .single();
    if (error) throw error;
    // Parity with the MCP `create_unity` tool: keep `unity_embeddings`
    // in sync so `find_related_unities` retrieval sees this row. The
    // placeholder has only a title at this point; the writer subagent's
    // `update_unity` call later re-embeds with the full outcomes /
    // prerequisites.
    await this.upsertUnityEmbedding({
      unity_id: id,
      syllabus_id: opts.syllabus_id,
      title,
    });
    return { id, syllabus_id: opts.syllabus_id, title };
  }

  async getUnity(unityId: string): Promise<{
    id: string;
    syllabus_id: string;
    title: string;
    order_index: number;
    outcomes: unknown;
    prerequisites: unknown;
  }> {
    const { data, error } = await this.supa.client
      .from("unities")
      .select("id, syllabus_id, title, order_index, outcomes, prerequisites")
      .eq("id", unityId)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      throw new NotFoundException(`Unity ${unityId} not found`);
    }
    return data as {
      id: string;
      syllabus_id: string;
      title: string;
      order_index: number;
      outcomes: unknown;
      prerequisites: unknown;
    };
  }

  // \u2500\u2500\u2500 activities (post-merge: cours body + worksheet jsonb) \u2500\u2500\u2500\u2500\u2500\u2500\u2500
  async createActivity(opts: {
    unity_id: string;
    title: string;
    order_index: number;
  }): Promise<{ id: string; unity_id: string; title: string }> {
    if (!opts.unity_id) {
      throw new BadRequestException("unity_id is required");
    }
    if (!opts.title?.trim()) {
      throw new BadRequestException("title is required");
    }
    const id = uuidv4();
    const title = opts.title.trim();
    const { error } = await this.supa.client
      .from("activities")
      .insert({
        id,
        unity_id: opts.unity_id,
        title,
        order_index: opts.order_index,
        // The legacy `kind` column is non-null with a `worksheet` check
        // constraint; we set it explicitly so the post-merge activity
        // rows still satisfy the constraint while the column is around.
        kind: "worksheet",
        // Legacy `prompt` column is non-null; default to empty until
        // the writer subagent fills it on generate.
        prompt: "",
        // Legacy `lesson_title` column is non-null; mirror the title so
        // legacy readers still see something meaningful.
        lesson_title: title,
        // Legacy `content` (jsonb worksheet) is non-null with `{}`
        // default \u2014 don't override it.
        body: "",
        worksheet: {},
      })
      .select("id")
      .single();
    if (error) throw error;
    // Parity with the MCP `create_activity` tool: keep
    // `activity_embeddings` in sync so `find_related_activities`
    // retrieval sees this row. The placeholder has only a title at
    // this point; the writer subagent's `update_activity` call later
    // re-embeds with the full cours body + LOs + key_terms.
    const syllabusId = await this.syllabusIdForUnity(opts.unity_id);
    if (syllabusId) {
      await this.upsertActivityEmbedding({
        activity_id: id,
        syllabus_id: syllabusId,
        title,
        body: "",
      });
    } else {
      this.logger.warn(
        `createActivity: skipping activity_embeddings upsert for ${id} because unity ${opts.unity_id} has no syllabus_id`,
      );
    }
    return { id, unity_id: opts.unity_id, title };
  }

  /** Read the parent syllabus_id of a unity (used by ScopedGenerateService
   * to constrain the find_related_* anti-dup query scope when generating
   * unity- or activity-scoped passes). */
  async syllabusIdForUnity(unityId: string): Promise<string | null> {
    const { data, error } = await this.supa.client
      .from("unities")
      .select("syllabus_id")
      .eq("id", unityId)
      .maybeSingle();
    if (error) throw error;
    return (data?.syllabus_id as string | null) ?? null;
  }

  /** Read the parent syllabus_id of an activity (via its unity). */
  async syllabusIdForActivity(activityId: string): Promise<string | null> {
    const { data, error } = await this.supa.client
      .from("activities")
      .select("unity_id, unities(syllabus_id)")
      .eq("id", activityId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const unities = data.unities as
      | { syllabus_id: string }
      | { syllabus_id: string }[]
      | null;
    if (Array.isArray(unities)) {
      return unities[0]?.syllabus_id ?? null;
    }
    return unities?.syllabus_id ?? null;
  }

  /** Resolve the thread_id that owns a syllabus, or null if the syllabus
   * was created via the name-first POST endpoint without a thread bind. */
  async threadIdForSyllabus(syllabusId: string): Promise<string | null> {
    const { data, error } = await this.supa.client
      .from("syllabuses")
      .select("thread_id")
      .eq("id", syllabusId)
      .maybeSingle();
    if (error) throw error;
    return (data?.thread_id as string | null) ?? null;
  }

  // ─── curriculum outline (powers the curriculum-context block) ──────────────

  /**
   * Compact outline of one syllabus's full subtree, intended for the
   * curriculum-context block that `ScopedGenerateService` injects
   * into the supervisor's prompt before each `/generate` pass.
   *
   * Difference from `treeForSyllabus(...)`:
   *
   *   - Includes the syllabus's `audience` / `scope` / `pedagogy`
   *     contract (treeForSyllabus only returns title + description).
   *   - Includes per-unity `outcomes` / `prerequisites` so the agent
   *     can match demarche pedagogique without a separate read.
   *   - Includes per-activity `learning_objectives`, `key_terms`,
   *     `bloom_level`, `duration_min`, and `body_len` (computed from
   *     `body`) so the agent can see what's already covered without
   *     us shipping the full markdown bodies (token cost).
   *   - The `body` column is selected (because `body_len` is computed
   *     in JS) but is NOT returned by this method.
   *
   * Single round-trip with two indexed queries
   * (`select * from unities where syllabus_id=?` then
   * `select * from activities where unity_id = any(?)`). For a
   * syllabus with 10 unities × 5 activities = 50 rows, both queries
   * are sub-millisecond on the eu-west-1 pooler.
   */
  async getSyllabusOutline(syllabusId: string): Promise<{
    syllabus: {
      id: string;
      title: string;
      description: string;
      audience: unknown;
      scope: unknown;
      pedagogy: unknown;
    };
    unities: Array<{
      id: string;
      title: string;
      order_index: number;
      outcomes: unknown;
      prerequisites: unknown;
      activities: Array<{
        id: string;
        title: string;
        order_index: number;
        body_len: number;
        learning_objectives: unknown;
        key_terms: unknown;
        bloom_level: unknown;
        duration_min: unknown;
      }>;
    }>;
  }> {
    const { data: syllabusRow, error: sErr } = await this.supa.client
      .from("syllabuses")
      .select("id, title, description, audience, scope, pedagogy")
      .eq("id", syllabusId)
      .maybeSingle();
    if (sErr) throw sErr;
    if (!syllabusRow) {
      throw new NotFoundException(`Syllabus ${syllabusId} not found`);
    }

    const { data: unities, error: uErr } = await this.supa.client
      .from("unities")
      .select("id, title, order_index, outcomes, prerequisites")
      .eq("syllabus_id", syllabusId)
      .order("order_index", { ascending: true });
    if (uErr) throw uErr;

    const unityIds = (unities ?? []).map((u) => u.id as string);
    const { data: activities, error: aErr } = unityIds.length
      ? await this.supa.client
          .from("activities")
          .select(
            "id, unity_id, title, order_index, body, learning_objectives, key_terms, bloom_level, duration_min",
          )
          .in("unity_id", unityIds)
          .order("order_index", { ascending: true })
      : { data: [], error: null };
    if (aErr) throw aErr;

    const byUnity = new Map<
      string,
      Array<{
        id: string;
        title: string;
        order_index: number;
        body_len: number;
        learning_objectives: unknown;
        key_terms: unknown;
        bloom_level: unknown;
        duration_min: unknown;
      }>
    >();
    for (const a of activities ?? []) {
      const uid = a.unity_id as string;
      const body = (a.body as string | null) ?? "";
      const arr = byUnity.get(uid) ?? [];
      arr.push({
        id: a.id as string,
        title: a.title as string,
        order_index: (a.order_index as number) ?? 0,
        body_len: body.length,
        learning_objectives: a.learning_objectives,
        key_terms: a.key_terms,
        bloom_level: a.bloom_level,
        duration_min: a.duration_min,
      });
      byUnity.set(uid, arr);
    }

    return {
      syllabus: {
        id: syllabusRow.id as string,
        title: syllabusRow.title as string,
        description: (syllabusRow.description as string | null) ?? "",
        audience: syllabusRow.audience,
        scope: syllabusRow.scope,
        pedagogy: syllabusRow.pedagogy,
      },
      unities: (unities ?? []).map((u) => ({
        id: u.id as string,
        title: u.title as string,
        order_index: (u.order_index as number) ?? 0,
        outcomes: u.outcomes,
        prerequisites: u.prerequisites,
        activities: byUnity.get(u.id as string) ?? [],
      })),
    };
  }

  // ─── list + tree (powers the manual workspace UI) ──────────────────────────

  /** List all syllabuses, newest first. Powers the `/manual` index page. */
  async listSyllabuses(): Promise<
    Array<{
      id: string;
      title: string;
      description: string;
      thread_id: string | null;
      created_at: string;
    }>
  > {
    const { data, error } = await this.supa.client
      .from("syllabuses")
      .select("id, title, description, thread_id, created_at")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    return (data ?? []) as Array<{
      id: string;
      title: string;
      description: string;
      thread_id: string | null;
      created_at: string;
    }>;
  }

  /**
   * Return the post-merge tree for a syllabus: syllabus row + its
   * unities (renamed chapters), each with its activities (cours body +
   * worksheet jsonb).
   *
   * Powers the `/manual/[syllabusId]` workspace and the `name first,
   * generate second` flow — distinct from `snapshotBySyllabusId()`
   * which still returns the legacy chapters/lessons shape consumed
   * by the existing read-only viewer.
   */
  async treeForSyllabus(syllabusId: string): Promise<{
    syllabus: {
      id: string;
      title: string;
      description: string;
      thread_id: string | null;
    };
    unities: Array<{
      id: string;
      syllabus_id: string;
      title: string;
      order_index: number;
      activities: Array<{
        id: string;
        unity_id: string;
        title: string;
        order_index: number;
        body: string | null;
        worksheet: unknown;
      }>;
    }>;
  }> {
    const syllabus = await this.getSyllabus(syllabusId);

    const { data: unities, error: uErr } = await this.supa.client
      .from("unities")
      .select("id, syllabus_id, title, order_index")
      .eq("syllabus_id", syllabusId)
      .order("order_index", { ascending: true });
    if (uErr) throw uErr;

    const unityIds = (unities ?? []).map((u) => u.id as string);
    const { data: activities, error: aErr } = unityIds.length
      ? await this.supa.client
          .from("activities")
          .select("id, unity_id, title, order_index, body, worksheet")
          .in("unity_id", unityIds)
          .order("order_index", { ascending: true })
      : { data: [], error: null };
    if (aErr) throw aErr;

    const byUnity = new Map<string, Array<(typeof activities)[number]>>();
    for (const a of activities ?? []) {
      const uid = a.unity_id as string;
      const arr = byUnity.get(uid) ?? [];
      arr.push(a);
      byUnity.set(uid, arr);
    }

    return {
      syllabus: {
        id: syllabus.id,
        title: syllabus.title,
        description: syllabus.description,
        thread_id: syllabus.thread_id,
      },
      unities: (unities ?? []).map((u) => ({
        id: u.id as string,
        syllabus_id: u.syllabus_id as string,
        title: u.title as string,
        order_index: (u.order_index as number) ?? 0,
        activities: (byUnity.get(u.id as string) ?? []).map((a) => ({
          id: a.id as string,
          unity_id: a.unity_id as string,
          title: a.title as string,
          order_index: (a.order_index as number) ?? 0,
          body: (a.body as string | null) ?? null,
          worksheet: a.worksheet,
        })),
      })),
    };
  }
}

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { v4 as uuidv4 } from "uuid";
import { SupabaseService } from "../supabase/supabase.service";

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
  constructor(private readonly supa: SupabaseService) {}

  // \u2500\u2500\u2500 syllabuses \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  async createSyllabus(opts: {
    title: string;
    description: string;
    thread_id: string | null;
  }): Promise<{ id: string; title: string; thread_id: string | null }> {
    if (!opts.title?.trim()) {
      throw new BadRequestException("title is required");
    }
    const id = uuidv4();
    // If no thread_id is supplied, we leave the column null and let the
    // ScopedGenerateService allocate a synthetic deep-agent thread when
    // the generate step runs.
    const { error } = await this.supa.client
      .from("syllabuses")
      .insert({
        id,
        title: opts.title.trim(),
        description: opts.description,
        thread_id: opts.thread_id,
      })
      .select("id")
      .single();
    if (error) throw error;
    return { id, title: opts.title.trim(), thread_id: opts.thread_id };
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
    const { error } = await this.supa.client
      .from("unities")
      .insert({
        id,
        syllabus_id: opts.syllabus_id,
        title: opts.title.trim(),
        order_index: opts.order_index,
      })
      .select("id")
      .single();
    if (error) throw error;
    return { id, syllabus_id: opts.syllabus_id, title: opts.title.trim() };
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
    const { error } = await this.supa.client
      .from("activities")
      .insert({
        id,
        unity_id: opts.unity_id,
        title: opts.title.trim(),
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
        lesson_title: opts.title.trim(),
        // Legacy `content` (jsonb worksheet) is non-null with `{}`
        // default \u2014 don't override it.
        body: "",
        worksheet: {},
      })
      .select("id")
      .single();
    if (error) throw error;
    return { id, unity_id: opts.unity_id, title: opts.title.trim() };
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
}

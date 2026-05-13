import { Injectable, Logger } from "@nestjs/common";
import { SupabaseService } from "../supabase/supabase.service";
import type { RunSnapshot } from "@mpfe/shared";

const RUN_COLUMNS =
  "id, thread_id, status, user_message, started_at, finished_at, last_heartbeat, error, created_at";

/**
 * Manages the lifecycle of an `agent_runs` row.
 *
 * In Phase 0 the existing in-request streamer (ChatController)
 * is the executor: it `create()`s a run when a turn starts,
 * `heartbeat()`s while the graph is iterating, and
 * `complete()` / `fail()`s when it returns. The RunWorker
 * concurrently reaps any rows whose heartbeat has gone stale
 * (process crashed mid-stream).
 *
 * Phase 1 (PR #14) will add `enqueue()` for the worker-driven
 * path; the existing methods continue to work unchanged.
 */
@Injectable()
export class RunRecorder {
  private readonly logger = new Logger(RunRecorder.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Create a row in `running` state. Returns the new run row so the
   * caller can emit a typed `run` slice immediately (the chat UI uses
   * this to flip the badge from idle → running before the first node
   * has produced any state).
   * Phase 0: called by ChatController as it starts streaming.
   */
  async create(threadId: string, userMessage: string): Promise<RunSnapshot> {
    const now = new Date().toISOString();
    const { data, error } = await this.supabase.client
      .from("agent_runs")
      .insert({
        thread_id: threadId,
        status: "running",
        user_message: userMessage,
        started_at: now,
        last_heartbeat: now,
      })
      .select(RUN_COLUMNS)
      .single();
    if (error) throw new Error(`agent_runs insert failed: ${error.message}`);
    return data as RunSnapshot;
  }

  /** Read a run row by id. Returns null if missing. */
  async getById(runId: string): Promise<RunSnapshot | null> {
    const { data, error } = await this.supabase.client
      .from("agent_runs")
      .select(RUN_COLUMNS)
      .eq("id", runId)
      .maybeSingle();
    if (error) {
      this.logger.warn(`getById failed for run ${runId}: ${error.message}`);
      return null;
    }
    return (data as RunSnapshot | null) ?? null;
  }

  /**
   * All runs for a thread, oldest first. Used by the `/state` reload path
   * to reconstruct the user side of the chat history when the LangGraph
   * checkpoint no longer carries the full `messages` array (i.e. for
   * completed turns).
   *
   * Excludes runs that ended in failure with no work product so the
   * reconstructed chat doesn't surface dead-air user turns. Specifically
   * keeps `running`, `paused`, and `completed`; drops `failed`. Both the
   * user message and any assistant texts emitted by a failed run are
   * suppressed — `reconstructMessagesFromEvents` only iterates over the
   * runs returned here, so failed-run entries in the `aiByRun` map are
   * silently discarded.
   */
  async listForThread(threadId: string): Promise<RunSnapshot[]> {
    const { data, error } = await this.supabase.client
      .from("agent_runs")
      .select(RUN_COLUMNS)
      .eq("thread_id", threadId)
      .in("status", ["running", "paused", "completed"])
      .order("created_at", { ascending: true });
    if (error) {
      this.logger.warn(`listForThread failed for ${threadId}: ${error.message}`);
      return [];
    }
    return (data as RunSnapshot[] | null) ?? [];
  }

  /**
   * Latest run for a thread (most recent created_at). Used by the
   * /state endpoint so reload can surface server-side lifecycle
   * even when the FE has no live SSE stream open.
   */
  async latestForThread(threadId: string): Promise<RunSnapshot | null> {
    const { data, error } = await this.supabase.client
      .from("agent_runs")
      .select(RUN_COLUMNS)
      .eq("thread_id", threadId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      this.logger.warn(
        `latestForThread failed for ${threadId}: ${error.message}`,
      );
      return null;
    }
    return (data as RunSnapshot | null) ?? null;
  }

  async heartbeat(runId: string): Promise<void> {
    const { error } = await this.supabase.client
      .from("agent_runs")
      .update({ last_heartbeat: new Date().toISOString() })
      .eq("id", runId);
    if (error) {
      this.logger.warn(`heartbeat failed for run ${runId}: ${error.message}`);
    }
  }

  /**
   * Both `complete()` and `fail()` apply a CAS guard on
   * `status='running'`. If a reaper has already flipped the row to
   * `failed` (or another worker completed it), our terminal status
   * write is a no-op rather than overwriting their decision — which
   * would leave inconsistent rows like `status='completed'` together
   * with `error='heartbeat timed out…'`.
   */
  async complete(runId: string): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.supabase.client
      .from("agent_runs")
      .update({
        status: "completed",
        finished_at: now,
        last_heartbeat: now,
        error: null,
      })
      .eq("id", runId)
      .eq("status", "running");
    if (error) {
      this.logger.warn(`complete failed for run ${runId}: ${error.message}`);
    }
  }

  /**
   * Mark a run as `paused`. The supervisor pauses on `ask` actions; the
   * graph state holds an `interrupt_payload` and the next user turn
   * resumes the same thread. The FE uses this status to gate the input
   * (only the answer to the current question is allowed) and to badge
   * the thread accordingly.
   */
  async pause(runId: string): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.supabase.client
      .from("agent_runs")
      .update({
        status: "paused",
        finished_at: now,
        last_heartbeat: now,
        error: null,
      })
      .eq("id", runId)
      .eq("status", "running");
    if (error) {
      this.logger.warn(`pause failed for run ${runId}: ${error.message}`);
    }
  }

  async fail(runId: string, message: string): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.supabase.client
      .from("agent_runs")
      .update({
        status: "failed",
        finished_at: now,
        last_heartbeat: now,
        error: message.slice(0, 2048),
      })
      .eq("id", runId)
      .eq("status", "running");
    if (error) {
      this.logger.warn(`fail failed for run ${runId}: ${error.message}`);
    }
  }
}

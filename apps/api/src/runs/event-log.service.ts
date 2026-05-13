import { Injectable, Logger } from "@nestjs/common";
import { SupabaseService } from "../supabase/supabase.service";

/**
 * Durable, NARROW event log for the agent stream.
 *
 * Originally introduced in shadow mode as a generic mirror of every
 * typed slice the controller emitted. After the live channel migrated
 * to Redis Streams (`RunStream`, see its docstring) and the FE
 * subscribed to the SSE replay endpoint instead of Supabase Realtime,
 * `agent_events` no longer participates in the live path. Today it is
 * read from in exactly two places, both on cold reload:
 *
 *   - `listSubagentRunsForThread` — terminal `subagent_run` snapshots
 *     for the deepagent canvas (not exposed in `state.values.*`).
 *   - `listSubagentToolCallsForThread` — nested tool-call snapshots
 *     for the deepagent canvas (same reason).
 *
 * Plus one defensive fallback for legacy threads:
 *
 *   - `listAssistantTextsForThread` — only fires when
 *     `graph.getMessages()` returns empty, which empirically only
 *     happens on threads that were created with the MemorySaver
 *     fallback (no checkpoint at all). New runs go straight to the
 *     LangGraph checkpoint for messages.
 *
 * Everything else the controller emits is reachable on reload from
 * either the LangGraph checkpoint (`state.values.*`) or the
 * `agent_runs` row, and is therefore Redis-only.
 * `ChatController.DURABLE_EVENT_KINDS` is the source of truth for
 * which kinds still get persisted here.
 *
 * The `agent_events.id` column is BIGSERIAL and is the global cursor
 * any client persists. Per-run `seq` is allocated in-process to keep
 * INSERTs ordering-deterministic without round-tripping. Sufficient
 * for the single-process executor we ship today; a future multi-worker
 * setup would move sequence allocation server-side.
 */
@Injectable()
export class EventLog {
  private readonly logger = new Logger(EventLog.name);
  private readonly seqByRun = new Map<string, number>();

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Eagerly seed the per-run seq counter to 0. Callers MUST invoke
   * this immediately after `RunRecorder.create()` succeeds and before
   * any `append()` for that run. Without it, the first batch of
   * fire-and-forget appends (e.g. the supervisor's first
   * `on_chain_end` emitting `phase` + `interrupt` + `interrupt_history`
   * concurrently) would all enter the cold `await fetchMaxSeq` path,
   * resume with the same base value 0, and race for `seq=1` — only
   * one INSERT survives the unique constraint and the rest are
   * silently swallowed as `event_log append failed` warnings.
   */
  initRun(runId: string): void {
    this.seqByRun.set(runId, 0);
  }

  /**
   * Append an event. Returns the per-run sequence number
   * assigned to it (1-based, contiguous within a run).
   *
   * Errors are logged-and-swallowed: durable-write failures
   * must never break the live SSE stream (Redis is the live channel).
   *
   * Cold path: if the in-memory seq counter is missing for this
   * run (process restart, or the reaper appending a synthetic
   * error event for a crashed run from another process),
   * bootstrap it from `max(seq)` in the database. The hot,
   * collision-free path is the one taken by `ChatController` —
   * which calls `initRun()` *before* any append fires, so the
   * read+compute+set below runs synchronously without any
   * suspension point and concurrent fire-and-forget callers
   * see each other's increments.
   */
  async append(
    threadId: string,
    runId: string,
    kind: string,
    payload: unknown,
  ): Promise<number> {
    let cur = this.seqByRun.get(runId);
    if (cur === undefined) {
      cur = await this.fetchMaxSeq(runId);
    }
    const seq = cur + 1;
    this.seqByRun.set(runId, seq);

    const { error } = await this.supabase.client
      .from("agent_events")
      .insert({
        thread_id: threadId,
        run_id: runId,
        seq,
        kind,
        payload: payload ?? null,
      });

    if (error) {
      this.logger.warn(
        `event_log append failed (run=${runId} kind=${kind} seq=${seq}): ${error.message}`,
      );
    }
    return seq;
  }

  /**
   * Read `max(seq)` for a run from the DB. Returns 0 if there
   * are no prior events (or on lookup failure — the subsequent
   * INSERT will surface a unique-violation if we guessed wrong,
   * which is preferable to blocking the call entirely).
   */
  private async fetchMaxSeq(runId: string): Promise<number> {
    const { data, error } = await this.supabase.client
      .from("agent_events")
      .select("seq")
      .eq("run_id", runId)
      .order("seq", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      this.logger.warn(
        `seq bootstrap lookup failed for run ${runId}: ${error.message}`,
      );
      return 0;
    }
    return data ? (data.seq as number) : 0;
  }

  /** Drop the in-memory seq counter for a finished run. */
  release(runId: string): void {
    this.seqByRun.delete(runId);
  }

  /**
   * List the persisted `assistant_text` events for a thread, in chronological
   * order. Defensive fallback for the `/state` reload path: only fires when
   * `graph.getMessages()` returns empty, which empirically happens only for
   * threads created during a MemorySaver-fallback boot (no checkpoint at
   * all). New runs persist messages exclusively in the LangGraph checkpoint
   * and stop writing `assistant_text` rows here.
   *
   * Returns one row per assistant turn with the run_id and the per-run seq,
   * so the caller can interleave them with the corresponding `agent_runs.user_message`
   * to rebuild a `[human, ai, ai?, human, ai, …]` sequence. Will return an
   * empty array for threads where `assistant_text` was never persisted.
   */
  async listAssistantTextsForThread(
    threadId: string,
  ): Promise<Array<{ run_id: string; seq: number; content: string; created_at: string }>> {
    const { data, error } = await this.supabase.client
      .from("agent_events")
      .select("run_id, seq, payload, created_at")
      .eq("thread_id", threadId)
      .eq("kind", "assistant_text")
      .order("id", { ascending: true });
    if (error) {
      this.logger.warn(
        `listAssistantTextsForThread failed for ${threadId}: ${error.message}`,
      );
      return [];
    }
    return ((data as Array<{ run_id: string; seq: number; payload: unknown; created_at: string }>) ?? []).map((row) => ({
      run_id: row.run_id,
      seq: row.seq,
      content: typeof row.payload === "string" ? row.payload : "",
      created_at: row.created_at,
    }));
  }

  /**
   * List `subagent_run` events for a thread in chronological order.
   * Used by the deepagent canvas's `/state` hydration so the
   * subagent panel re-renders the per-task entries (name + status +
   * description + final output + duration) on tab reload.
   *
   * Returns one row per emit. The same `call_id` will appear twice
   * for completed tasks (running → ok|error); callers should
   * fold-by-`call_id` and keep the latest emit per id.
   */
  async listSubagentRunsForThread(threadId: string): Promise<unknown[]> {
    const { data, error } = await this.supabase.client
      .from("agent_events")
      .select("payload")
      .eq("thread_id", threadId)
      .eq("kind", "subagent_run")
      .order("id", { ascending: true });
    if (error) {
      this.logger.warn(
        `listSubagentRunsForThread failed for ${threadId}: ${error.message}`,
      );
      return [];
    }
    return (
      (data as Array<{ payload: unknown }>) ?? []
    ).map((row) => row.payload);
  }

  /**
   * List `subagent_tool_call` events for a thread in chronological
   * order. Used by the deepagent canvas's `/state` hydration so each
   * SubagentRunRow re-renders the nested tool-call trace (writer's
   * `create_lesson`, researcher's `web_search`, etc.) on tab reload.
   *
   * Returns one row per emit. The same `tool_call_id` will appear
   * twice for completed calls (running → ok|error); callers should
   * fold by `tool_call_id` and keep the latest emit per id.
   */
  async listSubagentToolCallsForThread(threadId: string): Promise<unknown[]> {
    const { data, error } = await this.supabase.client
      .from("agent_events")
      .select("payload")
      .eq("thread_id", threadId)
      .eq("kind", "subagent_tool_call")
      .order("id", { ascending: true });
    if (error) {
      this.logger.warn(
        `listSubagentToolCallsForThread failed for ${threadId}: ${error.message}`,
      );
      return [];
    }
    return (
      (data as Array<{ payload: unknown }>) ?? []
    ).map((row) => row.payload);
  }

  /**
   * True if this process is actively appending to `runId`. Used by
   * RunWorker to skip same-process runs whose heartbeat happens to
   * have lagged: the controller is still streaming, so the run is
   * not actually crashed and reaping would (a) clobber the in-flight
   * status with `failed`, (b) `release()` the seq counter the
   * controller is still using, leading to cold-path races on the
   * next emit.
   */
  hasRun(runId: string): boolean {
    return this.seqByRun.has(runId);
  }
}

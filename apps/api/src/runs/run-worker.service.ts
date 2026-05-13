import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { SupabaseService } from "../supabase/supabase.service";
import { EventLog } from "./event-log.service";
import { RunRecorder } from "./run-recorder.service";
import { RunStream } from "./run-stream.service";

/**
 * Background service that owns crash-recovery semantics for
 * agent runs.
 *
 * Phase 0 responsibility (this PR): the **stale-run reaper**.
 * Any `agent_runs` row in `running` state whose `last_heartbeat`
 * is older than {@link RunWorker.STALE_HEARTBEAT_MS} is marked
 * `failed` with an explanatory error and gets a synthetic
 * `kind='error'` event appended to its log. This is what lets
 * the FE distinguish "still streaming" from "process died".
 *
 * Phase 1 (PR #14) will extend this service to also pick up
 * `queued` rows and drive them through the graph, decoupling
 * execution from any HTTP request. The reaper logic stays as-is.
 */
@Injectable()
export class RunWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RunWorker.name);
  private timer?: NodeJS.Timeout;

  /** Poll interval for the reaper. */
  private static readonly TICK_MS = 5_000;

  /** A run is considered crashed if its heartbeat lags this long. */
  private static readonly STALE_HEARTBEAT_MS = 30_000;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly eventLog: EventLog,
    private readonly runStream: RunStream,
    private readonly runs: RunRecorder,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, RunWorker.TICK_MS);
    this.logger.log(
      `RunWorker started (reaper tick=${RunWorker.TICK_MS}ms, stale>${RunWorker.STALE_HEARTBEAT_MS}ms)`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    try {
      await this.reapStaleRuns();
    } catch (err) {
      this.logger.warn(`reaper tick failed: ${(err as Error).message}`);
    }
  }

  /**
   * Find runs whose heartbeat has lapsed and mark them failed.
   * Emits a final `error` event so any tailing client knows.
   */
  private async reapStaleRuns(): Promise<void> {
    const cutoff = new Date(
      Date.now() - RunWorker.STALE_HEARTBEAT_MS,
    ).toISOString();

    const { data: stale, error: selErr } = await this.supabase.client
      .from("agent_runs")
      .select("id, thread_id")
      .eq("status", "running")
      .lt("last_heartbeat", cutoff);

    if (selErr) {
      this.logger.warn(`reaper select failed: ${selErr.message}`);
      return;
    }
    if (!stale || stale.length === 0) return;

    for (const row of stale as Array<{ id: string; thread_id: string }>) {
      // Same-process safeguard: if this process is still the executor
      // for `row.id` (its seq counter is in EventLog.seqByRun), the run
      // isn't crashed — the controller's emit() is just between
      // heartbeats (e.g. mid-LLM call). Skip; do NOT flip status or
      // release() the counter, both would corrupt the live stream.
      if (this.eventLog.hasRun(row.id)) continue;

      const now = new Date().toISOString();
      // CAS: only flip 'running' → 'failed'. .select() makes the
      // result include the updated row(s) so we can detect the
      // no-match case — PostgREST returns error=null even when
      // the WHERE clause matched zero rows, so checking updErr
      // alone would silently treat a concurrent completion as a
      // successful reap and append a spurious error event.
      const { data: updated, error: updErr } = await this.supabase.client
        .from("agent_runs")
        .update({
          status: "failed",
          finished_at: now,
          last_heartbeat: now,
          error: "heartbeat timed out (process crash suspected)",
        })
        .eq("id", row.id)
        .eq("status", "running")
        .select("id");
      if (updErr) {
        this.logger.warn(`reaper update failed for ${row.id}: ${updErr.message}`);
        continue;
      }
      if (!updated || updated.length === 0) {
        // Status changed between SELECT and UPDATE (run completed
        // or was reaped by another worker). Skip — not our row.
        continue;
      }

      // Synthetic terminal events so reconnecting clients see *why*
      // without having to wait for their XREAD BLOCK to time out.
      // Order matches the chat controller's terminal contract:
      //   run (failed status) → error → finalize (set TTL).
      // Live cross-tab subscribers consume both transports; the FE
      // only renders status from `run` slices, so the row update
      // MUST reach the stream before the `error` marker (which makes
      // `subscribe()` exit).
      try {
        const fresh = await this.runs.getById(row.id);
        if (fresh) {
          await this.runStream.append(row.id, "run", fresh);
        }
      } catch (err) {
        this.logger.warn(
          `reaper getById failed for ${row.id}: ${(err as Error).message}`,
        );
      }
      await this.runStream.append(row.id, "error", {
        message: "heartbeat timed out",
        recoverable: false,
      });
      await this.runStream.finalize(row.id);
      // Postgres shadow log mirror (kept until Redis bakes in prod).
      await this.eventLog.append(row.thread_id, row.id, "error", {
        message: "heartbeat timed out",
        recoverable: false,
      });
      this.eventLog.release(row.id);
      this.logger.warn(`Reaped stale run ${row.id} (thread=${row.thread_id})`);
    }
  }
}

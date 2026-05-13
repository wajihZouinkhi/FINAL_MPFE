import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import Redis from "ioredis";
import { AppConfigService } from "../config/app-config.service";

/**
 * Live event channel for a run, backed by a Redis Stream.
 *
 * One stream per run, keyed `run:<runId>:events`. Each entry holds a
 * single typed slice the chat UI consumes (`phase`, `research_plan`,
 * `todo_plan`, `manifest`, `interrupt`, `interrupt_history`, `run`,
 * `done`, `error`). The same entry shape is used for live fan-out
 * (XREAD BLOCK) and reconnect backfill (XRANGE) — there is no separate
 * "shadow log" anymore; the stream IS both the live channel and the
 * replay log.
 *
 * Why Redis Streams instead of Supabase Realtime + Postgres
 * `agent_events`:
 *  - Cross-tab + reload latency: sub-ms vs 100-300ms of Postgres
 *    logical replication → Realtime fan-out.
 *  - Native per-stream TTL and length cap (`XADD MAXLEN ~ N`,
 *    `EXPIRE` on terminal). No bookkeeping cron needed.
 *  - Multi-API-replica safe: Redis is shared, any replica can serve
 *    replay. The Supabase shadow log was per-process for seq
 *    allocation and never fully concurrency-safe.
 *  - Single source of truth: writers and readers all go through this
 *    one service. The FE no longer needs a separate Realtime channel
 *    + REST backfill dance — one SSE endpoint covers both.
 *
 * Durability: Redis AOF appends every XADD before acking the write.
 * Stream key is set to expire 24h after the run terminates so the
 * replay log is available for the rest of the user's working day.
 * For longer-term cold storage (audit, debugging), use the run row
 * in `agent_runs` (status, error, timing) — granular per-slice
 * history past 24h is intentionally out of scope.
 *
 * Per-run sequence: not allocated here. Redis-assigned entry IDs
 * (`<ms>-<seq>`) are already monotonic-per-stream and globally
 * unique. The FE persists the last seen ID to sessionStorage and
 * passes it back on reconnect; XRANGE handles the rest.
 */
@Injectable()
export class RunStream implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RunStream.name);
  // ioredis follower clients used for blocking XREAD calls. We need a
  // dedicated connection per blocking read because while a connection
  // is parked in BLOCK it cannot be used for any other command. Pool
  // them by signal to release on abort.
  private writer!: Redis;
  // 5 minutes — long enough that idle reconnects don't fan out reads
  // every few seconds, short enough that a graph stuck behind a slow
  // LLM still bumps the connection back into Node-land for cleanup.
  private readonly BLOCK_MS = 5 * 60 * 1000;
  private readonly STREAM_MAXLEN = 5000;
  private readonly TERMINAL_TTL_SEC = 24 * 60 * 60;

  constructor(private readonly cfg: AppConfigService) {}

  async onModuleInit() {
    this.writer = new Redis(this.cfg.redisUrl, { lazyConnect: true });
    await this.writer.connect();
    const pong = await this.writer.ping();
    this.logger.log(`RunStream Redis connected (${pong})`);
  }

  async onModuleDestroy() {
    await this.writer?.quit().catch(() => undefined);
  }

  private streamKey(runId: string) {
    return `run:${runId}:events`;
  }

  /**
   * Append a typed slice to the run's stream. Returns the
   * Redis-assigned entry id (`<ms>-<seq>`) the caller can persist
   * for reconnect resume. Errors are logged-and-swallowed: the live
   * SSE writer in chat.controller is the user-visible source of
   * truth for the active tab; mirroring failures must not break it.
   */
  async append(
    runId: string,
    kind: string,
    payload: unknown,
  ): Promise<string | null> {
    try {
      const id = await this.writer.xadd(
        this.streamKey(runId),
        "MAXLEN",
        "~",
        String(this.STREAM_MAXLEN),
        "*",
        "kind",
        kind,
        "payload",
        JSON.stringify(payload ?? null),
      );
      return id ?? null;
    } catch (err) {
      this.logger.warn(
        `xadd failed (run=${runId} kind=${kind}): ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Mark a run's stream as terminal: set TTL so the replay window
   * eventually evicts. Idempotent — reruns just refresh the
   * expiry. Called after `done` / `error` are appended.
   */
  async finalize(runId: string): Promise<void> {
    try {
      await this.writer.expire(this.streamKey(runId), this.TERMINAL_TTL_SEC);
    } catch (err) {
      this.logger.warn(
        `expire failed for run ${runId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * One-shot backfill from `fromId` (exclusive) to the current end of
   * the stream. Used by the replay SSE endpoint to flush events the
   * client missed while disconnected before switching to BLOCK reads.
   *
   * `fromId="-"` means "from the start of the stream"; `fromId="0"`
   * is also accepted (Redis convention).
   */
  async range(
    runId: string,
    fromId: string,
  ): Promise<Array<{ id: string; kind: string; payload: unknown }>> {
    // XRANGE is inclusive of the bound, so we use `(<id>` to make it
    // strictly-after for everything except the special `-` start.
    const start = fromId === "-" || fromId === "0" ? "-" : `(${fromId}`;
    try {
      const raw = (await this.writer.xrange(
        this.streamKey(runId),
        start,
        "+",
      )) as Array<[string, string[]]>;
      return raw.map(([id, fields]) => decodeEntry(id, fields));
    } catch (err) {
      this.logger.warn(
        `xrange failed for run ${runId}: ${(err as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Async generator that yields stream entries arriving after
   * `fromId`. Uses one dedicated follower connection per call —
   * blocking XREAD parks a connection until either a new entry
   * arrives or BLOCK_MS elapses, so a shared client would
   * serialize all subscribers.
   *
   * The generator returns when:
   *  - the abort signal fires (caller disconnected),
   *  - the stream key is missing (run finalized + TTL elapsed),
   *  - a `done` or `error` entry is yielded (terminal markers).
   *
   * Entries are yielded one at a time so the caller can interleave
   * SSE writes with abort checks.
   */
  async *subscribe(
    runId: string,
    fromId: string,
    signal: AbortSignal,
  ): AsyncGenerator<{ id: string; kind: string; payload: unknown }> {
    const follower = new Redis(this.cfg.redisUrl, { lazyConnect: true });
    try {
      await follower.connect();
      let cursor = fromId === "-" ? "0" : fromId;
      const onAbort = () => follower.disconnect();
      signal.addEventListener("abort", onAbort);
      try {
        while (!signal.aborted) {
          let res: Array<[string, Array<[string, string[]]>]> | null;
          try {
            res = (await follower.xread(
              "BLOCK",
              this.BLOCK_MS,
              "STREAMS",
              this.streamKey(runId),
              cursor,
            )) as Array<[string, Array<[string, string[]]>]> | null;
          } catch (err) {
            if (signal.aborted) return;
            const msg = (err as Error).message;
            // Connection forcibly closed by abort — quiet exit.
            if (/Connection is closed|Stream isn't writeable/.test(msg)) {
              return;
            }
            this.logger.warn(`xread failed for run ${runId}: ${msg}`);
            return;
          }
          if (!res) {
            // BLOCK timed out with no new entries. Loop and re-block.
            continue;
          }
          // res is `[[streamKey, [[id, fields], ...]]]` for one stream.
          const entries = res[0]?.[1] ?? [];
          for (const [id, fields] of entries) {
            if (signal.aborted) return;
            cursor = id;
            const decoded = decodeEntry(id, fields);
            yield decoded;
            if (decoded.kind === "done" || decoded.kind === "error") {
              // Caller will close the response; stop reading either way.
              return;
            }
          }
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    } finally {
      try {
        await follower.quit();
      } catch {
        follower.disconnect();
      }
    }
  }
}

function decodeEntry(
  id: string,
  fields: string[],
): { id: string; kind: string; payload: unknown } {
  // ioredis returns the entry's field/value list as a flat
  // `[k1, v1, k2, v2, ...]` array. We only ever store `kind` and
  // `payload` so this lookup is trivial.
  let kind = "";
  let payloadRaw = "null";
  for (let i = 0; i < fields.length; i += 2) {
    const k = fields[i];
    const v = fields[i + 1] ?? "";
    if (k === "kind") kind = v;
    else if (k === "payload") payloadRaw = v;
  }
  let payload: unknown = null;
  try {
    payload = JSON.parse(payloadRaw);
  } catch {
    payload = payloadRaw;
  }
  return { id, kind, payload };
}

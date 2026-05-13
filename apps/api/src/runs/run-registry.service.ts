import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import Redis from "ioredis";
import { AppConfigService } from "../config/app-config.service";

/**
 * In-process registry of `runId → AbortController` for the runs this
 * API instance is currently executing.
 *
 * Why it exists:
 *   - The agent run is decoupled from the HTTP request that started
 *     it. Closing the browser tab MUST NOT abort the graph; only an
 *     explicit user action (the Stop button → cancel endpoint) does.
 *   - The chat controller used to attach `abort.abort()` to
 *     `req.on("close")` directly, which made every navigation /
 *     reload cancel the live run. Now the controller registers the
 *     AbortController here on run start, calls
 *     {@link RunRegistry.unregister} in `finally`, and tab-close is
 *     no longer wired to abort.
 *   - The cancel endpoint publishes the request over Redis Pub/Sub
 *     and also calls the local registry. Every API replica subscribes
 *     to the same channel, so the instance that owns the run aborts it
 *     even when the Stop request lands elsewhere.
 */
@Injectable()
export class RunRegistry implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RunRegistry.name);
  private readonly active = new Map<string, AbortController>();
  private publisher: Redis | null = null;
  private subscriber: Redis | null = null;
  private ready = false;
  private readonly channel = "run:cancels";

  constructor(private readonly cfg: AppConfigService) {}

  async onModuleInit(): Promise<void> {
    this.publisher = new Redis(this.cfg.redisUrl, { lazyConnect: true });
    this.subscriber = new Redis(this.cfg.redisUrl, { lazyConnect: true });
    try {
      await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
      this.subscriber.on("message", (channel, raw) => {
        if (channel !== this.channel) return;
        const msg = this.decodeCancelMessage(raw);
        if (!msg) return;
        this.cancelLocal(msg.runId, msg.reason);
      });
      await this.subscriber.subscribe(this.channel);
      this.ready = true;
      this.logger.log(`RunRegistry cancel bus subscribed (${this.channel})`);
    } catch (err) {
      this.logger.warn(
        `RunRegistry cancel bus unavailable: ${(err as Error).message}`,
      );
      await this.closeRedis();
    }
  }

  /** Track an in-flight run so Stop / shutdown can abort it. */
  register(runId: string, ctrl: AbortController): void {
    this.active.set(runId, ctrl);
  }

  /** Remove a finished/cancelled run from the registry. Idempotent. */
  unregister(runId: string): void {
    this.active.delete(runId);
  }

  /**
   * Publish a cancel request to every API replica and abort locally if
   * this process owns the run. Returns whether the local process owned
   * it; remote ownership is asynchronous and intentionally not exposed
   * to the caller.
   */
  async cancel(runId: string, reason = "user requested cancel"): Promise<boolean> {
    const local = this.cancelLocal(runId, reason);
    if (this.ready && this.publisher) {
      try {
        await this.publisher.publish(
          this.channel,
          JSON.stringify({ runId, reason }),
        );
      } catch (err) {
        this.logger.warn(
          `publish cancel(${runId}) failed: ${(err as Error).message}`,
        );
      }
    }
    return local;
  }

  private cancelLocal(runId: string, reason: string): boolean {
    const ctrl = this.active.get(runId);
    if (!ctrl) return false;
    try {
      ctrl.abort(reason);
    } catch (err) {
      // AbortController.abort() doesn't normally throw, but the spec
      // permits it to throw on already-aborted controllers in older
      // runtimes. Swallow and report success — the goal is "not
      // running anymore".
      this.logger.warn(
        `abort(${runId}) raised: ${(err as Error).message}`,
      );
    }
    return true;
  }

  private decodeCancelMessage(
    raw: string,
  ): { runId: string; reason: string } | null {
    try {
      const parsed = JSON.parse(raw) as {
        runId?: unknown;
        reason?: unknown;
      };
      if (typeof parsed.runId !== "string" || parsed.runId.length === 0) {
        return null;
      }
      return {
        runId: parsed.runId,
        reason:
          typeof parsed.reason === "string" && parsed.reason.length > 0
            ? parsed.reason
            : "user requested cancel",
      };
    } catch {
      return null;
    }
  }

  /** Best-effort: cancel everything we still own on shutdown. */
  async onModuleDestroy(): Promise<void> {
    if (this.active.size > 0) {
      this.logger.log(
        `Aborting ${this.active.size} in-flight run(s) on shutdown`,
      );
      for (const [runId, ctrl] of this.active.entries()) {
        try {
          ctrl.abort("api shutting down");
        } catch (err) {
          this.logger.warn(
            `shutdown abort(${runId}) raised: ${(err as Error).message}`,
          );
        }
      }
      this.active.clear();
    }
    await this.closeRedis();
  }

  private async closeRedis(): Promise<void> {
    this.ready = false;
    await Promise.all([
      this.subscriber?.quit().catch(() => this.subscriber?.disconnect()),
      this.publisher?.quit().catch(() => this.publisher?.disconnect()),
    ]);
    this.subscriber = null;
    this.publisher = null;
  }
}

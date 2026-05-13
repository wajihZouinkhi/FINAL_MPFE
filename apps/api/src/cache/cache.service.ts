import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import Redis from "ioredis";
import { AppConfigService } from "../config/app-config.service";

/**
 * Thin Redis wrapper for ephemeral LLM artifacts: scraped page text,
 * lesson markdown drafts. NEVER use as a system of record.
 *
 * TTL defaults to 1h — long enough for any single graph run to finish,
 * short enough that abandoned drafts don't accumulate.
 */
@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private redis!: Redis;
  private readonly defaultTtlSec = 60 * 60;

  constructor(private readonly cfg: AppConfigService) {}

  async onModuleInit() {
    this.redis = new Redis(this.cfg.redisUrl, { lazyConnect: true });
    try {
      await this.redis.connect();
      const pong = await this.redis.ping();
      this.logger.log(`Redis connected (${pong})`);
    } catch (err) {
      this.logger.error(`Redis connect failed: ${(err as Error).message}`);
      throw err;
    }
  }

  async onModuleDestroy() {
    await this.redis?.quit().catch(() => undefined);
  }

  async set(key: string, value: string, ttlSec = this.defaultTtlSec) {
    await this.redis.set(key, value, "EX", ttlSec);
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async del(key: string) {
    await this.redis.del(key);
  }
}

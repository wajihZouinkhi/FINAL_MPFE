import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";

const Schema = z.object({
  API_PORT: z.coerce.number().int().positive().default(3001),
  API_CORS_ORIGIN: z.string().url().default("http://localhost:3000"),

  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_DB_URL: z.string().min(1),

  SERPR_API_KEY: z.string().min(1).optional(),
  TAVILY_API_KEY: z.string().min(1).optional(),

  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),

  // When set, the activity-tooled agent connects to the Supabase MCP
  // server over streamable-HTTP at this URL instead of spawning the
  // Python server as a stdio child. Used in production (Railway):
  //   http://${{mcp-supabase.RAILWAY_PRIVATE_DOMAIN}}:${{mcp-supabase.PORT}}/mcp
  // Leave unset for local dev to keep the existing stdio spawn.
  MCP_SUPABASE_URL: z.string().url().optional(),
});

export type AppEnv = z.infer<typeof Schema>;

@Injectable()
export class AppConfigService {
  private readonly env: AppEnv;
  private readonly logger = new Logger(AppConfigService.name);

  constructor() {
    const parsed = Schema.safeParse(process.env);
    if (!parsed.success) {
      this.logger.error(
        "Invalid environment configuration:\n" +
          parsed.error.issues
            .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
            .join("\n"),
      );
      throw new Error("Invalid environment configuration");
    }
    this.env = parsed.data;
  }

  get port() {
    return this.env.API_PORT;
  }
  get corsOrigin() {
    return this.env.API_CORS_ORIGIN;
  }
  get supabaseUrl() {
    return this.env.SUPABASE_URL;
  }
  get supabaseAnonKey() {
    return this.env.SUPABASE_ANON_KEY;
  }
  get supabaseServiceRoleKey() {
    return this.env.SUPABASE_SERVICE_ROLE_KEY;
  }
  get supabaseDbUrl() {
    return this.env.SUPABASE_DB_URL;
  }
  get serperApiKey() {
    return this.env.SERPR_API_KEY;
  }
  get tavilyApiKey() {
    return this.env.TAVILY_API_KEY;
  }
  get redisUrl() {
    return this.env.REDIS_URL;
  }
  get mcpSupabaseUrl() {
    return this.env.MCP_SUPABASE_URL;
  }
}

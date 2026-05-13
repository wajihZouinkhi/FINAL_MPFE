import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z, type ZodTypeAny } from "zod";
import * as path from "node:path";
import { AppConfigService } from "../../config/app-config.service";

// ─── JSON Schema → Zod ───────────────────────────────────────────────
//
// `@langchain/mcp-adapters@0.6.0` constructs each tool with the raw
// JSON Schema returned by the MCP server (`schema: tool.inputSchema`)
// instead of converting it to Zod first. ChatOpenAI's `bindTools`
// reads `schema._def.typeName` to decide between the Zod and JSON
// Schema code paths, and on a raw JSON Schema object that read
// returns `undefined`, throwing `Cannot read properties of undefined
// (reading 'typeName')` before any tool is ever called.
//
// mcp-adapters@1.x converts inputSchema with `json-schema-to-zod`
// internally, but bumping to 1.x requires `@langchain/core@^1.0.0`
// + `@langchain/langgraph@^1.0.0`, which is a much bigger upgrade.
// Until then, we re-wrap every tool returned by the adapter with a
// proper Zod schema so the writer LLM can actually bind them.
//
// We only support the subset of JSON Schema the MPFE MCP server
// emits today (object root with primitive properties + optional
// enums + arrays of primitives). Anything outside that falls back
// to `z.any()`, which is still better than the typeName crash.
function jsonSchemaPropToZod(prop: unknown): ZodTypeAny {
  if (!prop || typeof prop !== "object") return z.any();
  const p = prop as Record<string, unknown>;
  if (Array.isArray(p.enum)) {
    const opts = p.enum.filter((v): v is string => typeof v === "string");
    if (opts.length > 0) {
      return z.enum(opts as [string, ...string[]]);
    }
  }
  switch (p.type) {
    case "string":
      return z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(jsonSchemaPropToZod(p.items));
    case "object":
      return jsonSchemaToZodObject(p);
    default:
      return z.any();
  }
}

function jsonSchemaToZodObject(schema: unknown): ZodTypeAny {
  if (!schema || typeof schema !== "object") return z.object({});
  const s = schema as Record<string, unknown>;
  const props =
    s.properties && typeof s.properties === "object"
      ? (s.properties as Record<string, unknown>)
      : {};
  const required = new Set(
    Array.isArray(s.required)
      ? (s.required as unknown[]).filter(
          (r): r is string => typeof r === "string",
        )
      : [],
  );
  const shape: Record<string, ZodTypeAny> = {};
  for (const [name, child] of Object.entries(props)) {
    const inner = jsonSchemaPropToZod(child);
    let field: ZodTypeAny = inner;
    if (
      child &&
      typeof child === "object" &&
      typeof (child as Record<string, unknown>).description === "string"
    ) {
      field = field.describe(
        (child as Record<string, unknown>).description as string,
      );
    }
    shape[name] = required.has(name) ? field : field.optional();
  }
  return z.object(shape);
}

/**
 * Re-wrap a list of tools coming back from `MultiServerMCPClient.getTools`
 * so each one carries a proper Zod schema. The wrapped tool delegates its
 * `func` (and `invoke`) back to the original adapter tool, so the actual
 * MCP `tools/call` round-trip is unchanged.
 */
interface RawMcpTool {
  name: string;
  description?: string;
  schema: unknown;
  responseFormat?: unknown;
  metadata?: unknown;
  invoke: (input: unknown, config?: unknown) => Promise<unknown>;
}

// Dodge `DynamicStructuredTool`'s 4-generic inference, which sends tsc into
// a TS2589 "Type instantiation is excessively deep" loop the moment we
// try to construct it inline. We only need the runtime behaviour (a tool
// object that ChatOpenAI.bindTools can introspect via `name`, `description`,
// `.schema._def.typeName`, and a `.invoke` / `.func`), not the type-level
// schema inference. This typed alias gives us that.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TOOL_CTOR = DynamicStructuredTool as unknown as new (input: any) => {
  name: string;
};

function wrapMcpToolsWithZodSchema(rawTools: unknown[]): unknown[] {
  const tools = rawTools as RawMcpTool[];
  const out: unknown[] = [];
  for (const tool of tools) {
    const raw = tool.schema;
    // If the adapter ever starts handing back Zod (1.x), keep it as-is.
    const looksLikeZod =
      !!raw &&
      typeof raw === "object" &&
      typeof (raw as { _def?: { typeName?: unknown } })._def?.typeName !==
        "undefined";
    const zodSchema: ZodTypeAny = looksLikeZod
      ? (raw as ZodTypeAny)
      : jsonSchemaToZodObject(raw);
    const wrapped = new TOOL_CTOR({
      name: tool.name,
      description: tool.description ?? "",
      schema: zodSchema,
      responseFormat: tool.responseFormat,
      metadata: tool.metadata,
      func: async (input: unknown, _runManager: unknown, config: unknown) =>
        tool.invoke(input, config ?? undefined),
    });
    out.push(wrapped);
  }
  return out;
}

/**
 * Holds a long-lived MCP client + the tools it exposes.
 *
 * The MPFE Supabase MCP server (`apps/mcp-supabase/`) is spawned as a
 * stdio child process the first time the activity-tooled agent runs in
 * a process, then reused for the lifetime of the API. stdio child
 * processes are cheap (one Python interpreter holding a Supabase REST
 * client) so we don't bother with per-thread isolation; concurrent
 * `tools/call` requests on the same server are multiplexed by JSON-RPC
 * id, which the Python SDK handles natively.
 *
 * The toolless agent intentionally does NOT depend on this service.
 */
@Injectable()
export class McpClientService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(McpClientService.name);
  private client: MultiServerMCPClient | null = null;
  private toolsPromise: Promise<DynamicStructuredTool[]> | null = null;

  // A second, direct SDK client we use ONLY for `callTool` from the
  // server-driven activity path. We can't reuse `MultiServerMCPClient`'s
  // tool-shaped wrapper for that because in 0.6.0 the wrapper collapses
  // an MCP `content` array down to its first item (so when the python
  // server returns N lessons we only ever see lesson 0). This direct
  // client gives us the full `CallToolResult` including `structuredContent`,
  // which is what we actually want.
  private directClient: McpClient | null = null;
  private directReadyPromise: Promise<McpClient> | null = null;

  constructor(private readonly cfg: AppConfigService) {}

  async onModuleInit() {
    // Don't actually connect here — defer to first use so a boot of
    // the API in an environment without `uv` (e.g. a CI image that
    // only runs the toolless agent) doesn't fail. We log the expected
    // transport at boot for sanity.
    const url = this.cfg.mcpSupabaseUrl;
    if (url) {
      this.logger.log(`MCP server (lazy, http): ${url}`);
    } else {
      this.logger.log(
        `MCP server (lazy, stdio): uv run --directory ${this.serverDir()} mpfe-mcp-supabase`,
      );
    }
  }

  async onModuleDestroy() {
    if (this.client) {
      try {
        await this.client.close();
      } catch (err) {
        this.logger.warn(
          `MCP client close failed: ${(err as Error).message}`,
        );
      }
      this.client = null;
      this.toolsPromise = null;
    }
    if (this.directClient) {
      try {
        await this.directClient.close();
      } catch (err) {
        this.logger.warn(
          `MCP direct client close failed: ${(err as Error).message}`,
        );
      }
      this.directClient = null;
      this.directReadyPromise = null;
    }
  }

  /**
   * Call an MCP tool directly via the modelcontextprotocol SDK (NOT
   * through `@langchain/mcp-adapters`) and return the parsed payload.
   *
   * For a tool whose Python signature returns `list[dict]`, fastmcp
   * emits one `TextContent` block per item in `content[]` plus a
   * `structuredContent: {result: [...]}` envelope. We prefer the
   * structured envelope when present (cheapest, single JSON.parse on
   * the server side) and fall back to parsing each text block when
   * not.
   *
   * Used by `ActivityAgentService.generateTooled` to drive MCP from
   * the server with the bound thread_id hard-coded \u2014 the writer LLM
   * never sees the tool list.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await this.directReady();
    const result = await client.callTool({ name, arguments: args });
    if ((result as { isError?: boolean }).isError) {
      const text = this.extractErrorText(result);
      throw new Error(`MCP tool ${name} returned an error: ${text}`);
    }
    const structured = (result as { structuredContent?: unknown }).structuredContent;
    if (structured && typeof structured === "object") {
      const wrapped = (structured as Record<string, unknown>).result;
      // FastMCP wraps array results as `{result: [...]}` and dict results
      // as the dict itself, so prefer `.result` when present and fall
      // back to the structured object as-is.
      return wrapped !== undefined ? wrapped : structured;
    }
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      // Parse each text block as JSON if possible. Mixed-content tools
      // (e.g. an image plus text) aren't currently exposed by the MPFE
      // server, so this branch is only really hit for older fastmcp
      // builds that don't emit `structuredContent`.
      //
      // We always return an array here (even for a single block) so
      // list-returning tools like `list_lessons_for_thread` don't get
      // their result silently collapsed into a bare object when the
      // syllabus happens to have exactly one lesson. Callers that
      // expect a single object handle that case explicitly via
      // `Array.isArray` checks.
      const parsed = content
        .filter((c): c is { type: string; text: string } =>
          !!c &&
          typeof c === "object" &&
          (c as { type?: unknown }).type === "text" &&
          typeof (c as { text?: unknown }).text === "string",
        )
        .map((c) => {
          try {
            return JSON.parse(c.text);
          } catch {
            return c.text;
          }
        });
      return parsed.length === 0 ? null : parsed;
    }
    return null;
  }

  private extractErrorText(result: unknown): string {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const first = content.find(
        (c): c is { type: string; text: string } =>
          !!c &&
          typeof c === "object" &&
          (c as { type?: unknown }).type === "text" &&
          typeof (c as { text?: unknown }).text === "string",
      );
      if (first) return first.text;
    }
    return JSON.stringify(result).slice(0, 400);
  }

  private async directReady(): Promise<McpClient> {
    if (this.directReadyPromise) return this.directReadyPromise;
    this.directReadyPromise = (async () => {
      const url = this.cfg.mcpSupabaseUrl;
      const client = new McpClient(
        { name: "mpfe-api", version: "0.1.0" },
        { capabilities: {} },
      );
      const transport = url
        ? new StreamableHTTPClientTransport(new URL(url))
        : new StdioClientTransport({
            command: "uv",
            args: [
              "run",
              "--directory",
              this.serverDir(),
              "mpfe-mcp-supabase",
            ],
            env: {
              SUPABASE_URL: this.cfg.supabaseUrl,
              SUPABASE_SERVICE_ROLE_KEY: this.cfg.supabaseServiceRoleKey,
              PATH: process.env.PATH ?? "",
            },
          });
      await client.connect(transport);
      this.directClient = client;
      this.logger.log(
        `MCP direct client connected (${url ? "http" : "stdio"})`,
      );
      return client;
    })().catch((err) => {
      this.directReadyPromise = null;
      this.directClient = null;
      throw err;
    });
    return this.directReadyPromise;
  }

  /**
   * Return the LangChain tools exposed by the MPFE Supabase MCP server.
   * First call boots the child process; subsequent calls reuse the
   * cached tool list (the underlying Client is held inside the
   * MultiServerMCPClient).
   */
  async getTools(): Promise<DynamicStructuredTool[]> {
    if (this.toolsPromise) return this.toolsPromise;
    this.toolsPromise = (async () => {
      const url = this.cfg.mcpSupabaseUrl;
      this.client = new MultiServerMCPClient({
        useStandardContentBlocks: true,
        mcpServers: {
          "mpfe-supabase": url
            ? {
                // HTTP (streamable-http) transport — used in production
                // (Railway). `MCP_SUPABASE_URL` resolves to the private
                // domain of the mcp-supabase service, e.g.
                // http://mcp-supabase.railway.internal:8000/mcp.
                transport: "http",
                url,
              }
            : {
                transport: "stdio",
                command: "uv",
                args: [
                  "run",
                  "--directory",
                  this.serverDir(),
                  "mpfe-mcp-supabase",
                ],
                env: {
                  SUPABASE_URL: this.cfg.supabaseUrl,
                  // The MCP server reads the service-role key — bypassing
                  // RLS is fine because this is a server-to-server stdio
                  // pipe inside the API process tree, not a network port.
                  SUPABASE_SERVICE_ROLE_KEY: this.cfg.supabaseServiceRoleKey,
                  // Inherit PATH so `uv` resolves on the spawned shell.
                  PATH: process.env.PATH ?? "",
                },
              },
        },
      });
      const rawTools = await this.client.getTools("mpfe-supabase");
      // The 0.6.0 adapter hands tools back with raw JSON Schema; wrap
      // each one with a proper Zod schema so ChatOpenAI.bindTools can
      // actually consume them. See the comment on
      // `wrapMcpToolsWithZodSchema` above for the full back-story.
      const tools = wrapMcpToolsWithZodSchema(
        rawTools as unknown[],
      ) as DynamicStructuredTool[];
      this.logger.log(
        `MCP tools loaded: ${tools.map((t) => t.name).join(", ")}`,
      );
      return tools;
    })().catch(async (err) => {
      // Reset so the next call retries the spawn — useful when the
      // user has just installed `uv` after seeing the error message.
      // Also close the failed client so we don't leak the spawned
      // child process when the next call creates a fresh client.
      this.toolsPromise = null;
      if (this.client) {
        try {
          await this.client.close();
        } catch {
          // best-effort cleanup; the spawn already failed
        }
        this.client = null;
      }
      throw err;
    });
    return this.toolsPromise;
  }

  /**
   * Return a list of LangChain tools whose `func` is wired to call the
   * MPFE MCP server through `this.callTool` (NOT through
   * `@langchain/mcp-adapters`). This is the only flavour the
   * activity-tooled writer LLM should bind to: the adapter's
   * tool-shaped wrapper collapses MCP `content` arrays down to their
   * first item, which silently truncates `list_lessons_for_thread` to
   * a single lesson regardless of how many the syllabus has. Routing
   * through `callTool` returns the full structured payload instead.
   *
   * Tool metadata (name / description / inputSchema) is read from the
   * direct SDK client's `listTools` so we don't depend on mcp-adapters
   * for this code path at all. Schemas are converted to Zod via the
   * shared helper so ChatOpenAI.bindTools can introspect them.
   */
  async getToolsRoutedThroughCallTool(): Promise<DynamicStructuredTool[]> {
    const client = await this.directReady();
    const list = await client.listTools();
    const out: DynamicStructuredTool[] = [];
    for (const tool of list.tools ?? []) {
      const zodSchema: ZodTypeAny = jsonSchemaToZodObject(tool.inputSchema);
      const wrapped = new TOOL_CTOR({
        name: tool.name,
        description: tool.description ?? "",
        schema: zodSchema,
        func: async (input: unknown) => {
          const args =
            input && typeof input === "object"
              ? (input as Record<string, unknown>)
              : {};
          const result = await this.callTool(tool.name, args);
          // LangChain expects a string from `func`; we serialize here so
          // the tool round-trip surfaces as a ToolMessage with stringified
          // JSON the way bindTools-bound tools normally do.
          if (result === null || result === undefined) return "null";
          if (typeof result === "string") return result;
          return JSON.stringify(result);
        },
      });
      out.push(wrapped as unknown as DynamicStructuredTool);
    }
    this.logger.log(
      `MCP tools (routed) loaded: ${out.map((t) => t.name).join(", ")}`,
    );
    return out;
  }

  /** Absolute path to apps/mcp-supabase. Resolved relative to this file
   * to survive a `pnpm start` from any cwd. */
  private serverDir(): string {
    // __dirname at runtime is dist/graph/activity (compiled) or
    // src/graph/activity (tsx). Both are 4 levels deep relative to
    // the repo root — apps/api/(dist|src)/graph/activity.
    return path.resolve(__dirname, "..", "..", "..", "..", "mcp-supabase");
  }
}

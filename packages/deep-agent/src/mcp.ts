/**
 * MCP client for the deep-agent runner.
 *
 * The api app already has an `McpClientService` that talks to the
 * MPFE Supabase MCP server, but it returns langchain v0.3
 * `DynamicStructuredTool` instances — incompatible with this package's
 * v1 `langchain.tool(...)` factory that `deepagents@1.9` consumes.
 *
 * Rather than crossing the v0.3/v1 langchain boundary, we re-implement
 * the small slice we need here: connect to the MCP server with the
 * vendor-neutral `@modelcontextprotocol/sdk`, list its tools, and wrap
 * each as a v1 `tool(...)` instance that bound subagents can call.
 *
 * Tool routing goes through `Client.callTool` (the direct SDK), not
 * `@langchain/mcp-adapters`, so list-returning tools (e.g.
 * `list_lessons`) preserve their full structured payload — the
 * adapter's content-block flattening would silently truncate them to
 * the first item.
 */
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tool } from "langchain";
import { z, type ZodType } from "zod";

/**
 * Connection options for the MCP server. Either `url` (streamable-http)
 * or `stdio` (spawn a child process) — exactly one must be provided.
 */
export interface DeepAgentMcpConfig {
  /** Streamable-HTTP endpoint, e.g. `http://mcp-supabase.railway.internal:8000/mcp`. */
  url?: string;
  /** Stdio fallback: command to spawn + env to pass through. */
  stdio?: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
}

/** A v1 langchain tool object — opaque to this module's callers. */
// langchain's `tool()` returns `StructuredTool` from `@langchain/core/tools`,
// but exporting that type would force every consumer of this package to
// also depend on `@langchain/core` to satisfy TS — which we deliberately
// avoid (see runner.ts:1-15). The runtime shape is what matters; we only
// pass the value through to `createDeepAgent`.
export type DeepAgentTool = ReturnType<typeof tool>;

/**
 * Connect to the MCP server, enumerate its tools, and return them
 * wrapped as v1 `langchain.tool(...)` instances.
 *
 * Returns `{ tools, byName, close }`:
 *   - `tools`: full array, useful for "give me everything" handouts.
 *   - `byName`: lookup keyed on the MCP tool name, used by the
 *     subagent registry to assemble per-subagent tool sets.
 *   - `close()`: graceful shutdown of the transport. Idempotent;
 *     wired into the runner's `OnModuleDestroy` so the spawned MCP
 *     child process is reaped on api restart.
 *
 * Throws if the MCP server can't be reached. Callers downstream of
 * `createDeepAgentRunner` decide whether to soft-fail and proceed
 * without MCP tools (subagents that need them will be disabled) or
 * hard-fail boot.
 */
export async function buildMcpTools(
  config: DeepAgentMcpConfig,
): Promise<{
  tools: DeepAgentTool[];
  byName: Map<string, DeepAgentTool>;
  close: () => Promise<void>;
}> {
  if (!config.url && !config.stdio) {
    throw new Error(
      "buildMcpTools: exactly one of `url` or `stdio` must be supplied.",
    );
  }
  const client = new McpClient(
    { name: "mpfe-deep-agent", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = config.url
    ? new StreamableHTTPClientTransport(new URL(config.url))
    : new StdioClientTransport(config.stdio!);
  await client.connect(transport);
  const list = await client.listTools();

  const tools: DeepAgentTool[] = [];
  const byName = new Map<string, DeepAgentTool>();
  for (const t of list.tools ?? []) {
    const schema = jsonSchemaToZodObject(t.inputSchema) as ZodType;
    const wrapped = tool(
      async (input: unknown) => {
        const args =
          input && typeof input === "object"
            ? (input as Record<string, unknown>)
            : {};
        const result = await client.callTool({
          name: t.name,
          arguments: args,
        });
        if ((result as { isError?: boolean }).isError) {
          throw new Error(
            `MCP tool ${t.name} returned an error: ${extractErrorText(result)}`,
          );
        }
        return mcpResultToString(result);
      },
      {
        name: t.name,
        description: t.description ?? "",
        schema,
      },
    );
    tools.push(wrapped);
    byName.set(t.name, wrapped);
  }
  return {
    tools,
    byName,
    close: async () => {
      try {
        await client.close();
      } catch {
        // best-effort — onModuleDestroy must not throw.
      }
    },
  };
}

/**
 * Pick a subset of MCP tools by name. Throws when any requested tool
 * is missing — this is what the runner uses to fail fast at boot if
 * the MCP server doesn't expose what a subagent declares it needs
 * (rather than the model getting a "tool not found" surprise mid-run).
 */
export function pickMcpTools(
  byName: Map<string, DeepAgentTool>,
  names: readonly string[],
): DeepAgentTool[] {
  const out: DeepAgentTool[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const t = byName.get(name);
    if (!t) {
      missing.push(name);
      continue;
    }
    out.push(t);
  }
  if (missing.length > 0) {
    throw new Error(
      `MCP server is missing required tools: ${missing.join(", ")}. ` +
        `Available tools: ${[...byName.keys()].join(", ")}.`,
    );
  }
  return out;
}

/* ─── JSON Schema → Zod helpers ───────────────────────────────────── */
//
// Mirrors the helper in apps/api/src/graph/activity/mcp-client.service.ts
// — `langchain.tool()` v1 in this package and `ChatOpenAI.bindTools` v0.3
// in the api both want a real Zod schema (their JSON-Schema code paths
// have known issues with the raw fastmcp inputSchema shape). We
// duplicate the converter here to keep the v0.3/v1 boundary clean.

function jsonSchemaPropToZod(prop: unknown): ZodType {
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

function jsonSchemaToZodObject(schema: unknown): ZodType {
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
  const shape: Record<string, ZodType> = {};
  for (const [name, child] of Object.entries(props)) {
    const inner = jsonSchemaPropToZod(child);
    let field: ZodType = inner;
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

/* ─── MCP result extraction ───────────────────────────────────────── */

/**
 * Convert the raw MCP `tools/call` result into the string the v1
 * `tool(...)` factory expects to return (langchain renders this as a
 * `ToolMessage.content`). Prefers `structuredContent.result` (the
 * fastmcp envelope for typed returns), falls back to JSON-parsing
 * each text content block.
 *
 * Always returns a string — never null — so the supervisor LLM never
 * has to deal with an empty tool message. Tool implementations that
 * legitimately return nothing yield the literal string "null".
 */
function mcpResultToString(result: unknown): string {
  const structured = (result as { structuredContent?: unknown })
    .structuredContent;
  if (structured && typeof structured === "object") {
    const wrapped = (structured as Record<string, unknown>).result;
    const value = wrapped !== undefined ? wrapped : structured;
    if (value === null || value === undefined) return "null";
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  }
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const parsed = content
      .filter(
        (c): c is { type: string; text: string } =>
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
    if (parsed.length === 0) return "null";
    if (parsed.length === 1) {
      const single = parsed[0];
      if (typeof single === "string") return single;
      return JSON.stringify(single);
    }
    return JSON.stringify(parsed);
  }
  return "null";
}

function extractErrorText(result: unknown): string {
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

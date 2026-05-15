/**
 * Backfill pgvector embeddings for activity / unity rows that pre-date
 * the REST embedding-write parity fix (see PR `update_*` tools / embed
 * parity).
 *
 * Until the fix, the REST endpoints `POST /api/activities` and
 * `POST /api/unities` did a direct Supabase INSERT and skipped the
 * embedding upsert that the MCP `create_activity` / `create_unity`
 * tools perform. That left existing rows missing from
 * `activity_embeddings` / `unity_embeddings`, which silently breaks
 * the `find_related_activities` / `find_related_unities` retrieval
 * (it ANN-searches embedding tables, not the source rows).
 *
 * What this script does:
 *   1. Fetch every activity that has NO row in `activity_embeddings`.
 *   2. For each: build the same `title + body + LOs + key_terms`
 *      source the MCP create tool uses, call MCP `embed_text` over
 *      HTTP MCP transport, and INSERT into `activity_embeddings`.
 *   3. Repeat for unities (`title + outcomes + prerequisites`).
 *
 * Run with:
 *   pnpm tsx scripts/backfill-activity-embeddings.ts
 *
 * Required env (loaded from .env at repo root):
 *   SUPABASE_URL                — Supabase project REST endpoint
 *   SUPABASE_SERVICE_ROLE_KEY   — service role key (bypasses RLS)
 *   MCP_SUPABASE_URL            — public MCP HTTP transport URL
 *                                 (e.g. https://.../mcp)
 *
 * Idempotent: rows with an existing embedding are skipped. Re-running
 * the script after partial completion picks up only the remaining
 * rows. Failures on individual rows are logged and the loop
 * continues; the exit status reflects whether ALL rows succeeded.
 */
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: resolve(process.cwd(), ".env") });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MCP_SUPABASE_URL = process.env.MCP_SUPABASE_URL;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !MCP_SUPABASE_URL) {
  console.error(
    "missing required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MCP_SUPABASE_URL",
  );
  process.exit(1);
}

function vectorLiteral(vec: number[]): string {
  return "[" + vec.map((x) => x.toFixed(6)).join(",") + "]";
}

function contentHash(text: string): string {
  return createHash("sha1").update(text || "").digest("hex");
}

/**
 * Minimal streaming-HTTP MCP client tailored to the `embed_text` tool.
 *
 * The official `@modelcontextprotocol/sdk` would be the right choice
 * here, but we already have it as a runtime dep of `apps/api` and
 * pulling it into a standalone tsx script blows up the cold-start
 * cost. The MCP HTTP transport is a thin JSON-RPC envelope over POST
 * + Server-Sent-Events, so we hand-roll it.
 */
async function mcpCall(
  url: string,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
): Promise<{ result: unknown; sessionId: string | null }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method,
      params,
    }),
  });
  const sid = res.headers.get("mcp-session-id");
  const ct = res.headers.get("content-type") || "";
  let body: unknown;
  if (ct.includes("text/event-stream")) {
    // Aggregate SSE 'data:' lines.
    const text = await res.text();
    const dataLines = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter((l) => l && l !== "[DONE]");
    // The response we want is the last non-empty JSON frame.
    if (dataLines.length === 0) {
      throw new Error(`MCP SSE empty: ${text.slice(0, 200)}`);
    }
    body = JSON.parse(dataLines[dataLines.length - 1]);
  } else {
    body = await res.json();
  }
  const env = body as { result?: unknown; error?: { message?: string } };
  if (env.error) {
    throw new Error(`MCP error: ${env.error.message}`);
  }
  return { result: env.result ?? null, sessionId: sid };
}

async function mcpInitialize(url: string): Promise<string> {
  // The MCP HTTP transport requires an `initialize` RPC before the
  // server will accept any tool calls. The session id it returns must
  // be threaded through subsequent requests.
  const { sessionId } = await mcpCall(url, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mpfe-backfill-script", version: "0.1.0" },
  });
  if (!sessionId) {
    throw new Error("MCP did not return an mcp-session-id");
  }
  // FastMCP requires a `notifications/initialized` ping right after
  // `initialize` before tool calls are allowed.
  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }),
  });
  return sessionId;
}

async function embedText(
  url: string,
  sessionId: string,
  text: string,
): Promise<number[]> {
  if (!text || !text.trim()) return new Array<number>(384).fill(0);
  const { result } = await mcpCall(
    url,
    "tools/call",
    { name: "embed_text", arguments: { text } },
    sessionId,
  );
  // FastMCP wraps `list[float]` returns as
  //   { content: [{type:'text', text: '...'}], structuredContent: { result: [...] } }
  const wrapped = result as {
    structuredContent?: { result?: unknown };
    content?: Array<{ type?: string; text?: string }>;
  };
  if (
    wrapped.structuredContent &&
    Array.isArray(wrapped.structuredContent.result)
  ) {
    return (wrapped.structuredContent.result as unknown[]).map((x) =>
      Number(x),
    );
  }
  // Fallback: parse the JSON in the first text content block.
  const txt = wrapped.content?.[0]?.text;
  if (txt) {
    const parsed = JSON.parse(txt);
    if (Array.isArray(parsed)) return parsed.map((x) => Number(x));
    if (Array.isArray(parsed?.result)) {
      return (parsed.result as unknown[]).map((x) => Number(x));
    }
  }
  throw new Error(
    `embed_text returned unexpected shape: ${JSON.stringify(result).slice(0, 200)}`,
  );
}

async function supaSelect<T>(
  path: string,
  query: Record<string, string>,
): Promise<T[]> {
  const qs = new URLSearchParams(query).toString();
  const url = `${SUPABASE_URL}/rest/v1/${path}?${qs}`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    throw new Error(`select ${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T[];
}

async function supaUpsert(
  path: string,
  row: Record<string, unknown>,
  conflictCol: string,
): Promise<void> {
  const url = `${SUPABASE_URL}/rest/v1/${path}?on_conflict=${conflictCol}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    throw new Error(`upsert ${path} failed: ${res.status} ${await res.text()}`);
  }
}

type ActivityRow = {
  id: string;
  title: string;
  body: string | null;
  unity_id: string;
  learning_objectives: unknown;
  key_terms: unknown;
};

type UnityRow = {
  id: string;
  syllabus_id: string;
  title: string;
  outcomes: unknown;
  prerequisites: unknown;
};

async function backfillActivities(mcpUrl: string, sessionId: string): Promise<{
  ok: number;
  fail: number;
}> {
  // Fetch ALL activities; we'll filter client-side against the set of
  // activity_ids that already have an embedding row.
  const acts = await supaSelect<ActivityRow>("activities", {
    select: "id,title,body,unity_id,learning_objectives,key_terms",
  });
  const haveEmb = new Set(
    (
      await supaSelect<{ activity_id: string }>("activity_embeddings", {
        select: "activity_id",
      })
    ).map((r) => r.activity_id),
  );
  const needed = acts.filter((a) => !haveEmb.has(a.id));
  console.log(
    `activities: ${acts.length} total, ${haveEmb.size} embedded, ${needed.length} to backfill`,
  );
  if (needed.length === 0) return { ok: 0, fail: 0 };

  // Bulk-resolve syllabus_id via unity_id.
  const unityIds = Array.from(new Set(needed.map((a) => a.unity_id)));
  const unities = await supaSelect<{ id: string; syllabus_id: string }>(
    "unities",
    { select: "id,syllabus_id", id: `in.(${unityIds.join(",")})` },
  );
  const unityToSyl = new Map(unities.map((u) => [u.id, u.syllabus_id]));

  let ok = 0;
  let fail = 0;
  for (const a of needed) {
    const syllabusId = unityToSyl.get(a.unity_id);
    if (!syllabusId) {
      console.warn(`  [skip] activity ${a.id}: no syllabus_id for unity ${a.unity_id}`);
      fail++;
      continue;
    }
    const loStrs = Array.isArray(a.learning_objectives)
      ? (a.learning_objectives as unknown[]).map((lo) => {
          if (lo && typeof lo === "object" && "text" in (lo as object)) {
            const t = (lo as { text?: unknown }).text;
            return typeof t === "string" ? t : String(lo);
          }
          return String(lo);
        })
      : [];
    const ktStrs = Array.isArray(a.key_terms)
      ? (a.key_terms as unknown[]).map((k) => String(k))
      : [];
    const source = [a.title, a.body || "", loStrs.join(", "), ktStrs.join(", ")]
      .filter((p) => p)
      .join("\n");
    try {
      const vec = await embedText(mcpUrl, sessionId, source);
      await supaUpsert(
        "activity_embeddings",
        {
          activity_id: a.id,
          syllabus_id: syllabusId,
          content_hash: contentHash(source),
          embedding: vectorLiteral(vec),
        },
        "activity_id",
      );
      console.log(`  [ok]   activity ${a.id} (${a.title.slice(0, 40)})`);
      ok++;
    } catch (err) {
      console.error(`  [fail] activity ${a.id}: ${(err as Error).message}`);
      fail++;
    }
  }
  return { ok, fail };
}

async function backfillUnities(mcpUrl: string, sessionId: string): Promise<{
  ok: number;
  fail: number;
}> {
  const unities = await supaSelect<UnityRow>("unities", {
    select: "id,syllabus_id,title,outcomes,prerequisites",
  });
  const haveEmb = new Set(
    (
      await supaSelect<{ unity_id: string }>("unity_embeddings", {
        select: "unity_id",
      })
    ).map((r) => r.unity_id),
  );
  const needed = unities.filter((u) => !haveEmb.has(u.id));
  console.log(
    `unities: ${unities.length} total, ${haveEmb.size} embedded, ${needed.length} to backfill`,
  );
  if (needed.length === 0) return { ok: 0, fail: 0 };

  let ok = 0;
  let fail = 0;
  for (const u of needed) {
    const outcomesStrs = Array.isArray(u.outcomes)
      ? (u.outcomes as unknown[]).map((o) => String(o))
      : [];
    const prereqsStrs = Array.isArray(u.prerequisites)
      ? (u.prerequisites as unknown[]).map((p) => String(p))
      : [];
    const source = [u.title, outcomesStrs.join(", "), prereqsStrs.join(", ")]
      .filter((p) => p)
      .join("\n");
    try {
      const vec = await embedText(mcpUrl, sessionId, source);
      await supaUpsert(
        "unity_embeddings",
        {
          unity_id: u.id,
          syllabus_id: u.syllabus_id,
          content_hash: contentHash(source),
          embedding: vectorLiteral(vec),
        },
        "unity_id",
      );
      console.log(`  [ok]   unity ${u.id} (${u.title.slice(0, 40)})`);
      ok++;
    } catch (err) {
      console.error(`  [fail] unity ${u.id}: ${(err as Error).message}`);
      fail++;
    }
  }
  return { ok, fail };
}

async function main(): Promise<void> {
  console.log(`MCP: ${MCP_SUPABASE_URL}`);
  console.log(`Supabase: ${SUPABASE_URL}`);
  const sessionId = await mcpInitialize(MCP_SUPABASE_URL!);
  console.log(`MCP session: ${sessionId}`);
  const a = await backfillActivities(MCP_SUPABASE_URL!, sessionId);
  const u = await backfillUnities(MCP_SUPABASE_URL!, sessionId);
  console.log(
    `\nsummary: activities ok=${a.ok} fail=${a.fail}, unities ok=${u.ok} fail=${u.fail}`,
  );
  if (a.fail > 0 || u.fail > 0) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

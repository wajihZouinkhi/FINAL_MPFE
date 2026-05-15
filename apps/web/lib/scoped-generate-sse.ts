/**
 * Tiny SSE consumer for the `name first, generate second` REST
 * surface (`POST /api/{syllabuses,unities,activities}/:id/generate`).
 *
 * The endpoints stream `data: <DeepAgentChunk-JSON>\n\n` lines (see
 * `apps/api/src/threads/scoped-generate.service.ts`). This helper
 * connects with `fetch`, reads the body as a stream, parses the SSE
 * frames, and yields each `DeepAgentChunk` to the caller.
 *
 * Why not `EventSource`? Because the API uses a POST endpoint, and
 * `EventSource` only supports GET. We use the standard Fetch
 * Streams API instead — same wire format, more flexibility.
 *
 * Cancellation: pass an `AbortSignal` to abort the underlying fetch.
 * The server hook will see the disconnect and abort its own runner.
 */

/**
 * Wire shape of one streamed chunk. Mirrors `DeepAgentChunk` from
 * `@mpfe/deep-agent/runner.ts` but kept inline so the web bundle
 * doesn't pull in the deepagents package (which transitively imports
 * langchain / langgraph and bloats the FE chunk graph).
 */
export type DeepAgentChunk =
  | { type: "text-delta"; delta: string; source: "supervisor" | "subagent"; subagentName?: string; subagentCallId?: string }
  | { type: "tool-start"; callId: string; name: string; args: unknown; subagentCallId?: string }
  | { type: "tool-end"; callId: string; name: string; output: string; subagentCallId?: string }
  | { type: "task-start"; callId: string; subagentName: string; description: string }
  | { type: "task-end"; callId: string; subagentName: string; output: string; durationMs: number }
  | { type: "files-update"; files: Record<string, string | null>; subagentCallId?: string }
  | { type: "llm-usage"; runId: string; source: "supervisor" | "subagent"; subagentName?: string; subagentCallId?: string; node: string; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null }
  | { type: "done" }
  | { type: "error"; message: string };

export interface StreamGenerateOptions {
  /** Base API URL (e.g. https://api-production-6862.up.railway.app). */
  apiBase: string;
  /** "syllabuses" | "unities" | "activities". */
  scope: "syllabuses" | "unities" | "activities";
  /** Entity id to generate for. */
  entityId: string;
  /** AbortSignal so the caller can cancel the stream. */
  signal?: AbortSignal;
}

/**
 * Async iterable of `DeepAgentChunk`s from one /generate stream.
 * Caller uses `for await (const chunk of streamScopedGenerate({...}))`.
 *
 * Emits a synthetic `{type: "error", message}` chunk on transport
 * errors so the UI doesn't need to wrap the loop in try/catch.
 */
export async function* streamScopedGenerate(
  opts: StreamGenerateOptions,
): AsyncGenerator<DeepAgentChunk, void, void> {
  const url = `${opts.apiBase}/api/${opts.scope}/${opts.entityId}/generate`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Accept: "text/event-stream" },
      signal: opts.signal,
    });
  } catch (err) {
    yield {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    };
    return;
  }
  if (!res.ok || !res.body) {
    yield {
      type: "error",
      message: `HTTP ${res.status} on POST ${url}`,
    };
    return;
  }

  const reader = res.body
    .pipeThrough(new TextDecoderStream())
    .getReader();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      // SSE frames are separated by "\n\n". A frame may contain
      // multiple `field: value` lines but for this endpoint each
      // frame is a single `data:` line.
      let frameEnd = buffer.indexOf("\n\n");
      while (frameEnd !== -1) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);
        frameEnd = buffer.indexOf("\n\n");

        // Each frame line that starts with "data: ". Concatenate
        // them per the spec, though we only ever produce one per
        // frame.
        const dataLines = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart());
        if (dataLines.length === 0) continue;
        const payload = dataLines.join("\n");
        if (payload === "[DONE]") return;
        try {
          yield JSON.parse(payload) as DeepAgentChunk;
        } catch {
          // Skip malformed frames — keep streaming.
        }
      }
    }
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") return;
    yield {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
}

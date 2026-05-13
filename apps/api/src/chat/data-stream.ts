import type { Response } from "express";
import { randomUUID } from "node:crypto";

/**
 * Vercel AI SDK v5 UI Message Stream writer.
 *
 * Spec: https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol#ui-message-stream
 *
 * Wire format is SSE:
 *
 *   data: {"type":"start","messageId":"<id>"}\n\n
 *   data: {"type":"text-start","id":"<text-block-id>"}\n\n
 *   data: {"type":"text-delta","id":"<text-block-id>","delta":"…"}\n\n
 *   …
 *   data: {"type":"text-end","id":"<text-block-id>"}\n\n
 *   data: {"type":"data-<kind>","data":<payload>,"transient":true}\n\n
 *   data: {"type":"finish"}\n\n
 *   data: [DONE]\n\n
 *
 * The writer keeps the public shape compatible with the v4 helper so the
 * controller-side logic (text deltas + typed data parts + error / finish)
 * keeps working without per-call-site changes:
 *
 *  - `text(t)`            auto-opens a text block on first call, then
 *                         emits a `text-delta`. Multiple calls extend
 *                         the same block. Closed at `finish()` time.
 *  - `data({ kind, value, transient })`
 *                         emits a `data-<kind>` part. Transient parts
 *                         only fire `useChat`'s `onData` callback and
 *                         never land in `messages[].parts` — used for
 *                         every typed slice we already store in Zustand
 *                         (phase / research_plan / …) plus the wire's
 *                         `_keepalive` and `_cursor` transport-only
 *                         kinds. The chat pane's `onData` switch routes
 *                         them to the same store setters the v4 demuxer
 *                         used.
 *  - `error(msg)`         emits an `error` chunk.
 *  - `finish({ finishReason })`
 *                         closes the open text block (if any), emits a
 *                         `finish` chunk, then the SSE-terminator
 *                         `[DONE]` line. Idempotent.
 */
export interface DataStreamWriter {
  /**
   * Append a text delta to the current message's text block. Auto-opens
   * a `text-start` on the first call so the controller can keep
   * streaming tokens token-by-token without thinking about block IDs.
   */
  text(t: string): void;
  /**
   * Emit a typed data part. `transient: true` keeps the part out of
   * `messages[].parts` (it's only delivered via `onData`) — the right
   * shape for our 13 typed slices because the FE keeps them in Zustand
   * keyed by `kind`, not in message history.
   */
  data(item: { kind: string; value: unknown; transient?: boolean }): void;
  /** Emit an `error` chunk. Does NOT close the stream. */
  error(message: string): void;
  /** Close the current text block (if any), emit `finish`, then `[DONE]`. */
  finish(opts?: { finishReason?: string }): void;
}

function frame(payload: unknown): string {
  // Vercel AI SDK v5 SSE: `data: <json>\n\n`. JSON-stringify must escape
  // newlines so the SSE payload is exactly one line — no trailing
  // bare LF can sneak past the parser.
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function writeDataStream(
  res: Response,
  opts?: { messageId?: string },
): DataStreamWriter {
  const write = (line: string) => {
    res.write(line);
  };
  const messageId = opts?.messageId ?? randomUUID();
  let textBlockId: string | null = null;
  let finished = false;

  // Lead with the `start` chunk — UseChat opens the assistant message
  // with this id, and v5's `onFinish` reports the same id back so
  // future shadow-mode features can correlate.
  write(frame({ type: "start", messageId }));

  return {
    text(t) {
      if (finished) return;
      if (!t) return;
      if (textBlockId === null) {
        textBlockId = randomUUID();
        write(frame({ type: "text-start", id: textBlockId }));
      }
      write(frame({ type: "text-delta", id: textBlockId, delta: t }));
    },
    data(item) {
      if (finished) return;
      const payload: Record<string, unknown> = {
        type: `data-${item.kind}`,
        data: item.value ?? null,
      };
      if (item.transient) payload.transient = true;
      write(frame(payload));
    },
    error(message) {
      if (finished) return;
      write(frame({ type: "error", errorText: message }));
    },
    finish({ finishReason = "stop" } = {}) {
      if (finished) return;
      finished = true;
      if (textBlockId !== null) {
        write(frame({ type: "text-end", id: textBlockId }));
        textBlockId = null;
      }
      write(frame({ type: "finish", finishReason }));
      // SSE terminator. The v5 client treats `[DONE]` as the only
      // valid signal that the producer has closed — without it, the
      // ReadableStream stays open until the underlying socket dies
      // and `useChat`'s `status` lingers on `'streaming'`.
      write(`data: [DONE]\n\n`);
    },
  };
}

/**
 * Set headers + write the initial body chunks needed to make this
 * response stream incrementally through edge proxies (Railway/Fastly,
 * Nginx, Cloudflare). Without this, the edge buffers `text/event-stream`
 * responses until either the connection closes OR enough bytes
 * accumulate to fill its internal write buffer — symptom: the FE only
 * sees the entire body once the run terminates and the socket is half-
 * closed, which makes "live" cards (`phase`, `research_plan`,
 * `todo_plan`) only appear on page reload.
 *
 * Mitigations applied together (belt + braces):
 *  1. v5 SSE base headers from `UI_MESSAGE_STREAM_HEADERS`:
 *     - `content-type: text/event-stream` so browsers treat the
 *       response as an event stream, not a buffered body.
 *     - `x-vercel-ai-ui-message-stream: v1` is the protocol version
 *       marker the v5 transport asserts on.
 *     - `x-accel-buffering: no` — Nginx convention (also respected
 *       by parts of Railway's edge).
 *  2. `Surrogate-Control: no-store` — the directive Fastly actually
 *     listens to. Railway's edge sits behind Fastly (`x-served-by:
 *     cache-mrs10547-…`, `x-railway-cdn-edge: fastly/…`); a plain
 *     `Cache-Control: no-cache` only stops *browser* caching and lets
 *     Fastly buffer the chunked body until completion. `Surrogate-
 *     Control: no-store` makes Fastly forward bytes uncached.
 *  3. `Cache-Control: private, no-store, no-transform` — defeats every
 *     intermediate proxy cache including any future ones, and prevents
 *     gzip re-encoding which is the other source of "I see one big
 *     chunk at the end" reports.
 *  4. `Vary: *` — defensive: makes the cache key impossible to satisfy
 *     so even a misconfigured CDN can't serve a buffered copy.
 *  5. A ~2 KB padding frame written immediately after `flushHeaders()`.
 *     Some edges only commit a response to streaming mode after they
 *     observe a first chunk above a minimum threshold — sending
 *     padding up front pushes us past that threshold synchronously.
 *     The padding is a transient v5 `data-_keepalive` part, which
 *     useChat's `onData` ignores (chat pane's switch falls through
 *     on unknown kinds) and which never lands in `messages[].parts`
 *     because of the `transient: true` flag.
 */
export function initStreamingResponse(
  res: Response,
  extraHeaders?: Record<string, string>,
): DataStreamWriter {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("x-vercel-ai-ui-message-stream", "v1");
  res.setHeader(
    "Cache-Control",
    "private, no-store, no-cache, no-transform, max-age=0",
  );
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Vary", "*");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  }
  res.flushHeaders?.();
  const writer = writeDataStream(res);
  // Padding frame — useChat's `onData` ignores `_keepalive` and the
  // `transient: true` flag keeps it out of `messages[].parts`.
  writer.data({
    kind: "_keepalive",
    value: "x".repeat(2048),
    transient: true,
  });
  return writer;
}

/**
 * Start a periodic keepalive that writes a tiny `_keepalive` data part
 * onto the stream every `intervalMs`. Critical for HTTP/2 edges
 * (Railway, Cloudflare, Fastly) which kill streams idle for 60–100s —
 * a long LLM call (supervisor.decide, summarizer, writer.invoke) plus
 * a 5-minute Redis `XREAD BLOCK` produce exactly that idle window and
 * trigger `ERR_HTTP2_PROTOCOL_ERROR` / `ERR_CONNECTION_RESET` on the
 * browser side. The frames are emitted as transient v5 data parts so
 * they only surface via `onData` (which ignores `_keepalive`) and
 * never pollute `messages[].parts`.
 *
 * Returns a cleanup function the caller MUST invoke in `finally` to
 * stop the timer. The `isClosed` predicate skips writes after the
 * client has disconnected (Express `res.write` is a no-op then but
 * we want to avoid wasted work and accurate chunker accounting).
 */
export function startKeepalive(
  writer: DataStreamWriter,
  isClosed: () => boolean,
  intervalMs = 20_000,
): () => void {
  const timer = setInterval(() => {
    if (isClosed()) return;
    try {
      writer.data({ kind: "_keepalive", value: ".", transient: true });
    } catch {
      // Socket may have closed between the `isClosed` check and the
      // write. Best-effort.
    }
  }, intervalMs);
  // Don't keep the event loop alive just for keepalives.
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

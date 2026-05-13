/**
 * Per-node token pacer for the chat SSE stream.
 *
 * Why this exists
 * ---------------
 * Modern LLM providers can emit a full short reply (~50–300 chars) in
 * 100–200 ms. Combined with React batching and the 200 ms `animate-fade-in`
 * on `<MessageRow>`, the whole bubble fades in as the last token lands —
 * which the user perceives as "the response just appeared all at once",
 * even though deltas truly arrived progressively. Long replies don't have
 * this problem because they take seconds to complete; the bug is purely
 * perceptual on short bursts.
 *
 * The fix is to enforce a minimum gap between successive `text-delta`
 * frames. If the LLM is naturally slower than that gap (e.g. a heavy
 * model emitting 30 tok/s), the pacer is effectively a no-op. If the
 * LLM bursts (Groq / Gemini-Flash returning a paragraph in 100 ms),
 * the pacer spreads the burst over time at one-word-per-tick cadence,
 * making typing visible.
 *
 * Properties
 * ----------
 *   - **Per-node buffering**: the supervisor + activity-decide nodes get
 *     independent pacers, so a multi-bubble run (supervisor → search →
 *     supervisor again) doesn't interleave words across nodes.
 *   - **Word-boundary chunks**: emits up to and including the first
 *     whitespace per tick. Avoids splitting mid-word, which feels jittery.
 *   - **Pass-through when slow**: if the time since the last emit already
 *     exceeds `minIntervalMs`, the next push emits immediately. No added
 *     latency for naturally-slow LLMs.
 *   - **Smooth drain**: callers should await `drainSmooth(node)` on the
 *     node's `on_chain_end` and `drainAllSmooth()` on `finish` / `error`.
 *     The pacer never holds tokens past those boundaries, but the tail is
 *     still emitted at typing cadence instead of one giant final delta.
 *   - **No event loop pinning**: timers are `unref()`'d so an idle pacer
 *     doesn't keep a Node process alive past its expected lifetime.
 *   - **Mirror-aware**: the emit callback is given the full chunk for
 *     a single emission, so callers can route the same chunk to BOTH
 *     the v5 wire (`writer.text`) AND the Redis shadow log
 *     (`emitDelta("assistant_text_delta", …)`) atomically. Followers
 *     therefore see the same paced cadence the driver tab does.
 *
 * Tuning
 * ------
 * `minIntervalMs` defaults to 30 ms, configurable via the
 * `MPFE_SMOOTH_STREAM_INTERVAL_MS` env var. Picked empirically:
 *  - 20 ms feels almost identical to no pacer for fast LLMs.
 *  - 30 ms is the sweet spot — short replies (~10 words) take ~300 ms
 *    instead of <100 ms, which is enough to feel like typing.
 *  - 50 ms+ is noticeably slow on long replies (~250 words taking 12+ s).
 *
 * Setting `MPFE_SMOOTH_STREAM_INTERVAL_MS=0` disables the pacer entirely
 * (every push is emitted synchronously) — useful if a future change
 * needs to bypass it without code edits.
 */
export class TokenPacer {
  private readonly buffers = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly lastEmitAt = new Map<string, number>();
  private disposed = false;

  constructor(
    private readonly emit: (node: string, chunk: string) => void,
    private readonly minIntervalMs: number = 30,
    private readonly maxChunkChars: number = 96,
  ) {}

  /**
   * Queue a token for the given node. If the time since the last emit
   * already exceeds `minIntervalMs`, the token (plus anything already
   * buffered) is emitted immediately and the pacer goes idle. Otherwise
   * a flush is scheduled `minIntervalMs - (now - lastEmit)` ms later.
   */
  push(node: string, token: string): void {
    if (this.disposed) return;
    if (!token) return;
    const prev = this.buffers.get(node) ?? "";
    this.buffers.set(node, prev + token);

    // Pacer disabled — emit synchronously every push.
    if (this.minIntervalMs <= 0) {
      this.flushAll(node);
      return;
    }

    if (this.timers.has(node)) return; // a flush is already scheduled
    const last = this.lastEmitAt.get(node) ?? 0;
    const now = Date.now();
    const wait = Math.max(0, last + this.minIntervalMs - now);
    if (wait === 0) {
      this.flushOneWord(node);
      return;
    }
    this.scheduleFlush(node, wait);
  }

  /**
   * Synchronously emit every buffered character for the given node and
   * cancel any pending timer. Keep this for emergency teardown paths;
   * normal node boundaries should use `drainSmooth`.
   */
  drain(node: string): void {
    this.clearTimer(node);
    const buf = this.buffers.get(node);
    if (buf) {
      this.buffers.delete(node);
      this.lastEmitAt.set(node, Date.now());
      this.emit(node, buf);
    }
  }

  /**
   * Emit the remaining buffer at the same word-per-tick cadence as
   * normal streaming. Used at node boundaries so the tail doesn't land
   * as one giant `text-delta` immediately before phase/finish frames.
   */
  async drainSmooth(node: string): Promise<void> {
    this.clearTimer(node);
    if (this.minIntervalMs <= 0) {
      this.drain(node);
      return;
    }
    while (!this.disposed && this.buffers.has(node)) {
      this.clearTimer(node);
      const last = this.lastEmitAt.get(node) ?? 0;
      const wait = Math.max(0, last + this.minIntervalMs - Date.now());
      if (wait > 0) await sleep(wait);
      this.flushOneWord(node, false);
    }
  }

  /**
   * Drain every node synchronously. Prefer `drainAllSmooth` before
   * normal terminal frames so no large tail delta is emitted.
   */
  drainAll(): void {
    const nodes = Array.from(this.buffers.keys());
    for (const node of nodes) this.drain(node);
  }

  async drainAllSmooth(): Promise<void> {
    const nodes = Array.from(this.buffers.keys());
    for (const node of nodes) await this.drainSmooth(node);
  }

  /**
   * Permanently disable the pacer. After this, `push` becomes a no-op
   * and any pending timers are cleared. Used to make the pacer safe
   * to leave attached past the request lifecycle without leaking a
   * timer if the controller forgets to drain.
   */
  dispose(): void {
    this.disposed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.buffers.clear();
  }

  // ------------- internal -------------

  private scheduleFlush(node: string, waitMs: number): void {
    const t = setTimeout(() => {
      this.timers.delete(node);
      this.flushOneWord(node);
    }, waitMs);
    // Don't keep the event loop alive just for pacer ticks.
    if (typeof t.unref === "function") t.unref();
    this.timers.set(node, t);
  }

  private clearTimer(node: string): void {
    const t = this.timers.get(node);
    if (t) {
      clearTimeout(t);
      this.timers.delete(node);
    }
  }

  /**
   * Emit one word (or a bounded slice if no whitespace) and re-arm a
   * follow-up timer if there's anything left.
   */
  private flushOneWord(node: string, scheduleNext = true): void {
    const buf = this.buffers.get(node);
    if (!buf) return;
    const wordEnd = findChunkEnd(buf, this.maxChunkChars);
    const head = wordEnd === -1 ? buf : buf.slice(0, wordEnd);
    const tail = wordEnd === -1 ? "" : buf.slice(wordEnd);
    if (tail) {
      this.buffers.set(node, tail);
      if (scheduleNext) this.scheduleFlush(node, this.minIntervalMs);
    } else {
      this.buffers.delete(node);
    }
    this.lastEmitAt.set(node, Date.now());
    this.emit(node, head);
  }

  /** Synchronous drain of a single node's buffer. Used in pass-through mode. */
  private flushAll(node: string): void {
    const buf = this.buffers.get(node);
    if (!buf) return;
    this.buffers.delete(node);
    this.lastEmitAt.set(node, Date.now());
    this.emit(node, buf);
  }
}

/**
 * Returns the index AFTER the first run of word-then-whitespace in `s`,
 * or -1 if the buffer doesn't yet contain a complete word boundary.
 *
 * "Word boundary" = a single space, newline, or tab. Other punctuation
 * isn't treated as a word end on its own — `"hello,"` should emit as
 * one chunk, not split before the comma. Multi-byte sequences (emoji,
 * non-Latin) are passed through transparently because we never split
 * inside a code-unit boundary.
 */
function findWordEnd(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === " " || c === "\n" || c === "\t") return i + 1;
  }
  return -1;
}

function findChunkEnd(s: string, maxChunkChars: number): number {
  const wordEnd = findWordEnd(s);
  if (wordEnd !== -1) return wordEnd;
  if (maxChunkChars > 0 && s.length > maxChunkChars) return maxChunkChars;
  return -1;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Read the smoothing interval from the environment, with a 30 ms
 * default. Set `MPFE_SMOOTH_STREAM_INTERVAL_MS=0` to disable.
 */
export function pacerIntervalFromEnv(): number {
  const raw = process.env.MPFE_SMOOTH_STREAM_INTERVAL_MS;
  if (raw == null) return 30;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 30;
  return Math.floor(n);
}

import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { dispatchLlmUsage } from "./llm-usage-event";
import type { Runnable } from "@langchain/core/runnables";

/**
 * Walks a streaming JSON buffer character-by-character and yields the
 * value of a single string field (e.g. `user_message`) as it arrives.
 * The supervisor / activity classifiers force `response_format=json_object`,
 * so the LLM produces a JSON envelope wrapping a routing decision plus
 * one human-readable string. Without this extractor the whole envelope
 * has to land before the FE sees any text — that's the 10–30s of dead
 * air visible in the chat pane today.
 *
 * Implementation notes:
 *  - Stateful across `feed()` calls; no requirement that field bytes
 *    arrive in any particular chunk boundary.
 *  - Handles standard JSON string escapes (`\"`, `\\`, `\/`, `\n`, `\t`,
 *    `\r`, `\b`, `\f`, `\uXXXX`) including a `\u` escape that spans
 *    chunk boundaries.
 *  - Surrogate pairs (\uD83D\uDE00 etc.) emit each half independently;
 *    the FE concatenates the wire-text frames so the resulting JS string
 *    is identical to what the LLM produced.
 *  - The pre-key buffer is capped at ~512 chars so a long preamble (e.g.
 *    other JSON fields preceding `user_message`) can't cause unbounded
 *    growth; we keep the trailing 256 chars so the field key can still
 *    match across the cap.
 */
export class PartialJsonFieldExtractor {
  private state: "find_key" | "in_value" | "done" = "find_key";
  private prefix = "";
  private pendingEscape = false;
  // `null` ⇒ not currently mid-`\uXXXX`. Empty string ⇒ inside a `\u`
  // escape with zero hex digits collected yet (the chunk ended right
  // after `\u`). Disambiguating these two states with a sentinel is
  // load-bearing — when `pendingEscape=true` and `uEscapeBuf=""` it
  // would otherwise be impossible to tell whether the next char is the
  // escape selector (`n`, `t`, `u`, …) or the first hex digit of an
  // already-selected `\u` escape.
  private uEscapeBuf: string | null = null;
  private readonly keyRegex: RegExp;

  constructor(field: string) {
    // Whitespace-tolerant lookup of `"<field>" \s* : \s* "` inside the
    // pre-key buffer. The closing quote of the value is detected
    // separately in consumeValue.
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    this.keyRegex = new RegExp(`"${escaped}"\\s*:\\s*"`);
  }

  /**
   * Feed a streaming chunk; return the freshly-extracted characters of
   * the target field's value (may be empty if the key hasn't been seen
   * yet, or if all chunk bytes were structural).
   */
  feed(chunk: string): string {
    if (this.state === "done" || chunk.length === 0) return "";
    if (this.state === "find_key") {
      this.prefix += chunk;
      const m = this.prefix.match(this.keyRegex);
      if (!m) {
        // Bound prefix growth on long preambles. Keep enough trailing
        // bytes that the field key itself can still match if it lands
        // straddling the cap.
        if (this.prefix.length > 512) {
          this.prefix = this.prefix.slice(-256);
        }
        return "";
      }
      this.state = "in_value";
      const after = this.prefix.slice((m.index ?? 0) + m[0].length);
      this.prefix = "";
      return this.consumeValue(after);
    }
    return this.consumeValue(chunk);
  }

  isDone(): boolean {
    return this.state === "done";
  }

  private consumeValue(s: string): string {
    let out = "";
    let i = 0;
    while (i < s.length) {
      // Resume an in-progress \uXXXX escape that ran out of bytes on a
      // previous feed() — drain available hex digits before falling
      // through to ordinary processing. `uEscapeBuf !== null` covers
      // both the "some hex collected" and the "zero hex collected"
      // (chunk ended right after `\u`) variants; the prior length-only
      // check missed the zero-hex case and dumped the next chunk's
      // hex digits as literal text.
      if (this.pendingEscape && this.uEscapeBuf !== null) {
        while (i < s.length && this.uEscapeBuf.length < 4) {
          this.uEscapeBuf += s[i++];
        }
        if (this.uEscapeBuf.length < 4) return out;
        const code = parseInt(this.uEscapeBuf, 16);
        if (!Number.isNaN(code)) out += String.fromCharCode(code);
        this.uEscapeBuf = null;
        this.pendingEscape = false;
        continue;
      }

      const c = s[i++];
      if (this.pendingEscape) {
        if (c === '"') out += '"';
        else if (c === "\\") out += "\\";
        else if (c === "/") out += "/";
        else if (c === "n") out += "\n";
        else if (c === "t") out += "\t";
        else if (c === "r") out += "\r";
        else if (c === "b") out += "\b";
        else if (c === "f") out += "\f";
        else if (c === "u") {
          this.uEscapeBuf = "";
          while (i < s.length && this.uEscapeBuf.length < 4) {
            this.uEscapeBuf += s[i++];
          }
          if (this.uEscapeBuf.length === 4) {
            const code = parseInt(this.uEscapeBuf, 16);
            if (!Number.isNaN(code)) out += String.fromCharCode(code);
            this.uEscapeBuf = null;
            this.pendingEscape = false;
          } else {
            // Incomplete; preserve pendingEscape + uEscapeBuf for next
            // feed. uEscapeBuf may be "" here (chunk ended right after
            // `\u`) — the resume block at the top of the loop relies
            // on `uEscapeBuf !== null` to detect this state.
            return out;
          }
          continue;
        } else {
          // Unknown escape — emit the literal character to keep the
          // user-visible text as faithful as possible.
          out += c;
        }
        this.pendingEscape = false;
      } else if (c === "\\") {
        this.pendingEscape = true;
      } else if (c === '"') {
        this.state = "done";
        return out;
      } else {
        out += c;
      }
    }
    return out;
  }
}

/**
 * Drive an LLM via `.stream()` and dispatch one `assistant_text_token`
 * custom event per batch of newly-extracted characters from `field`.
 * Returns the full accumulated raw response so the caller can run its
 * existing schema parse over the complete envelope.
 *
 * `node` is the LangGraph node name (`supervisor` for syllabus-generator,
 * `decide` for activity agents). The chat controller correlates the
 * streamed tokens with the eventual `on_chain_end` of that node so the
 * persistence + replay paths stay unchanged — only the wire emission
 * shifts from a post-completion `streamChunked` to live token frames.
 *
 * Failures of `dispatchCustomEvent` are swallowed (best-effort wire
 * emission); the caller is unaffected and the post-stream parse path
 * still produces a correct AIMessage either way.
 */
export async function streamLlmAndExtractField(
  llm: Runnable<BaseMessage[], AIMessageChunk>,
  messages: BaseMessage[],
  options: {
    field: string;
    node: string;
    tier?: string | null;
    model?: string | null;
  },
): Promise<string> {
  const extractor = new PartialJsonFieldExtractor(options.field);
  let buffer = "";
  // Track the accumulated AIMessageChunk so we can read its
  // `usage_metadata` after the stream closes and dispatch a
  // per-call `llm_usage` event for the eval CLI.
  let combined: AIMessageChunk | undefined;
  const stream = await llm.stream(messages);
  for await (const chunk of stream) {
    combined = combined ? combined.concat(chunk) : chunk;
    const piece = typeof chunk.content === "string" ? chunk.content : "";
    if (!piece) continue;
    buffer += piece;
    const emitted = extractor.feed(piece);
    if (emitted) {
      try {
        await dispatchCustomEvent("assistant_text_token", {
          token: emitted,
          node: options.node,
        });
      } catch {
        // Wire failure is non-fatal — the eventual on_chain_end
        // emission still flushes the full text via the existing
        // streamChunked fallback path.
      }
    }
  }
  await dispatchLlmUsage(combined, {
    node: options.node,
    tier: options.tier ?? null,
    model: options.model ?? null,
  });
  return buffer;
}

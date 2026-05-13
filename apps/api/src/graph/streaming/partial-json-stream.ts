import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import type { Runnable } from "@langchain/core/runnables";
import { JSONParser } from "@streamparser/json";
import { PartialJsonFieldExtractor } from "./partial-json-field";
import { dispatchLlmUsage } from "./llm-usage-event";

/**
 * One callback per registered path. `indices` carries the wildcard
 * captures (numeric for `*` over arrays, string for `*` over object
 * keys) in the order they appear in the pattern, so the handler can
 * pin its emit to a stable id (e.g. `s${indices[0]}`).
 *
 * `value` is the parsed JSON value at the matched node — primitive,
 * array, or object — at the moment the closing token landed. It is
 * NEVER mutated by the parser afterwards (we run with `keepStack:false`
 * so completed nodes aren't accumulated into their parents anyway).
 *
 * Handlers run inside the LLM stream loop and are awaited; throwing or
 * rejecting will surface to the caller and abort the stream. Wrap your
 * own logic in try/catch if best-effort emit semantics are desired.
 */
export type StructuredPathHandler = (
  value: unknown,
  indices: (string | number)[],
) => void | Promise<void>;

export interface StructuredPathSubscription {
  /**
   * Path pattern, e.g. `topics.*`, `chapters.*.title`,
   * `chapters.*.lessons.*`, `defaults`. Use `*` to match any array
   * index or object key. Patterns are translated 1:1 to
   * `@streamparser/json`'s `paths` syntax (`$.topics.*` etc.).
   */
  path: string;
  handler: StructuredPathHandler;
}

export interface StructureStreamOptions {
  /**
   * Single string field to forward as live `assistant_text_token`
   * custom events while the LLM streams (e.g. `user_message` for the
   * supervisor, `reply` for the activity cold-start). Optional — pass
   * an empty/undefined value to skip live text streaming entirely.
   */
  textField?: string;
  /**
   * LangGraph node name attached to dispatched `assistant_text_token`
   * events. Required when `textField` is set; ignored otherwise.
   */
  node: string;
  /**
   * Optional `LlmConfigService` tier name attached to the per-call
   * `llm_usage` event so the eval CLI can attribute cost per tier.
   */
  tier?: string | null;
  /**
   * Optional wire model id attached to the per-call `llm_usage`
   * event for cross-checking against provider invoices.
   */
  model?: string | null;
  /**
   * Path subscriptions. Each callback fires once when its path
   * completes (the closing brace / quote / bracket has landed in the
   * stream). Wildcards capture the matching indices/keys in order.
   */
  paths?: StructuredPathSubscription[];
}

/**
 * Drive an LLM via `.stream()` and dual-tap the partial JSON buffer:
 *
 *  1. The single user-visible string field (if `textField` is set) is
 *     extracted live via the existing `PartialJsonFieldExtractor` and
 *     dispatched as `assistant_text_token` custom events. Same wire
 *     contract as `streamLlmAndExtractField` — the chat controller
 *     pipes those tokens straight into Vercel AI SDK v5 text frames.
 *
 *  2. Every registered structured path is fed into a `@streamparser/json`
 *     parser configured with `paths` so it only allocates / emits for
 *     the nodes the caller cares about. As each path completes, the
 *     handler runs with the parsed value plus captured wildcard
 *     indices, letting the caller dispatch draft slices for
 *     `research_plan` / `todo_plan` / `interrupt` etc. before the
 *     final envelope lands.
 *
 * Returns the full accumulated raw response so the caller can run its
 * existing schema parse over the complete envelope. Routing remains
 * deterministic and unchanged — the structured emits are pure visual
 * sugar that the eventual `on_chain_end` snapshot replaces wholesale
 * via the controller's `emit()` dedupe.
 */
export async function streamLlmAndExtractStructure(
  llm: Runnable<BaseMessage[], AIMessageChunk>,
  messages: BaseMessage[],
  options: StructureStreamOptions,
): Promise<string> {
  const textExtractor = options.textField
    ? new PartialJsonFieldExtractor(options.textField)
    : null;

  const subs = options.paths ?? [];
  const matchers = subs.map((s) => buildPathMatcher(s.path));
  const parserPaths = subs.map((s) => toStreamparserPath(s.path));

  // The parser is best-effort: `@streamparser/json` is strict and will
  // throw on partial chunks that aren't yet valid JSON tail-parses, but
  // because we only feed it bytes the LLM has already emitted (in
  // order) it sees a single growing prefix of a well-formed object.
  // Errors here are non-fatal — drafts disappear, the post-stream
  // schema parse on the buffered text still runs, and the eventual
  // `on_chain_end` slice fills in the UI.
  let parser: JSONParser | null = null;
  let parserDead = false;
  if (subs.length > 0) {
    parser = new JSONParser({
      paths: parserPaths,
      keepStack: false,
      // We only care about completed nodes. Partial primitive values
      // (mid-string deltas) flow through the textField path above.
      emitPartialValues: false,
    });
    parser.onValue = ({ stack, key, value }) => {
      // `stack` is the chain from the root down to the parent; `key`
      // is the final segment. Concatenate to get the full path keys.
      const pathKeys: (string | number)[] = [];
      for (const el of stack) {
        if (el.key !== undefined) pathKeys.push(el.key);
      }
      if (key !== undefined) pathKeys.push(key);
      // The first stack entry has `key: undefined` (the root), which
      // we drop above. `pathKeys` now matches the user-supplied
      // pattern exactly when wildcards are expanded.
      for (let i = 0; i < subs.length; i++) {
        const captured = matchers[i](pathKeys);
        if (captured !== null) {
          // Fire-and-forget: handlers can be async but we don't await
          // here to avoid blocking the parser's synchronous write
          // loop. They're driven by `dispatchCustomEvent` under the
          // hood which is itself fire-and-forget (the transport is
          // the LangGraph callback bus). Any thrown error surfaces
          // through `parser.onError` below.
          try {
            const r = subs[i].handler(value, captured);
            if (r && typeof (r as Promise<void>).then === "function") {
              (r as Promise<void>).catch(() => {
                /* best-effort */
              });
            }
          } catch {
            /* best-effort */
          }
        }
      }
    };
    parser.onError = () => {
      // A malformed prefix poisons the parser permanently — ignore
      // further writes. The buffered text is still returned to the
      // caller for normal Zod parsing.
      parserDead = true;
    };
  }

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

    if (textExtractor && !textExtractor.isDone()) {
      const emitted = textExtractor.feed(piece);
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

    if (parser && !parserDead) {
      try {
        parser.write(piece);
      } catch {
        parserDead = true;
      }
    }
  }
  await dispatchLlmUsage(combined, {
    node: options.node,
    tier: options.tier ?? null,
    model: options.model ?? null,
  });
  if (parser && !parserDead) {
    try {
      parser.end();
    } catch {
      /* parser already saw end-of-stream errors; non-fatal */
    }
  }
  return buffer;
}

/**
 * Translate our compact `topics.*` / `chapters.*.lessons.*` syntax
 * into `@streamparser/json`'s JSONPath-ish form (`$.topics.*` etc.).
 * A bare `*` segment matches any array index or object key.
 */
function toStreamparserPath(pattern: string): string {
  return `$.${pattern}`;
}

/**
 * Compile a path pattern into a matcher that returns the captured
 * wildcard segments (numeric or string) when the runtime path keys
 * match, or `null` otherwise. Segments are matched 1:1; `*` accepts
 * anything; literal segments must equal the runtime key as a string.
 */
function buildPathMatcher(
  pattern: string,
): (keys: (string | number)[]) => (string | number)[] | null {
  const segments = pattern.split(".");
  return (keys) => {
    if (keys.length !== segments.length) return null;
    const captures: (string | number)[] = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const key = keys[i];
      if (seg === "*") {
        captures.push(key);
      } else if (String(key) !== seg) {
        return null;
      }
    }
    return captures;
  };
}

import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import type { Runnable } from "@langchain/core/runnables";
import { dispatchLlmUsage } from "./llm-usage-event";

/**
 * Drive an LLM via `.stream()` and forward both text deltas AND
 * tool-call deltas as custom events. Returns the accumulated
 * `AIMessageChunk` so the caller can build a final `AIMessage`
 * carrying `content` + `tool_calls` verbatim — same contract as the
 * raw `for await (const chunk of stream)` loop the activity agent
 * used to use, just with the wire emission spliced in.
 *
 * Why this helper exists: when an LLM call is bound to tools, the
 * model can emit a single message that interleaves text content
 * and tool-call argument tokens. ChatOpenAI surfaces those tool
 * args as `tool_call_chunks[]` on each `AIMessageChunk`, which
 * `AIMessageChunk.concat` accumulates into the final `tool_calls`
 * array. Without this helper the args were silently buffered until
 * `on_chain_end` — meaning every tool call (e.g. `emit_worksheet`
 * with a 5-20 KB worksheet JSON) hid behind a chat-pane spinner
 * with no progress indication. After this helper the FE sees:
 *
 *   tool_call_start { id, name, node, call_index }
 *   tool_call_arg_delta { id, delta }   // many of these
 *   tool_call_end { id, args }
 *
 * mirrored to the Redis stream like every other typed slice, so
 * follower tabs and new-device joins see args growing live too.
 *
 * Text-content deltas are dispatched as `assistant_text_token`
 * (same shape the existing field extractor uses) so the chat
 * controller's existing handler routes them through `writer.text(…)`
 * + `assistant_text_delta` mirroring without modification.
 *
 * Failures of `dispatchCustomEvent` are swallowed — the wire
 * emission is best-effort, and the returned chunk still carries
 * the full content + tool_calls for the caller to act on.
 */
export async function streamLlmAndExtractToolCalls(
  llm: Runnable<BaseMessage[], AIMessageChunk>,
  messages: BaseMessage[],
  options: { node: string; tier?: string | null; model?: string | null },
): Promise<AIMessageChunk | undefined> {
  // Per-call accumulator state. ChatOpenAI emits one `tool_call_chunk`
  // per partial delta; the first chunk for an `index` carries the
  // tool-call `id` + `name`, subsequent chunks carry only `args`. We
  // mirror that to `tool_call_start` (once) + many `tool_call_arg_delta`.
  type ToolState = {
    id: string;
    name: string;
    callIndex: number;
    startEmitted: boolean;
    argsBuffer: string;
  };
  const byIndex = new Map<number, ToolState>();
  // Some providers (notably some Anthropic adapters) reuse the same
  // `id` across multiple calls but vary `index`. Track by `id` too so
  // we don't double-emit `tool_call_start` for the same id.
  const startedIds = new Set<string>();

  let combined: AIMessageChunk | undefined;
  const stream = await llm.stream(messages);
  for await (const chunk of stream) {
    // Text content goes through the same dispatch shape the existing
    // field extractor uses, so chat.controller's `assistant_text_token`
    // handler picks it up unchanged. The controller mints a `blockId`
    // per (run, node) and mirrors each token to Redis as
    // `assistant_text_delta` for follower tabs.
    const piece = typeof chunk.content === "string" ? chunk.content : "";
    if (piece) {
      try {
        await dispatchCustomEvent("assistant_text_token", {
          token: piece,
          node: options.node,
        });
      } catch {
        /* best-effort wire emission */
      }
    }

    // Tool-call argument streaming. The chunk shape varies slightly
    // across LangChain provider integrations, but the canonical
    // ChatOpenAI shape is `tool_call_chunks: Array<{ index, id?,
    // name?, args? }>`. We treat anything without an `index` as
    // index 0 — single tool-call-per-message is by far the common
    // case and the activity agent's prompts produce one call at a
    // time anyway.
    const toolChunks = (
      chunk as AIMessageChunk & {
        tool_call_chunks?: Array<{
          index?: number;
          id?: string;
          name?: string;
          args?: string;
          type?: string;
        }>;
      }
    ).tool_call_chunks;
    if (toolChunks?.length) {
      for (const tc of toolChunks) {
        const idx = tc.index ?? 0;
        let st = byIndex.get(idx);
        if (!st) {
          // Wait for a chunk that carries id + name before opening
          // the wire envelope. ChatOpenAI guarantees these land on
          // the FIRST chunk for a given index, so this is normally
          // a no-op gate.
          if (!tc.id || !tc.name) continue;
          st = {
            id: tc.id,
            name: tc.name,
            callIndex: idx,
            startEmitted: false,
            argsBuffer: "",
          };
          byIndex.set(idx, st);
        } else {
          // Defensive: if a later chunk fills in id/name (some
          // providers do this), keep the latest non-empty values.
          if (tc.id && !st.id) st.id = tc.id;
          if (tc.name && !st.name) st.name = tc.name;
        }
        if (!st.startEmitted && st.id && st.name && !startedIds.has(st.id)) {
          startedIds.add(st.id);
          st.startEmitted = true;
          try {
            await dispatchCustomEvent("tool_call_start", {
              id: st.id,
              name: st.name,
              node: options.node,
              call_index: st.callIndex,
            });
          } catch {
            /* best-effort */
          }
        }
        if (tc.args) {
          st.argsBuffer += tc.args;
          try {
            await dispatchCustomEvent("tool_call_arg_delta", {
              id: st.id,
              delta: tc.args,
            });
          } catch {
            /* best-effort */
          }
        }
      }
    }

    combined = combined ? combined.concat(chunk) : chunk;
  }

  // After the stream closes, dispatch the per-call token-usage event
  // so the eval CLI can attribute cost back to this node. Best-effort
  // and silent on failure — see `dispatchLlmUsage`.
  await dispatchLlmUsage(combined, {
    node: options.node,
    tier: options.tier ?? null,
    model: options.model ?? null,
  });

  // After the stream closes, emit `tool_call_end` carrying the
  // canonical parsed args object. `AIMessageChunk.concat` has
  // already reconstructed `tool_calls[]` for us by walking the
  // tool_call_chunks deltas; we just forward that shape so
  // consumers don't have to re-parse the buffered JSON themselves.
  const finalCalls = combined?.tool_calls ?? [];
  for (const call of finalCalls) {
    if (!call.id) continue;
    try {
      await dispatchCustomEvent("tool_call_end", {
        id: call.id,
        args: (call.args ?? {}) as Record<string, unknown>,
      });
    } catch {
      /* best-effort */
    }
  }

  return combined;
}

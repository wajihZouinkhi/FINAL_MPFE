import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import type { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import type { LlmUsage } from "@mpfe/shared";

/**
 * Identifying metadata attached to every `llm_usage` dispatch by a
 * call site. Required:
 *   - `node`: LangGraph node name (matches the `node` field on
 *     `assistant_text_token` / `assistant_text_delta`). Lets the eval
 *     aggregate cost per-node per-run.
 * Optional:
 *   - `tier`: `LlmConfigService` tier name (`supervisor`/`writer`/
 *     `critic`/`utility`). Helpful when several call sites in the same
 *     node use different tiers.
 *   - `model`: wire model id (e.g. `gpt-4o-mini`) for cross-checking
 *     against provider invoices.
 */
export interface LlmUsageContext {
  node: string;
  tier?: string | null;
  model?: string | null;
}

/**
 * Inspect an accumulated `AIMessageChunk` for token usage and
 * dispatch a single `llm_usage` custom event capturing it. Idempotent
 * and best-effort: if the chunk is missing, has no `usage_metadata`,
 * or the dispatch throws (the runnable is already finalised), we
 * silently skip — the caller stays unaffected.
 *
 * Why a separate helper instead of inlining at each call site: the
 * three streaming helpers in this directory each accumulate a final
 * `combined: AIMessageChunk` already; this lets every one of them
 * emit usage with one line at end-of-stream while keeping the
 * `usage_metadata` shape conversion + null-handling in one place.
 *
 * The dispatched event lands as `on_custom_event { name: "llm_usage", data }`
 * on the chat controller's `streamEvents` loop, where it's routed
 * into the `llm_usage` typed slice and mirrored to Redis +
 * `agent_events` (the eval CLI's source of truth for per-run cost).
 */
export async function dispatchLlmUsage(
  combined: AIMessageChunk | AIMessage | undefined,
  ctx: LlmUsageContext,
): Promise<void> {
  if (!combined) return;
  const usage = (combined as { usage_metadata?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  } }).usage_metadata;
  if (!usage) return;
  // `id` is the runnable id LangChain stamps on the AIMessage(Chunk) —
  // distinct per LLM call. Used as the unique key so two consecutive
  // identical payloads never deduplicate against each other in the
  // controller's snapshot `emit()` (which guards by JSON equality of
  // the latest payload per kind).
  const runId =
    (combined as { id?: string }).id ??
    `llm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const payload: LlmUsage = {
    run_id: runId,
    node: ctx.node,
    tier: ctx.tier ?? null,
    model: ctx.model ?? null,
    input_tokens:
      typeof usage.input_tokens === "number" ? usage.input_tokens : null,
    output_tokens:
      typeof usage.output_tokens === "number" ? usage.output_tokens : null,
    total_tokens:
      typeof usage.total_tokens === "number" ? usage.total_tokens : null,
  };
  try {
    await dispatchCustomEvent("llm_usage", payload);
  } catch {
    // The streaming helper is sometimes called outside an active
    // LangGraph run context (e.g. unit tests). Failing the dispatch
    // here would surface as an unhandled rejection — silence it.
  }
}

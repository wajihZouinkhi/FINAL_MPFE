"use client";

import { useEffect, useRef } from "react";
import type {
  ActivityGenerationProgress,
  ActivityManifestItem,
  ActivityToolCall,
  ActivityWorksheetEmission,
  AgentInterrupt,
  AgentPhase,
  AssistantTextDelta,
  ManifestItem,
  ResearchPlan,
  RunSnapshot,
  SubagentRun,
  SubagentTextDelta,
  SubagentToolCall,
  TodoPlan,
  ToolCallArgDelta,
  ToolCallEnd,
  ToolCallStart,
  ToolResult,
  VfsUpdate,
} from "@mpfe/shared";
import { useAgentStore } from "../stores/agent-store";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/**
 * Server-driven view of the agent's lifecycle and per-slice state.
 *
 * Today the only path that updates the chat UI's `phase` /
 * `research_plan` / etc. is the SSE stream this tab opens via
 * `useChat` POST /api/chat/:threadId. That breaks every cross-tab and
 * post-reload scenario:
 *   • a run started in another tab never reaches this one,
 *   • a run that crashed (or was reaped by RunWorker) after the tab
 *     closed leaves stale phase / plan / interrupt slices in the
 *     LangGraph checkpointer — the FE rehydrates the lie on reload.
 *
 * This hook closes the gap by opening a long-lived `GET
 * /api/chat/:threadId/stream?lastId=…` connection backed by a Redis
 * Stream on the server. It produces the same Vercel AI SDK v5 UI
 * Message Stream SSE frames the active `useChat` POST emits, so the
 * FE transport layer is identical: parse `data: { type: "data-<kind>",
 * data, transient }\n\n` chunks, demux each `kind` into the
 * corresponding Zustand setter.
 *
 * Reconnect is exact, not approximate. The server returns a Redis
 * entry id alongside every event; we persist the latest one to
 * sessionStorage keyed by thread, and pass it back as `?lastId=…`
 * on reconnect. The server uses XRANGE to ship missed-while-offline
 * frames, then switches to XREAD BLOCK to follow live. No duplicate
 * deliveries; no missed deliveries between disconnect and resubscribe.
 *
 * Why one SSE connection instead of two channels (Supabase Realtime
 * `agent_events` + REST backfill, the previous design):
 *  • Sub-millisecond cross-tab fan-out instead of 100-300ms Postgres
 *    logical replication.
 *  • One transport, one ordering guarantee, one resume cursor —
 *    the previous monotonic-id dedup logic on the FE became unnecessary
 *    because the server is the only thing assigning ids and it never
 *    re-delivers.
 *  • Multi-API-replica safe out of the box (Redis is shared).
 *  • No migration to manage (no `agent_events` to `supabase_realtime`
 *    publication, no REPLICA IDENTITY FULL bookkeeping).
 *
 * Run lifecycle (`agent_runs` row status: running/paused/failed/
 * completed) still flows through this hook — but now via in-stream
 * `run` events rather than a separate Realtime subscription. The API
 * emits a `run` slice on create, on every status flip, and on the
 * final terminal state of each run.
 */
export function useAgentRunRealtime(threadId: string): void {
  const setPhase = useAgentStore((s) => s.setPhase);
  const setResearchPlan = useAgentStore((s) => s.setResearchPlan);
  const setTodoPlan = useAgentStore((s) => s.setTodoPlan);
  const setManifest = useAgentStore((s) => s.setManifest);
  const setActivityManifest = useAgentStore((s) => s.setActivityManifest);
  const setActivityToolCalls = useAgentStore((s) => s.setActivityToolCalls);
  const setActivityGenerationProgress = useAgentStore(
    (s) => s.setActivityGenerationProgress,
  );
  const setActivityWorksheets = useAgentStore(
    (s) => s.setActivityWorksheets,
  );
  const setInterrupt = useAgentStore((s) => s.setInterrupt);
  const setInterruptHistory = useAgentStore((s) => s.setInterruptHistory);
  const setLatestRun = useAgentStore((s) => s.setLatestRun);
  const setResearchAnchorMsgIndex = useAgentStore(
    (s) => s.setResearchAnchorMsgIndex,
  );
  const setTodoAnchorMsgIndex = useAgentStore((s) => s.setTodoAnchorMsgIndex);
  const appendLiveTextDelta = useAgentStore((s) => s.appendLiveTextDelta);
  const closeLiveTextBlock = useAgentStore((s) => s.closeLiveTextBlock);
  const upsertLiveToolCall = useAgentStore((s) => s.upsertLiveToolCall);
  const appendLiveToolCallArgDelta = useAgentStore(
    (s) => s.appendLiveToolCallArgDelta,
  );
  const finalizeLiveToolCallArgs = useAgentStore(
    (s) => s.finalizeLiveToolCallArgs,
  );
  const finalizeLiveToolCall = useAgentStore((s) => s.finalizeLiveToolCall);
  const applyVfsUpdate = useAgentStore((s) => s.applyVfsUpdate);
  const upsertSubagentRun = useAgentStore((s) => s.upsertSubagentRun);
  const appendSubagentTextDelta = useAgentStore(
    (s) => s.appendSubagentTextDelta,
  );
  const upsertSubagentToolCall = useAgentStore(
    (s) => s.upsertSubagentToolCall,
  );

  // Latest applied store setters held in a ref so the long-lived
  // fetch loop doesn't restart every render.
  const setters = useRef({
    setPhase,
    setResearchPlan,
    setTodoPlan,
    setManifest,
    setActivityManifest,
    setActivityToolCalls,
    setActivityGenerationProgress,
    setActivityWorksheets,
    setInterrupt,
    setInterruptHistory,
    setLatestRun,
    setResearchAnchorMsgIndex,
    setTodoAnchorMsgIndex,
    appendLiveTextDelta,
    closeLiveTextBlock,
    upsertLiveToolCall,
    appendLiveToolCallArgDelta,
    finalizeLiveToolCallArgs,
    finalizeLiveToolCall,
    applyVfsUpdate,
    upsertSubagentRun,
    appendSubagentTextDelta,
    upsertSubagentToolCall,
  });
  setters.current = {
    setPhase,
    setResearchPlan,
    setTodoPlan,
    setManifest,
    setActivityManifest,
    setActivityToolCalls,
    setActivityGenerationProgress,
    setActivityWorksheets,
    setInterrupt,
    setInterruptHistory,
    setLatestRun,
    setResearchAnchorMsgIndex,
    setTodoAnchorMsgIndex,
    appendLiveTextDelta,
    closeLiveTextBlock,
    upsertLiveToolCall,
    appendLiveToolCallArgDelta,
    finalizeLiveToolCallArgs,
    finalizeLiveToolCall,
    applyVfsUpdate,
    upsertSubagentRun,
    appendSubagentTextDelta,
    upsertSubagentToolCall,
  };

  useEffect(() => {
    if (!threadId) return;
    const storageKey = `mpfe.lastEventId.${threadId}`;
    const abort = new AbortController();
    let cancelled = false;
    // Bound the reconnect loop with a backoff so a server outage
    // doesn't tight-loop. Reset to 0 on a successful read.
    let backoffMs = 1000;
    const MAX_BACKOFF_MS = 15_000;

    const apply = (kind: string, payload: unknown) => {
      const s = setters.current;
      switch (kind) {
        case "phase":
          s.setPhase(payload as AgentPhase);
          break;
        case "research_plan":
          s.setResearchPlan(payload as ResearchPlan | null);
          break;
        case "todo_plan":
          s.setTodoPlan(payload as TodoPlan | null);
          break;
        case "manifest":
          s.setManifest((payload as ManifestItem[] | null) ?? []);
          break;
        case "activity_manifest":
          s.setActivityManifest(
            (payload as ActivityManifestItem[] | null) ?? [],
          );
          break;
        case "activity_tool_calls":
          s.setActivityToolCalls(
            (payload as ActivityToolCall[] | null) ?? [],
          );
          break;
        case "activity_progress":
          s.setActivityGenerationProgress(
            (payload as ActivityGenerationProgress | null) ?? null,
          );
          break;
        case "activity_worksheets":
          s.setActivityWorksheets(
            (payload as ActivityWorksheetEmission[] | null) ?? [],
          );
          break;
        case "interrupt":
          s.setInterrupt(payload as AgentInterrupt | null);
          break;
        case "interrupt_history":
          s.setInterruptHistory((payload as AgentInterrupt[] | null) ?? []);
          break;
        case "run":
          s.setLatestRun(payload as RunSnapshot | null);
          break;
        case "research_anchor_msg_index":
          s.setResearchAnchorMsgIndex(payload as number | null);
          break;
        case "todo_anchor_msg_index":
          s.setTodoAnchorMsgIndex(payload as number | null);
          break;
        case "_cursor": {
          // Transport-only; persisted to sessionStorage so a reload
          // resumes the stream from this exact entry.
          const id = (payload as { id?: string } | null)?.id;
          if (id) sessionStorage.setItem(storageKey, id);
          break;
        }
        case "assistant_text_delta": {
          // Live token mirror for follower tabs / new-device join.
          // The driver tab consumes the same content via the v5
          // `text-delta` wire frame routed into `useChat`'s
          // `messages[]`, so mirroring here would render a duplicate
          // `<LiveAssistantBubble>` underneath the real assistant
          // bubble. Skip the write while the driving tab's POST
          // socket is actively streaming (`driver_active`); the
          // chat pane flips this flag back to `false` whenever
          // `useChat.status` leaves "submitted" / "streaming"
          // (idle, error mid-stream, terminal), so:
          //
          //   - follower tabs (no POST in flight, flag stays false)
          //     populate the live blocks as before;
          //   - the driver during a clean POST skips this branch
          //     and renders only via `messages[]`;
          //   - the driver during a connectivity gap (status flips
          //     to `error`) re-enables the mirror so the
          //     bubble keeps growing while `useChat.resumeStream()`
          //     reattaches.
          if (useAgentStore.getState().driver_active) break;
          const data = payload as AssistantTextDelta | null;
          if (data?.blockId && typeof data.delta === "string") {
            s.appendLiveTextDelta(data.blockId, data.node ?? "", data.delta);
          }
          break;
        }
        case "assistant_text": {
          // Final, full text of an assistant turn — appended to
          // Redis on the chat-text node's `on_chain_end`. Once it
          // lands, the corresponding live block is no longer the
          // source of truth (the durable `agent_events` log + the
          // checkpoint's `messages[]` are), so we drop every live
          // block we have. This keeps the render path simple: live
          // blocks exist only during the streaming window, and
          // hydration is the single source for completed turns.
          //
          // The full text payload itself is currently a no-op on
          // the FE — `/state` reload reconstructs the chat history
          // from `agent_events.assistant_text` rows, and a
          // mid-stream tab can rely on the live block right up to
          // the moment this final lands. Future work (PR-4) will
          // splice the text into `messages[]` directly so reload
          // doesn't have to refetch.
          s.closeLiveTextBlock(""); // legacy callers without blockId
          // Drop ALL live blocks belonging to this run — by the
          // time `assistant_text` lands every block from the same
          // node has been flushed.
          const all = useAgentStore.getState().live_text_blocks;
          for (const b of all) s.closeLiveTextBlock(b.blockId);
          break;
        }
        case "tool_call_start": {
          const data = payload as ToolCallStart | null;
          if (data?.id && data.name) {
            s.upsertLiveToolCall({
              id: data.id,
              name: data.name,
              node: data.node ?? "",
              call_index: data.call_index ?? 0,
            });
          }
          break;
        }
        case "tool_call_arg_delta": {
          const data = payload as ToolCallArgDelta | null;
          if (data?.id && typeof data.delta === "string") {
            s.appendLiveToolCallArgDelta(data.id, data.delta);
          }
          break;
        }
        case "tool_call_end": {
          const data = payload as ToolCallEnd | null;
          if (data?.id && data.args && typeof data.args === "object") {
            s.finalizeLiveToolCallArgs(data.id, data.args);
          }
          break;
        }
        case "tool_result": {
          const data = payload as ToolResult | null;
          if (data?.id && (data.status === "ok" || data.status === "error")) {
            s.finalizeLiveToolCall(
              data.id,
              data.status,
              data.preview ?? null,
              data.duration_ms ?? null,
              data.error ?? null,
            );
          }
          break;
        }
        case "vfs_update": {
          // Deep-agent canvas: merge the path → content delta into
          // the live VFS snapshot. `null` content means delete.
          const data = payload as VfsUpdate | null;
          if (data && data.files && typeof data.files === "object") {
            s.applyVfsUpdate(data);
          }
          break;
        }
        case "subagent_run": {
          // Deep-agent canvas: per-task() snapshot keyed by call_id.
          const data = payload as SubagentRun | null;
          if (data?.call_id) {
            s.upsertSubagentRun(data);
          }
          break;
        }
        case "subagent_tool_call": {
          // Nested tool call inside a running subagent. Replayed
          // from `agent_events` on `/state` rebuild AND streamed
          // live; the store's upsert is keyed by `tool_call_id` so
          // both paths converge to the same canvas trace.
          const data = payload as SubagentToolCall | null;
          if (data?.tool_call_id) s.upsertSubagentToolCall(data);
          break;
        }
        case "subagent_text_delta": {
          // Live per-token thinking from a subagent — routed by
          // call_id to the canvas Subagents row's preview buffer.
          // Mirrors the supervisor's `assistant_text_delta` path
          // but never feeds `useChat.messages[]` (the chat stays
          // supervisor-only). Replayed from Redis on resume; not
          // persisted to the durable event log so a reload past
          // the live window simply shows the row's final output.
          const data = payload as SubagentTextDelta | null;
          if (data?.call_id && data.block_id && typeof data.delta === "string") {
            s.appendSubagentTextDelta(data.call_id, data.block_id, data.delta);
          }
          break;
        }
        // `done` and `error` are bookkeeping markers; the run row
        // (delivered as a `run` event) carries the user-visible
        // status. Nothing to render here.
      }
    };

    const runOnce = async () => {
      const lastId = sessionStorage.getItem(storageKey) ?? "";
      const url = `${API}/api/chat/${encodeURIComponent(threadId)}/stream${
        lastId ? `?lastId=${encodeURIComponent(lastId)}` : ""
      }`;
      let res: Response;
      try {
        res = await fetch(url, { signal: abort.signal, cache: "no-store" });
      } catch (err) {
        if ((err as Error).name === "AbortError") return "stop";
        return "retry";
      }
      // 204 = no run for this thread yet. Don't tight-loop; the
      // POST endpoint will create one when the user submits.
      if (res.status === 204) return "stop-quiet";
      if (!res.ok || !res.body) return "retry";

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        if (cancelled) return "stop";
        let chunk;
        try {
          chunk = await reader.read();
        } catch {
          return "retry";
        }
        if (chunk.done) return "ended";
        backoffMs = 1000;
        buf += decoder.decode(chunk.value, { stream: true });

        // v5 SSE event boundary is a blank line (`\n\n`). Each event
        // is one or more `data: …` lines; the producer side
        // (`writeDataStream`) only ever emits single-line data
        // payloads, so we treat each event as one JSON object.
        let bb: number;
        while ((bb = buf.indexOf("\n\n")) >= 0) {
          const event = buf.slice(0, bb);
          buf = buf.slice(bb + 2);
          if (!event) continue;
          // Strip the optional `data: ` prefix from each line and
          // concat — per the SSE spec, a multi-line data event
          // joins the lines with `\n`. In practice we never emit
          // multi-line data, but this keeps us spec-compliant.
          const dataLines: string[] = [];
          for (const line of event.split("\n")) {
            if (line.startsWith("data: ")) {
              dataLines.push(line.slice(6));
            } else if (line.startsWith("data:")) {
              dataLines.push(line.slice(5));
            }
            // SSE comments / `event:` / `id:` lines are ignored —
            // the v5 producer doesn't emit them.
          }
          if (dataLines.length === 0) continue;
          const payload = dataLines.join("\n");
          // SSE terminator: the producer ends the response with
          // `data: [DONE]\n\n` (mirrors createUIMessageStreamResponse).
          if (payload === "[DONE]") return "ended";
          let parsed: unknown;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }
          if (!parsed || typeof parsed !== "object") continue;
          const part = parsed as { type?: string; data?: unknown };
          if (typeof part.type !== "string") continue;
          // We only care about `data-<kind>` chunks here. `text-*`,
          // `start`, `finish`, `error`, `start-step`, `finish-step`
          // and friends carry the live-typing UX for the active
          // POST tab; for replay-into-Zustand the typed slices are
          // sufficient.
          if (!part.type.startsWith("data-")) continue;
          const kind = part.type.slice("data-".length);
          apply(kind, part.data ?? null);
        }
      }
    };

    void (async () => {
      while (!cancelled) {
        const result = await runOnce();
        if (result === "stop" || result === "stop-quiet") return;
        if (cancelled) return;
        // For "ended" (server cleanly closed) and "retry" (transient
        // failure) we pause and reconnect — the next loop will pick
        // up missed events via lastId.
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
      }
    })();

    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [threadId]);
}

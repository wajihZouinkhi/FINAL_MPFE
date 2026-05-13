"use client";

import { create } from "zustand";
import type {
  ActivityGenerationProgress,
  ActivityManifestItem,
  ActivityToolCall,
  ActivityWorksheetEmission,
  AgentInterrupt,
  AgentPhase,
  ArtifactCard,
  ManifestItem,
  ResearchPlan,
  RunSnapshot,
  SubagentRun,
  SubagentToolCall,
  TodoPlan,
  VfsUpdate,
} from "@mpfe/shared";

/**
 * In-flight assistant text block built from a stream of
 * `assistant_text_delta` events. The active POST tab gets the same
 * text via `useChat`'s v5 `text-delta` frame and never reads this map;
 * follower tabs / new-device joins build the live bubble from this
 * map instead. Cleared once the corresponding `assistant_text` (full
 * final text) lands on the wire — at which point the durable
 * messages array is the source of truth.
 */
export interface LiveTextBlock {
  blockId: string;
  node: string;
  text: string;
}

/**
 * In-flight tool-call view built from `tool_call_start` +
 * `tool_call_arg_delta` + `tool_call_end` + `tool_result` events.
 * Replaces the snapshot-style `activity_tool_calls` array on
 * follower tabs once available, but kept side-by-side for now so
 * the existing chip rendering keeps working unmodified.
 */
export interface LiveToolCall {
  id: string;
  name: string;
  node: string;
  call_index: number;
  /** Concatenated raw arg deltas — JSON if the model emits valid JSON. */
  args_buffer: string;
  /** Parsed args after `tool_call_end`; null while still streaming. */
  args: Record<string, unknown> | null;
  status: "calling" | "ok" | "error";
  preview: string | null;
  duration_ms: number | null;
  error: string | null;
  /**
   * Index in `state.messages` of the AIMessage that issued this tool
   * call. Set on `/state` hydration (deepagent threads) so the chat
   * pane can render the chip directly under the AI bubble that issued
   * it instead of bunched at the tail. Null while live (the FE has no
   * reliable way to compute the anchor mid-stream — supervisor turns
   * may emit the tool call BEFORE any text has reached `messages[]`)
   * and for legacy paths that never carried an anchor.
   */
  anchor_msg_index: number | null;
}

function orderActivityToolCalls(calls: ActivityToolCall[]): ActivityToolCall[] {
  return [...calls].sort((a, b) => {
    const byStart = Date.parse(a.started_at) - Date.parse(b.started_at);
    if (byStart !== 0 && Number.isFinite(byStart)) return byStart;
    return toolOrdinal(a.id) - toolOrdinal(b.id);
  });
}

function toolOrdinal(id: string): number {
  const match = id.match(/-(\d+)$/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function mergeActivityWorksheets(
  current: ActivityWorksheetEmission[],
  incoming: ActivityWorksheetEmission[],
): ActivityWorksheetEmission[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((w) => [w.activity_id, w]));
  for (const w of incoming) byId.set(w.activity_id, w);
  return Array.from(byId.values());
}

/**
 * Discriminated union of canvas-focus targets — every place that
 * wants to bring the deep-agent canvas into view declares which
 * inner tab the user expects to land on. `subagent_call_id` is the
 * optional `subagent_run` row to scroll into view once the
 * Subagents tab mounts (used by `<TaskCard>` clicks).
 */
export type CanvasFocusTarget =
  | { kind: "subagents"; subagent_call_id: string | null }
  | { kind: "files" }
  | { kind: "artifact" };

export interface CanvasFocusRequest {
  /** Monotonic counter so repeat-clicks on the same target re-fire. */
  counter: number;
  target: CanvasFocusTarget;
}

/**
 * Agent state demuxed from the Vercel AI SDK data parts.
 *
 * The chat controller emits one snapshot per slice (`kind` discriminator);
 * we keep the latest snapshot per slice in this store so cards subscribe
 * to exactly the data they care about and re-render in place.
 */
interface AgentState {
  phase: AgentPhase;
  research_plan: ResearchPlan | null;
  todo_plan: TodoPlan | null;
  manifest: ManifestItem[];
  /** Activity-agent manifest — one entry per generated worksheet. */
  activity_manifest: ActivityManifestItem[];
  /**
   * Tooled-only: per-MCP-tool-call timeline for the currently running
   * (or just-finished) activity-tooled turn. Each entry flips through
   * "calling" → "complete" / "error" as the LLM works through the
   * lesson menu. Replace-on-write — the server always sends the full
   * trace, never patches.
   */
  activity_tool_calls: ActivityToolCall[];
  /**
   * Live progress for the writer LLM streaming the worksheet JSON.
   * `null` outside of an active draft. Used by the chat pane to
   * render "3/5 MCQs · 1/2 SA · ✓ worked example" copy on the
   * drafting manifest item, closing the dead-air gap between
   * "tool calls done" and "manifest=ready".
   */
  activity_generation_progress: ActivityGenerationProgress | null;
  /**
   * Worksheet emissions for this thread — each entry mirrors one
   * `emit_worksheet` tool call from the activity agent. The chat pane
   * renders an inline `<ActivityWorksheet>` per entry, anchored to the
   * AI message at `anchor_msg_index`. Replace-on-write so reload
   * always reflects the canonical full set.
   */
  activity_worksheets: ActivityWorksheetEmission[];
  interrupt: AgentInterrupt | null;
  /** Permanent Q&A trail — the answered asks plus any pending one. */
  interrupt_history: AgentInterrupt[];
  /**
   * Index in `state.messages` of the AI bubble each card belongs to.
   * Set server-side at the moment the supervisor decides search / write,
   * persisted in the LangGraph checkpoint, and replayed in `/state`
   * hydration AND in the live SSE stream — so the cards anchor to the
   * same message in both views and reload doesn't push them to the tail.
   */
  research_anchor_msg_index: number | null;
  todo_anchor_msg_index: number | null;
  /**
   * Latest `agent_runs` row mirrored to the FE. Drives the run badge,
   * the input gating, and the inline failed-run card. Updated from
   *   (a) the SSE stream's `run` data part during the user's own turn,
   *   (b) Supabase Realtime on `agent_runs`/`agent_events` for any
   *       other path (other tab, another user, reaper-driven failure).
   * `null` means no agent_run has ever been started for this thread.
   */
  latest_run: RunSnapshot | null;
  /** Active item in the right-pane viewer (lesson uuid). */
  active_lesson_id: string | null;
  /** Active chapter for the chapter-summary view (mutually exclusive with lesson). */
  active_chapter_id: string | null;
  /**
   * Activity-thread workbench selection. Holds the `activity_id` of the
   * worksheet currently opened in the right-pane workbench. The chat
   * shows a compact tool-call chip per emitted worksheet; clicking a chip
   * sets this id, which causes the workbench to render that specific
   * worksheet. Empty by default — the workbench shows a hint until a
   * chip is clicked. Cleared on thread switch and on full reset.
   */
  selected_worksheet_activity_id: string | null;
  /**
   * In-memory cache of lesson markdown content keyed by lesson id.
   * Populated lazily as lessons are opened so switching is instant
   * even if the underlying snapshot row temporarily doesn't include
   * the latest content (e.g. a Realtime UPDATE in flight).
   * Cleared only on full page reload, by design.
   */
  lesson_cache: Record<string, string>;

  /**
   * In-flight text blocks keyed by `blockId`. Populated by the
   * realtime hook when `assistant_text_delta` events arrive on a
   * follower tab. Each block accumulates `delta` characters into
   * `text` until the corresponding `assistant_text` (final) lands,
   * at which point the block is dropped (the durable messages
   * array reconstructed by `/state` is now the source of truth).
   *
   * Order is insertion order so the FE can render multi-bubble
   * runs (supervisor → search → write → supervisor again) in the
   * correct chronological sequence.
   */
  live_text_blocks: LiveTextBlock[];
  /**
   * In-flight tool calls keyed by tool-call id. Populated by the
   * realtime hook when `tool_call_start` / `tool_call_arg_delta`
   * / `tool_call_end` / `tool_result` events arrive. Renders args
   * growing live on the chip (BEENET-style). Replace-on-write:
   * each event mutates the matching entry in place.
   */
  live_tool_calls: LiveToolCall[];

  /**
   * Deep-agent virtual filesystem snapshot for the canvas.
   * `path → content`. Hydrated from `/state` on mount and updated
   * live as `vfs_update` data parts arrive (each delta merges in,
   * `null` content deletes the path). Empty `{}` on non-deepagent
   * threads. Drives the canvas's file tree + viewer pane.
   */
  vfs: Record<string, string>;
  /**
   * Deep-agent subagent activity panel state. One entry per
   * `task()` dispatch, replaced by `call_id` so a task transitions
   * `running → ok|error` cleanly. Hydrated from `/state` and updated
   * live via `subagent_run` data parts. Insertion order matches
   * dispatch order.
   */
  subagent_runs: SubagentRun[];

  /**
   * Per-call_id live text buffer for in-flight subagent thinking.
   * Filled by `appendSubagentTextDelta` as `subagent_text_delta`
   * events arrive on the wire. Cleared (per call_id) when the
   * matching subagent_run flips to `ok` / `error` — the row's
   * final synthesised output (carried on the snapshot) takes over
   * the canvas display from that point.
   *
   * Empty `{}` on non-deepagent threads. Never persisted to
   * `/state`: a reload that misses the live window simply shows
   * the row's final output instead, which is enough.
   */
  subagent_live_text: Record<string, { block_id: string; text: string }>;

  /**
   * Nested tool calls emitted by running subagents (e.g. the writer's
   * `create_lesson`, the researcher's `web_search`). Snapshot-style:
   * one entry per `tool_call_id`, replaced in place as the call walks
   * `running` → `ok|error`. The canvas SubagentRunRow groups by
   * `call_id` (parent task id) to render the trace inside the matching
   * row.
   *
   * Hydrated from `/state` on mount and updated live via
   * `subagent_tool_call` data parts. Insertion order matches dispatch
   * order so the canvas trace reads top-to-bottom chronologically.
   */
  subagent_tool_calls: SubagentToolCall[];

  /**
   * Currently-open artifact in the deepagent canvas's third tab.
   * `null` when no artifact has been clicked. Set by
   * `openArtifact()` (driven by the inline `<artifact …/>` chip in
   * the chat) and cleared by `closeArtifact()` / thread reset.
   *
   * Only `kind` + `id` + `title` are tracked here — the canvas
   * fetches the full snapshot (`syllabus_snapshot` / activity row)
   * directly when the tab mounts.
   */
  active_artifact: ArtifactCard | null;

  /**
   * Mobile-only signal to bring the deep-agent canvas into focus.
   *
   * On desktop the canvas pane is always rendered side-by-side with
   * the chat (via the `lg:grid` breakpoint in `deepagent-view`), so
   * "focus" reduces to switching the canvas's INNER tab and
   * (optionally) scrolling a row into view. On mobile the parent
   * uses a single `Chat | Canvas` tab switcher and the canvas pane
   * is `display: none` while the user reads the chat — which is
   * why a tap on a `<TaskCard>` or `<artifact …/>` chip used to be
   * silent: the canvas would update its inner state but stay
   * hidden behind the chat tab.
   *
   * The counter is monotonic so a repeated tap on the same target
   * (e.g. clicking the same task card twice) re-fires the focus
   * effect even when both tabs are already correctly selected. The
   * `target` discriminator lets the canvas decide which inner tab
   * to land on; `subagent_call_id` is the optional row to scroll
   * into view once the Subagents tab mounts.
   *
   * `null` until the first `requestCanvasFocus()` — the cold-mount
   * path doesn't auto-switch tabs, only explicit user intent does.
   */
  canvas_focus_request: CanvasFocusRequest | null;

  /**
   * True while THIS tab's `useChat` POST socket is actively producing
   * an assistant turn (`status === "submitted" | "streaming"`). The
   * realtime hook reads this flag to decide whether to mirror
   * `assistant_text_delta` events into `live_text_blocks`: when the
   * driving tab is already feeding the same text into
   * `useChat.messages[]` via the v5 `text-delta` wire frame, mirroring
   * to `live_text_blocks` would render a duplicate `<LiveAssistantBubble>`
   * underneath the real assistant bubble.
   *
   * Follower tabs leave this `false` and continue to populate
   * `live_text_blocks` from the GET /stream replay so a new-device
   * join sees in-flight prose. The driver flips it back to `false`
   * when the local socket dies (PR-C reconnect path) so
   * `live_text_blocks` can fill the disconnect gap until
   * `resumeStream()` reattaches and `messages[]` resumes growing.
   */
  driver_active: boolean;

  setPhase: (p: AgentPhase) => void;
  setResearchPlan: (p: ResearchPlan | null) => void;
  setTodoPlan: (p: TodoPlan | null) => void;
  setManifest: (m: ManifestItem[]) => void;
  setActivityManifest: (m: ActivityManifestItem[]) => void;
  setActivityToolCalls: (c: ActivityToolCall[]) => void;
  setActivityGenerationProgress: (p: ActivityGenerationProgress | null) => void;
  setActivityWorksheets: (w: ActivityWorksheetEmission[]) => void;
  setInterrupt: (i: AgentInterrupt | null) => void;
  setInterruptHistory: (h: AgentInterrupt[]) => void;
  setResearchAnchorMsgIndex: (i: number | null) => void;
  setTodoAnchorMsgIndex: (i: number | null) => void;
  /**
   * Replace the latest_run snapshot. Older rows (smaller `created_at`)
   * are ignored so out-of-order Realtime + SSE deliveries can't downgrade
   * a fresher state — e.g. `running → completed` arriving after the
   * `completed` row was already applied via SSE shouldn't revert.
   */
  setLatestRun: (r: RunSnapshot | null) => void;
  setActiveLesson: (id: string | null) => void;
  setActiveChapter: (id: string | null) => void;
  setSelectedWorksheet: (id: string | null) => void;
  cacheLesson: (id: string, content: string) => void;
  /**
   * Append a delta to a live text block. Creates the block on
   * first delta if absent. Idempotent only insofar as the server
   * is the only producer and assigns monotonic Redis entry ids;
   * the FE never replays the same delta twice.
   */
  appendLiveTextDelta: (blockId: string, node: string, delta: string) => void;
  /**
   * Drop a live text block once its final `assistant_text` has
   * landed (or on thread switch). Called from the realtime hook's
   * `assistant_text` handler.
   */
  closeLiveTextBlock: (blockId: string) => void;
  /** Open a tool-call envelope from `tool_call_start`. */
  upsertLiveToolCall: (entry: Pick<
    LiveToolCall,
    "id" | "name" | "node" | "call_index"
  >) => void;
  /**
   * Replace the entire live tool-call list. Used by `/state`
   * hydration on deepagent thread mount to restore the supervisor's
   * tool-call chips after a page refresh — the live wire frames live
   * only in this in-memory store, so a reload would otherwise lose
   * every chip. The hydration carries `anchor_msg_index` so chips
   * render inline; legacy paths that don't supply an anchor render at
   * the tail.
   */
  setLiveToolCalls: (calls: LiveToolCall[]) => void;
  /** Append raw arg JSON delta from `tool_call_arg_delta`. */
  appendLiveToolCallArgDelta: (id: string, delta: string) => void;
  /** Set parsed args from `tool_call_end`. */
  finalizeLiveToolCallArgs: (
    id: string,
    args: Record<string, unknown>,
  ) => void;
  /** Apply `tool_result` outcome to a live tool call. */
  finalizeLiveToolCall: (
    id: string,
    status: "ok" | "error",
    preview: string | null,
    duration_ms: number | null,
    error: string | null,
  ) => void;
  /**
   * Set the driver-active flag. Driven by the chat pane from
   * `useChat.status` so the realtime hook can suppress
   * `live_text_blocks` mirroring while this tab's POST socket is
   * already painting the same text into `useChat.messages[]`.
   */
  setDriverActive: (active: boolean) => void;
  /**
   * Replace the entire VFS snapshot (used on `/state` hydration).
   * Live deltas use `applyVfsUpdate` instead.
   */
  setVfs: (files: Record<string, string>) => void;
  /**
   * Apply a `vfs_update` delta — paths with string content are
   * upserted, paths with null content are deleted. The
   * `subagent_call_id` tag is informational; the canvas may use it
   * later to colour-code by author but the merge logic ignores it.
   */
  applyVfsUpdate: (update: VfsUpdate) => void;
  /**
   * Replace the entire subagent_runs list (used on `/state`
   * hydration). Live updates use `upsertSubagentRun`.
   */
  setSubagentRuns: (runs: SubagentRun[]) => void;
  /**
   * Upsert a single subagent run by `call_id`. Latest emit wins —
   * `running → ok|error` overwrites in place, preserving the
   * insertion order so dispatched-first stays at the top.
   *
   * Side effect: when the run flips to a terminal status (`ok` or
   * `error`), the per-call_id `subagent_live_text` buffer is
   * cleared so the canvas row stops rendering the live preview
   * and starts rendering the final synthesised `output` instead.
   */
  upsertSubagentRun: (run: SubagentRun) => void;
  /**
   * Append a delta to the live thinking buffer for a subagent
   * `call_id`. Creates the buffer on first delta. The `block_id`
   * exists for parity with the supervisor's `assistant_text_delta`
   * — today there's only one block per subagent run so we always
   * append; if the block id changes mid-run we reset the buffer.
   */
  appendSubagentTextDelta: (
    callId: string,
    blockId: string,
    delta: string,
  ) => void;
  /**
   * Replace the entire `subagent_tool_calls` list (used on `/state`
   * hydration). Live updates use `upsertSubagentToolCall`.
   */
  setSubagentToolCalls: (calls: SubagentToolCall[]) => void;
  /**
   * Upsert a single nested tool call by `tool_call_id`. Latest emit
   * wins so `running` → `ok|error` overwrites in place; insertion
   * order is preserved so the SubagentRunRow renders calls in
   * dispatch order.
   */
  upsertSubagentToolCall: (call: SubagentToolCall) => void;
  /**
   * Open an artifact in the canvas's Artifact tab. The canvas
   * auto-selects the tab the moment this becomes non-null, and
   * `deepagent-view` watches the same slice to flip its mobile
   * `Chat | Canvas` tab switcher to "canvas" so the user actually
   * sees the artifact instead of staying on the chat tab.
   */
  openArtifact: (card: ArtifactCard) => void;
  /** Close the canvas's Artifact tab and drop the active selection. */
  closeArtifact: () => void;
  /**
   * Bring the deep-agent canvas into focus. Bumps `canvas_focus_request.counter`
   * and writes the requested inner tab + optional subagent row to scroll
   * into view. The mobile parent (`deepagent-view`) watches the counter
   * and switches its outer tab to "canvas"; the canvas itself watches
   * the same slice to switch its inner tab and run the scroll. On
   * desktop the parent's outer tab is irrelevant (both panes are
   * always visible) — only the inner tab + scroll take effect.
   */
  requestCanvasFocus: (target: CanvasFocusTarget) => void;
  reset: (initial?: Partial<AgentState>) => void;
}

export const useAgentStore = create<AgentState>((set) => ({
  phase: "idle",
  research_plan: null,
  todo_plan: null,
  manifest: [],
  activity_manifest: [],
  activity_tool_calls: [],
  activity_generation_progress: null,
  activity_worksheets: [],
  interrupt: null,
  interrupt_history: [],
  research_anchor_msg_index: null,
  todo_anchor_msg_index: null,
  latest_run: null,
  active_lesson_id: null,
  active_chapter_id: null,
  selected_worksheet_activity_id: null,
  lesson_cache: {},
  live_text_blocks: [],
  live_tool_calls: [],
  vfs: {},
  subagent_runs: [],
  subagent_live_text: {},
  subagent_tool_calls: [],
  active_artifact: null,
  canvas_focus_request: null,
  driver_active: false,

  setPhase: (p) => set({ phase: p }),
  setResearchPlan: (p) => set({ research_plan: p }),
  setTodoPlan: (p) => set({ todo_plan: p }),
  setManifest: (m) => set({ manifest: m }),
  setActivityManifest: (m) => set({ activity_manifest: m }),
  setActivityToolCalls: (c) =>
    set({ activity_tool_calls: orderActivityToolCalls(c) }),
  setActivityGenerationProgress: (p) =>
    set({ activity_generation_progress: p }),
  setActivityWorksheets: (w) =>
    set((s) => ({
      activity_worksheets: mergeActivityWorksheets(s.activity_worksheets, w),
    })),
  setInterrupt: (i) => set({ interrupt: i }),
  setInterruptHistory: (h) => set({ interrupt_history: h }),
  setResearchAnchorMsgIndex: (i) => set({ research_anchor_msg_index: i }),
  setTodoAnchorMsgIndex: (i) => set({ todo_anchor_msg_index: i }),
  setLatestRun: (r) =>
    set((s) => {
      // Only swap if the incoming row is for the same run AND newer,
      // OR it's a different (more recent) run. Compare by id+created_at
      // and break terminal-status ties in favour of whichever arrived
      // already (subsequent identical writes are no-ops). Resetting to
      // null is always allowed (used by `reset()` / thread switches).
      if (r === null) return { latest_run: null };
      const cur = s.latest_run;
      if (!cur) return { latest_run: r };
      if (cur.id !== r.id) {
        return cur.created_at <= r.created_at
          ? { latest_run: r }
          : { latest_run: cur };
      }
      // Same run id: prefer the newer status. Use heartbeat / finished_at
      // as the tiebreaker because Realtime UPDATE rows share `created_at`
      // with the original INSERT.
      const curStamp = cur.finished_at ?? cur.last_heartbeat ?? cur.created_at;
      const nextStamp = r.finished_at ?? r.last_heartbeat ?? r.created_at;
      return nextStamp >= curStamp ? { latest_run: r } : { latest_run: cur };
    }),
  setActiveLesson: (id) =>
    set((s) => ({
      active_lesson_id: id,
      // Selecting a lesson also clears the chapter focus so the viewer
      // doesn't try to render both modes simultaneously.
      active_chapter_id: id ? null : s.active_chapter_id,
    })),
  setActiveChapter: (id) =>
    set({ active_chapter_id: id, active_lesson_id: null }),
  setSelectedWorksheet: (id) => set({ selected_worksheet_activity_id: id }),
  cacheLesson: (id, content) =>
    set((s) => ({ lesson_cache: { ...s.lesson_cache, [id]: content } })),
  appendLiveTextDelta: (blockId, node, delta) =>
    set((s) => {
      const idx = s.live_text_blocks.findIndex((b) => b.blockId === blockId);
      if (idx === -1) {
        return {
          live_text_blocks: [
            ...s.live_text_blocks,
            { blockId, node, text: delta },
          ],
        };
      }
      const next = s.live_text_blocks.slice();
      next[idx] = { ...next[idx], text: next[idx].text + delta };
      return { live_text_blocks: next };
    }),
  closeLiveTextBlock: (blockId) =>
    set((s) => ({
      live_text_blocks: s.live_text_blocks.filter(
        (b) => b.blockId !== blockId,
      ),
    })),
  upsertLiveToolCall: (entry) =>
    set((s) => {
      const idx = s.live_tool_calls.findIndex((c) => c.id === entry.id);
      if (idx === -1) {
        return {
          live_tool_calls: [
            ...s.live_tool_calls,
            {
              id: entry.id,
              name: entry.name,
              node: entry.node,
              call_index: entry.call_index,
              args_buffer: "",
              args: null,
              status: "calling",
              preview: null,
              duration_ms: null,
              error: null,
              anchor_msg_index: null,
            },
          ],
        };
      }
      // Idempotent: a re-delivered start (extremely unlikely thanks
      // to Redis monotonic ids) leaves the entry untouched.
      return {};
    }),
  setLiveToolCalls: (calls) => set({ live_tool_calls: calls }),
  appendLiveToolCallArgDelta: (id, delta) =>
    set((s) => {
      const idx = s.live_tool_calls.findIndex((c) => c.id === id);
      if (idx === -1) return {};
      const next = s.live_tool_calls.slice();
      next[idx] = { ...next[idx], args_buffer: next[idx].args_buffer + delta };
      return { live_tool_calls: next };
    }),
  finalizeLiveToolCallArgs: (id, args) =>
    set((s) => {
      const idx = s.live_tool_calls.findIndex((c) => c.id === id);
      if (idx === -1) return {};
      const next = s.live_tool_calls.slice();
      next[idx] = { ...next[idx], args };
      return { live_tool_calls: next };
    }),
  finalizeLiveToolCall: (id, status, preview, duration_ms, error) =>
    set((s) => {
      const idx = s.live_tool_calls.findIndex((c) => c.id === id);
      if (idx === -1) return {};
      const next = s.live_tool_calls.slice();
      next[idx] = {
        ...next[idx],
        status,
        preview,
        duration_ms,
        error,
      };
      return { live_tool_calls: next };
    }),
  setDriverActive: (active) => set({ driver_active: active }),
  setVfs: (files) => set({ vfs: files }),
  applyVfsUpdate: (update) =>
    set((s) => {
      const next: Record<string, string> = { ...s.vfs };
      for (const [path, content] of Object.entries(update.files)) {
        if (content === null) {
          delete next[path];
        } else {
          next[path] = content;
        }
      }
      return { vfs: next };
    }),
  setSubagentRuns: (runs) => set({ subagent_runs: runs }),
  upsertSubagentRun: (run) =>
    set((s) => {
      const idx = s.subagent_runs.findIndex((r) => r.call_id === run.call_id);
      const nextRuns =
        idx === -1 ? [...s.subagent_runs, run] : s.subagent_runs.slice();
      if (idx !== -1) nextRuns[idx] = run;
      // Drop the live thinking buffer once the run reaches a
      // terminal status — the row's final synthesised `output`
      // carried on this snapshot now drives the canvas display.
      // Keep the buffer untouched while still `running` so a
      // late `subagent_run` heartbeat doesn't wipe in-flight text.
      const nextLive =
        run.status === "running"
          ? s.subagent_live_text
          : (() => {
              if (!(run.call_id in s.subagent_live_text))
                return s.subagent_live_text;
              const copy = { ...s.subagent_live_text };
              delete copy[run.call_id];
              return copy;
            })();
      return { subagent_runs: nextRuns, subagent_live_text: nextLive };
    }),
  appendSubagentTextDelta: (callId, blockId, delta) =>
    set((s) => {
      const cur = s.subagent_live_text[callId];
      // First delta for this call_id, OR the runner restarted the
      // block (different block_id) — start fresh.
      if (!cur || cur.block_id !== blockId) {
        return {
          subagent_live_text: {
            ...s.subagent_live_text,
            [callId]: { block_id: blockId, text: delta },
          },
        };
      }
      return {
        subagent_live_text: {
          ...s.subagent_live_text,
          [callId]: { block_id: blockId, text: cur.text + delta },
        },
      };
    }),
  setSubagentToolCalls: (calls) => set({ subagent_tool_calls: calls }),
  upsertSubagentToolCall: (call) =>
    set((s) => {
      const idx = s.subagent_tool_calls.findIndex(
        (c) => c.tool_call_id === call.tool_call_id,
      );
      if (idx === -1)
        return { subagent_tool_calls: [...s.subagent_tool_calls, call] };
      const next = s.subagent_tool_calls.slice();
      next[idx] = call;
      return { subagent_tool_calls: next };
    }),
  openArtifact: (card) =>
    set((s) => ({
      active_artifact: card,
      // Mirror an artifact-tab focus request through the same
      // signal the TaskCard click goes through, so the mobile
      // parent's `Chat | Canvas` switcher flips on the same code
      // path as every other "user wants the canvas" gesture. The
      // canvas's own `useEffect(active_artifact)` still handles
      // the inner-tab swap to "artifact" — this slice exists
      // purely for the OUTER mobile tab.
      canvas_focus_request: {
        counter: (s.canvas_focus_request?.counter ?? 0) + 1,
        target: { kind: "artifact" },
      },
    })),
  closeArtifact: () => set({ active_artifact: null }),
  requestCanvasFocus: (target) =>
    set((s) => ({
      canvas_focus_request: {
        counter: (s.canvas_focus_request?.counter ?? 0) + 1,
        target,
      },
    })),
  reset: (initial) =>
    set({
      phase: "idle",
      research_plan: null,
      todo_plan: null,
      manifest: [],
      activity_manifest: [],
      activity_tool_calls: [],
      activity_generation_progress: null,
      activity_worksheets: [],
      interrupt: null,
      interrupt_history: [],
      research_anchor_msg_index: null,
      todo_anchor_msg_index: null,
      latest_run: null,
      active_lesson_id: null,
      active_chapter_id: null,
      selected_worksheet_activity_id: null,
      lesson_cache: {},
      live_text_blocks: [],
      live_tool_calls: [],
      vfs: {},
      subagent_runs: [],
      subagent_live_text: {},
      subagent_tool_calls: [],
      active_artifact: null,
      canvas_focus_request: null,
      driver_active: false,
      ...initial,
    }),
}));

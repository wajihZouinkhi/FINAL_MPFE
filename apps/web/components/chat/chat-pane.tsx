"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { type MpfeUIMessage, getMessageText } from "../../lib/ui-message";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Send,
  Sparkles,
  Bot,
  User as UserIcon,
  Loader2,
  Square,
  AlertTriangle,
  RotateCcw,
  CheckCircle2,
  FileText,
} from "lucide-react";
import { toast } from "sonner";
import type {
  ActivityIntakeFormAnswer,
  ActivityToolCall,
  AgentInterrupt,
  AgentPhase,
  IntakeFormAnswer,
  RunSnapshot,
} from "@mpfe/shared";
// Worksheet is exported as both a Zod schema and a type alias. Aliased
// here so the schema is available at runtime for parsing the worksheet
// payload off `emit_worksheet` tool calls.
import { Worksheet as WorksheetSchema } from "@mpfe/shared";
import { useAgentStore } from "../../stores/agent-store";
import { ResearchCard } from "./research-card";
import { TodoCard } from "./todo-card";
import { AskCard } from "./ask-card";
import { IntakeCard } from "./intake-card";
import { ActivityIntakeCard } from "./activity-intake-card";
import { ResolvedAskInline } from "./ask-history";
import { Markdown } from "./markdown";
import { MarkdownWithArtifacts } from "./markdown-with-artifacts";
import { LiveToolCallChipCard } from "./tool-call-cards";
import { ActivityWorksheet } from "../activities/activity-worksheet";
import { WorksheetToolCallChip } from "../activities/worksheet-tool-call-chip";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/**
 * Mirror of the server-side synthesizer used for intake_form resume.
 * Both sides MUST produce the same string verbatim so the resolved-ask
 * anchoring (which matches answer.text against user message content)
 * works during live POST and after checkpoint rehydration. Don't tweak
 * one side without tweaking the other — see GraphService.synthesizeIntakeMessage
 * and ChatController.synthesizeIntakeChatMessage.
 */
function synthesizeIntakeMessage(a: IntakeFormAnswer): string {
  const parts: string[] = [];
  parts.push(`Audience level: ${a.audience_level}`);
  if (a.prior_knowledge.length) {
    parts.push(`Prior knowledge: ${a.prior_knowledge.join(", ")}`);
  } else {
    parts.push("Prior knowledge: (none stated)");
  }
  parts.push(`Time budget: ${a.duration_hours}h`);
  parts.push(`Language: ${a.language}`);
  if (a.target_outcome.trim()) {
    parts.push(`Target outcome: ${a.target_outcome.trim()}`);
  }
  return `[Intake] ${parts.join(". ")}.`;
}

/**
 * Mirror of the server-side `[Activity Intake]` synthesizer. Both sides
 * MUST produce the same string verbatim so the resolved-ask anchoring
 * (which matches answer.text against user message content) finds the
 * right user bubble both during live streaming and after reload.
 *
 * `lessonTitlesById` is built from the pending interrupt's `lessons_menu`
 * so the synthesized turn reads as `Lessons: B-tree fundamentals` instead
 * of `Lessons: 462c0654-…` (audit §2.3 fix #2). When a title is unknown
 * (toolless intake or stale menu) the synthesizer falls back to a short
 * id slice so the `[Activity Intake]` prefix marker stays parseable for
 * the activity agent's `runDecide`.
 */
function synthesizeActivityIntakeMessage(
  a: ActivityIntakeFormAnswer,
  lessonTitlesById: Record<string, string> = {},
): string {
  const parts: string[] = [];
  if (a.lesson_ids.length) {
    const labels = a.lesson_ids.map(
      (id) => lessonTitlesById[id] ?? id.slice(0, 8),
    );
    parts.push(`Lessons: ${labels.join(", ")}`);
  } else {
    parts.push("Lessons: (none \u2014 toolless)");
  }
  parts.push(`Difficulty: ${a.difficulty}`);
  parts.push(`MCQs: ${a.mcq_count}`);
  parts.push(`Short-answers: ${a.short_answer_count}`);
  parts.push(`Worked example: ${a.include_worked_example ? "yes" : "no"}`);
  parts.push(`Language: ${a.language}`);
  return `[Activity Intake] ${parts.join(" \u00b7 ")}`;
}

export function ChatPane({
  threadId,
  initialMessages,
  agent,
}: {
  threadId: string;
  initialMessages: MpfeUIMessage[];
  /**
   * Thread's agent kind. Drives the inline worksheet card's "MCP-grounded"
   * vs "no tools" badge — the chat pane otherwise treats all agents the
   * same. Optional for backwards compatibility (defaults to the syllabus
   * agent, which never produces inline worksheets anyway).
   */
  agent?: import("@mpfe/shared").AgentKind;
}) {
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
  const selectedWorksheetId = useAgentStore(
    (s) => s.selected_worksheet_activity_id,
  );
  const setSelectedWorksheet = useAgentStore((s) => s.setSelectedWorksheet);
  const setInterrupt = useAgentStore((s) => s.setInterrupt);
  const setInterruptHistory = useAgentStore((s) => s.setInterruptHistory);
  const setLatestRun = useAgentStore((s) => s.setLatestRun);
  const setResearchAnchorMsgIndex = useAgentStore(
    (s) => s.setResearchAnchorMsgIndex,
  );
  const setTodoAnchorMsgIndex = useAgentStore((s) => s.setTodoAnchorMsgIndex);
  const setDriverActive = useAgentStore((s) => s.setDriverActive);
  // Deep-agent canvas slices.
  const applyVfsUpdate = useAgentStore((s) => s.applyVfsUpdate);
  const upsertSubagentRun = useAgentStore((s) => s.upsertSubagentRun);
  const appendSubagentTextDelta = useAgentStore(
    (s) => s.appendSubagentTextDelta,
  );
  const upsertSubagentToolCall = useAgentStore(
    (s) => s.upsertSubagentToolCall,
  );
  // Live supervisor tool-call store actions. The realtime hook
  // populates these for follower tabs; the driver tab now also routes
  // through here so deepagent supervisor tool calls (write_todos, vfs
  // ops, task) render as cards in the main chat. Generic ToolCallCard
  // for non-task tools, dedicated TaskCard for `name === "task"`.
  const upsertLiveToolCall = useAgentStore((s) => s.upsertLiveToolCall);
  const finalizeLiveToolCallArgs = useAgentStore(
    (s) => s.finalizeLiveToolCallArgs,
  );
  const finalizeLiveToolCall = useAgentStore((s) => s.finalizeLiveToolCall);

  const phase = useAgentStore((s) => s.phase);
  const researchPlan = useAgentStore((s) => s.research_plan);
  const todoPlan = useAgentStore((s) => s.todo_plan);
  const interrupt = useAgentStore((s) => s.interrupt);
  const interruptHistory = useAgentStore((s) => s.interrupt_history);
  const activityWorksheets = useAgentStore((s) => s.activity_worksheets);
  const activityToolCalls = useAgentStore((s) => s.activity_tool_calls);
  const activityGenerationProgress = useAgentStore(
    (s) => s.activity_generation_progress,
  );
  const latestRun = useAgentStore((s) => s.latest_run);
  const researchAnchorMsgIndex = useAgentStore(
    (s) => s.research_anchor_msg_index,
  );
  const todoAnchorMsgIndex = useAgentStore((s) => s.todo_anchor_msg_index);
  // Live blocks for follower-tab rendering. Driver tabs receive the
  // same text via the v5 `text-delta` wire frame (which lands in
  // `messages[]`), and the realtime hook now consults the
  // `driver_active` flag in the agent store before mirroring
  // `assistant_text_delta` events into `live_text_blocks` — so the
  // duplicate render that the chat pane was previously papering over
  // (PR-D) can no longer happen on a healthy POST socket. Followers
  // (no POST in flight) and disconnect-recovery (driver POST socket
  // dropped, `resumeStream()` reattaching) both leave the flag false
  // and continue to populate this list. The live tool-call view is
  // populated for every tab (driver + follower) so the chip can
  // render args growing live regardless of who started the run.
  const liveTextBlocks = useAgentStore((s) => s.live_text_blocks);
  const liveToolCalls = useAgentStore((s) => s.live_tool_calls);

  // Refs let onError (which `useChat` may capture only once on mount)
  // call the latest resync logic without re-creating the chat hook.
  // useChat doesn't reconnect on its own when the SSE socket dies
  // mid-run (Railway/Cloudflare HTTP/2 edges close idle streams during
  // long LLM calls — ERR_HTTP2_PROTOCOL_ERROR / ERR_CONNECTION_RESET);
  // we recover by refetching /state and replaying messages, then the
  // separate GET /stream from agent-run-realtime resumes typed slices
  // from the persisted Redis cursor.
  const recoveringRef = useRef(false);
  const setMessagesRef = useRef<((m: MpfeUIMessage[]) => void) | null>(null);
  // Mirror of `useChat`'s current `messages` array. Used by
  // `resyncFromState` to compare /state against the live transcript
  // BEFORE deciding to call `setMessages`. The v5 `Chat` class clones
  // the array on assignment (`set messages(m) { this.#messages = [...m] }`)
  // and notifies all subscribers, which would unmount and remount every
  // <MessageRow> even when the content is byte-identical — re-running
  // the `animate-fade-in` class as a visible "re-flash" right after a
  // turn finishes streaming. Skipping the assignment entirely is the
  // only way to keep the live row mounted.
  const messagesRef = useRef<MpfeUIMessage[]>(initialMessages);
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  const resyncFromState = useCallback(async () => {
    if (recoveringRef.current) return;
    recoveringRef.current = true;
    try {
      const res = await fetch(
        `${API}/api/chat/${threadIdRef.current}/state`,
        { cache: "no-store" },
      );
      // Throw on non-OK so the caller's `.catch()` runs and falls
      // back to the toast — silently returning here would drop the
      // stream failure on the floor with zero UI feedback.
      if (!res.ok) {
        throw new Error(`/state returned ${res.status}`);
      }
      const state = (await res.json()) as {
        messages?: Array<{ role: string; content: string }>;
        latest_run?: RunSnapshot | null;
        research_anchor_msg_index?: number | null;
        todo_anchor_msg_index?: number | null;
      };
      // Canonical (role, text) pairs from /state. Tool messages carry
      // raw JSON tool-result strings — drop their text so the bubble
      // renders empty (and is then skipped by `MessageRow`). The chip
      // already represents the call + result in the chat. We keep the
      // entries in the array so server-side `anchor_msg_index`
      // pointers (worksheets, tool calls) still resolve.
      const canonical = (state.messages ?? []).map((m) => ({
        role: (m.role === "human" ? "user" : "assistant") as
          | "user"
          | "assistant",
        text: m.role === "tool" ? "" : m.content,
      }));
      // Reconciliation: only call `setMessages` when the live
      // transcript actually differs from /state. The `onFinish` resync
      // exists to split multi-AIMessage runs (e.g. the syllabus
      // supervisor's announcement + post-`command_finalize` wrap-up,
      // which the v5 wire merges into a single text-block) into
      // separate bubbles. For the common single-bubble case (and for
      // already-in-sync hydration on completed threads) the wire-
      // streamed messages already match /state byte-for-byte, and a
      // `setMessages(...)` call here would force a re-mount of every
      // <MessageRow> — re-running `animate-fade-in` and producing the
      // visible "double-render flash" right after the stream finishes.
      const live = messagesRef.current;
      let allMatch = live.length === canonical.length;
      if (allMatch) {
        for (let i = 0; i < canonical.length; i++) {
          if (
            live[i].role !== canonical[i].role ||
            getMessageText(live[i]) !== canonical[i].text
          ) {
            allMatch = false;
            break;
          }
        }
      }
      if (!allMatch) {
        // Slow path: structures differ (multi-AIMessage run, or the
        // local transcript drifted from canonical). Rebuild, but
        // reuse any existing id whose (role, text) matches at the
        // same index so already-rendered rows keep their DOM nodes
        // and skip the fade-in re-run.
        const next: MpfeUIMessage[] = canonical.map((c, i) => {
          const reuse =
            live[i] &&
            live[i].role === c.role &&
            getMessageText(live[i]) === c.text;
          return {
            id: reuse ? live[i].id : `hist-${i}`,
            role: c.role,
            parts: [{ type: "text", text: c.text }],
          };
        });
        setMessagesRef.current?.(next);
      }
      // Hydrate the card anchor indices from the persisted snapshot. Without
      // this, a freshly-loaded thread would have null anchors until the next
      // live event arrived — and for finished threads no live events ever
      // arrive, so the cards would render at the tail forever.
      setLatestRun(state.latest_run ?? null);
      setResearchAnchorMsgIndex(state.research_anchor_msg_index ?? null);
      setTodoAnchorMsgIndex(state.todo_anchor_msg_index ?? null);
      return state;
    } finally {
      recoveringRef.current = false;
    }
  }, [setLatestRun, setResearchAnchorMsgIndex, setTodoAnchorMsgIndex]);
  const resyncRef = useRef(resyncFromState);
  resyncRef.current = resyncFromState;

  // The v5 `useChat` hook no longer manages the input field — that
  // bookkeeping moved to the consumer. The state is local to this
  // component and reset to the empty string after `sendMessage`
  // succeeds, mirroring the v4 hook's old behavior.
  const [input, setInput] = useState("");
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setInput(e.target.value);
    },
    [],
  );

  // Stable transport instance: v5 splits HTTP plumbing out of `useChat`
  // into a `ChatTransport`. `DefaultChatTransport` posts UI messages as
  // `{ messages: UIMessage[] }` and consumes the v5 SSE wire format
  // we emit from `data-stream.ts`. Memoize against `threadId` so a
  // route-level remount picks the new chat endpoint without rebuilding
  // the transport every render.
  const transport = useMemo(
    () =>
      new DefaultChatTransport<MpfeUIMessage>({
        api: `${API}/api/chat/${threadId}`,
      }),
    [threadId],
  );

  const { messages, setMessages, sendMessage, status, stop } =
    useChat<MpfeUIMessage>({
      id: threadId,
      messages: initialMessages,
      transport,
      experimental_throttle: 50,
      onError: (e) => {
        // Mid-run socket reset on long LLM calls is the common case here;
        // the run is still alive server-side. Try a quick /state resync
        // instead of yelling at the user. If the run actually failed,
        // the realtime hook + agent_runs row will surface that as a
        // FailedRunCard, not a toast.
        resyncRef.current().catch(() => {
          toast.error("Stream error", {
            description: (e as Error).message,
          });
        });
      },
      onFinish: () => {
        // The v5 stream wraps every assistant turn in a single
        // `start` → `text-start`/`text-delta`/`text-end` → `finish`
        // bracket: there is no chunk in the protocol that splits a
        // turn into multiple bubbles mid-flight. When the supervisor
        // produces TWO `AIMessage`s in one run (the announcement
        // before `command` runs, and the wrap-up after
        // `command_finalize` routes back to supervisor) they get
        // concatenated into one bubble live, even though the
        // persisted graph state has them as two separate messages.
        //
        // We poll /state to reconcile, but `resyncFromState` now
        // diffs the canonical messages against the live transcript
        // and ONLY calls `setMessages` when something actually
        // differs. For the common single-bubble case (every activity
        // agent turn, every supervisor turn that didn't loop through
        // `command_finalize`) the live `messages[]` already matches
        // /state byte-for-byte, so we skip the assignment entirely
        // and avoid the unmount/remount that re-runs `animate-fade-in`
        // on every <MessageRow> — the visible "double-render" right
        // after the stream finishes.
        resyncRef.current().catch(() => {});
      },
      onData: (part) => {
        // v5 typed-data routing. Every `data-${kind}` chunk emitted by
        // `chat.controller.ts` arrives here as a `DataUIPart` with
        // `type: "data-<kind>"` and `data: <value>`. Each is also
        // server-marked `transient: true`, so they fire `onData` (this
        // callback) but never land in `messages[].parts` — exactly the
        // routing we want for the 13 typed agent-state slices, which
        // belong in Zustand keyed by `kind`, not in message history.
        switch (part.type) {
          case "data-phase":
            setPhase(part.data);
            break;
          case "data-research_plan":
            setResearchPlan(part.data);
            break;
          case "data-todo_plan":
            setTodoPlan(part.data);
            break;
          case "data-manifest":
            setManifest(part.data ?? []);
            break;
          case "data-activity_manifest":
            setActivityManifest(part.data ?? []);
            break;
          case "data-activity_tool_calls":
            setActivityToolCalls(part.data ?? []);
            break;
          case "data-activity_progress":
            setActivityGenerationProgress(part.data ?? null);
            break;
          case "data-activity_worksheets":
            setActivityWorksheets(part.data ?? []);
            break;
          case "data-interrupt":
            setInterrupt(part.data);
            break;
          case "data-interrupt_history":
            setInterruptHistory(part.data ?? []);
            break;
          case "data-run":
            // The SSE stream emits this on run create + terminal status.
            // The Realtime path also delivers it; the store dedupes by
            // (id, finished_at) so out-of-order arrivals can't downgrade.
            setLatestRun(part.data);
            break;
          case "data-research_anchor_msg_index":
            // Server-authoritative anchor for the ResearchCard. The
            // supervisor sets this when it commits a `search` decision,
            // so the index points at the AI bubble that triggered the
            // search. The FE renders the card right under that bubble.
            setResearchAnchorMsgIndex(part.data);
            break;
          case "data-todo_anchor_msg_index":
            // Same for the TodoCard — anchor under the supervisor's
            // "Here's your … syllabus!" bubble.
            setTodoAnchorMsgIndex(part.data);
            break;
          // Streaming-foundation delta kinds.
          //
          // Text deltas: the driver tab already consumes its text via
          // the v5 `text-delta` frame (routed into `useChat`'s
          // `messages[]`); the POST handler stops emitting
          // `data-assistant_text_delta` to the wire entirely (PR-B).
          // The case is kept for forward-compatibility and because the
          // GET /stream replay endpoint still re-emits these for
          // follower-tab consumption via `useAgentRunRealtime` (which
          // never funnels through this `onData`).
          case "data-assistant_text_delta":
          case "data-tool_call_arg_delta":
            break;
          // Tool-call deltas: deep-agent emits `tool_call_start` /
          // `tool_call_end` / `tool_result` for every supervisor tool
          // (`write_todos`, vfs ops, `task`). Route them to the same
          // `live_tool_calls` store the realtime hook populates so the
          // chat pane can render supervisor tool cards inline. Without
          // this, deepagent supervisor tool calls were silently dropped
          // on the driver tab (the tab that initiated the POST) and
          // only visible on a 2nd browser-tab follower — which made the
          // chat look like the supervisor wasn't doing anything.
          case "data-tool_call_start":
            if (part.data?.id && part.data.name) {
              upsertLiveToolCall({
                id: part.data.id,
                name: part.data.name,
                node: part.data.node ?? "",
                call_index: part.data.call_index ?? 0,
              });
            }
            break;
          case "data-tool_call_end":
            if (
              part.data?.id &&
              part.data.args &&
              typeof part.data.args === "object"
            ) {
              finalizeLiveToolCallArgs(
                part.data.id,
                part.data.args as Record<string, unknown>,
              );
            }
            break;
          case "data-tool_result":
            if (
              part.data?.id &&
              (part.data.status === "ok" || part.data.status === "error")
            ) {
              finalizeLiveToolCall(
                part.data.id,
                part.data.status,
                part.data.preview ?? null,
                part.data.duration_ms ?? null,
                part.data.error ?? null,
              );
            }
            break;
          // Deep-agent canvas slices. The driver tab consumes these
          // here; follower tabs consume the same payloads via the
          // GET /stream replay (`useAgentRunRealtime`).
          case "data-vfs_update":
            if (part.data) applyVfsUpdate(part.data);
            break;
          case "data-subagent_run":
            if (part.data) upsertSubagentRun(part.data);
            break;
          case "data-subagent_text_delta":
            // Live per-token thinking from a subagent. Routed by
            // call_id to the canvas Subagents row buffer. Never
            // feeds `useChat.messages[]` — the chat stays
            // supervisor-only.
            if (part.data) {
              const { call_id, block_id, delta } = part.data;
              if (call_id && block_id && delta) {
                appendSubagentTextDelta(call_id, block_id, delta);
              }
            }
            break;
          case "data-subagent_tool_call":
            // Nested tool call from a running subagent (writer's
            // `create_lesson`, researcher's `web_search`, etc.).
            // Routed to the canvas — never to the chat bubble.
            if (part.data) upsertSubagentToolCall(part.data);
            break;
          // `data-_keepalive` and `data-_cursor` are transport-only
          // kinds the chat pane intentionally ignores. The realtime
          // hook handles `_cursor`; `_keepalive` exists purely to
          // defeat edge buffering and the periodic heartbeat.
        }
      },
    });

  setMessagesRef.current = setMessages;
  // Keep the live-messages mirror up to date so `resyncFromState` can
  // compare against the freshest snapshot without reading from
  // `messages` (which would force the callback to re-create on every
  // delta and re-register `onError`/`onFinish`).
  messagesRef.current = messages;

  // v5 collapses `isLoading` into a 4-state `status` field. Keep the
  // ergonomic boolean alias so the rest of the component (button
  // disabling, loader spinner, scroll heuristics, hotkey handlers) keeps
  // reading a single flag without sprinkling status checks everywhere.
  const isLoading = status === "submitted" || status === "streaming";

  // Drive the global `driver_active` flag from the local POST socket's
  // status. The realtime hook reads this flag and skips its
  // `assistant_text_delta` → `live_text_blocks` mirror while the
  // driver is producing the same text into `useChat.messages[]` —
  // without this gate, every assistant token would land in TWO stores
  // simultaneously and render a duplicate `<LiveAssistantBubble>`
  // underneath the real bubble.
  //
  // The flag flips back to `false` the moment `useChat.status` leaves
  // streaming (terminal `ready`, error mid-stream, or stop), which
  // re-enables the mirror. That's exactly the right behaviour for the
  // PR-C reconnect path: during the disconnect window the realtime
  // hook keeps painting `live_text_blocks` so the bubble doesn't
  // freeze, and once `resumeStream()` reattaches and status returns
  // to `streaming`, we go back to the single-source `messages[]` view.
  // Cleanup on unmount resets the flag so a tab close while streaming
  // doesn't leave the global flag stuck on for the next mount.
  useEffect(() => {
    setDriverActive(isLoading);
    return () => setDriverActive(false);
  }, [isLoading, setDriverActive]);

  // Smart auto-scroll: only stick to bottom if the user hasn't scrolled up.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stickyRef = useRef(true);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickyRef.current = dist < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !stickyRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, researchPlan, todoPlan, interrupt, interruptHistory, isLoading]);

  // Submit a question answer as the next chat message.
  const submitAnswer = useCallback(
    (text: string) => {
      // Optimistically clear local interrupt; server re-emits null on resume.
      setInterrupt(null);
      void sendMessage({ text });
    },
    [sendMessage, setInterrupt],
  );

  // Submit a structured IntakeFormAnswer as the resume payload for an
  // `intake_form` interrupt. We pass it as `body.intake` so the API
  // takes the structured-resume path. The optimistic local content is
  // the SAME synthesized "[Intake] …" string the server appends to
  // graph messages — that way the resolved-ask anchoring (which
  // matches by verbatim answer.text) finds the right user bubble both
  // live and after reload.
  const submitIntake = useCallback(
    (answer: IntakeFormAnswer) => {
      setInterrupt(null);
      void sendMessage(
        { text: synthesizeIntakeMessage(answer) },
        { body: { intake: answer } },
      );
    },
    [sendMessage, setInterrupt],
  );

  // Activity-intake resume: same pattern as submitIntake but POSTs the
  // structured answer under `body.activity_intake` so the controller's
  // ActivityIntakeFormAnswer parser picks it up and routes through
  // `resolveLatestActivityIntake`. The optimistic content uses lesson
  // titles from the pending interrupt's `lessons_menu` so the live
  // resolved card matches the eventual server-synthesized one byte for
  // byte (audit §2.3 fix #2).
  const submitActivityIntake = useCallback(
    (answer: ActivityIntakeFormAnswer) => {
      const titlesById: Record<string, string> = {};
      const menu = interrupt?.activity_intake?.lessons_menu ?? [];
      for (const opt of menu) titlesById[opt.id] = opt.title;
      setInterrupt(null);
      void sendMessage(
        { text: synthesizeActivityIntakeMessage(answer, titlesById) },
        { body: { activity_intake: answer } },
      );
    },
    [sendMessage, setInterrupt, interrupt],
  );

  // Effective busy flag: this tab's SSE is streaming OR the server-side
  // run is still active. The second part covers reload-mid-run and
  // cross-tab visibility — without it, the input would un-disable after
  // reload even though the agent is still working.
  const isRunning =
    isLoading ||
    latestRun?.status === "running" ||
    latestRun?.status === "queued";
  const isStopping =
    !!stoppingRunId &&
    latestRun?.id === stoppingRunId &&
    (latestRun.status === "running" || latestRun.status === "queued");
  // Has the most recent run failed? Surface a banner + retry button. Only
  // show when we're NOT currently running a new turn (the new run
  // supersedes the old failure). For the retry target, prefer the message
  // visible in this tab's transcript; fall back to `agent_runs.user_message`
  // (always populated server-side) so threads whose checkpoint doesn't
  // hydrate any messages on /state — e.g. older runs whose state was
  // truncated, or runs that failed before the first user message landed in
  // the checkpoint — still get a usable Retry button.
  const lastUserMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        const text = getMessageText(messages[i]);
        if (text.length > 0) return text;
      }
    }
    return null;
  }, [messages]);
  const retryTarget = lastUserMessage ?? latestRun?.user_message ?? null;
  const showFailedCard = latestRun?.status === "failed" && !isRunning;
  useEffect(() => {
    if (!stoppingRunId) return;
    if (latestRun?.id !== stoppingRunId) {
      setStoppingRunId(null);
      return;
    }
    if (latestRun.status !== "running" && latestRun.status !== "queued") {
      setStoppingRunId(null);
    }
  }, [latestRun, stoppingRunId]);
  const onRetry = useCallback(() => {
    if (!retryTarget) return;
    // `retry: true` tells the BE this is a re-post of a freshly failed
    // run rather than a brand-new user turn. Without the flag the
    // controller would `runs.create` + append another HumanMessage to
    // `state.messages`, leaving the supervisor with a `[…, human, human]`
    // history. With the flag set, the BE verifies (a) the latest run
    // is `failed`, (b) its `user_message` matches what we just posted,
    // and (c) the LangGraph checkpoint already carries that message
    // at its tail — and only then resumes the graph from the existing
    // checkpoint. Falls through to the normal append-and-rerun path
    // when the preconditions don't hold, so retry is always at worst
    // equivalent to the old behaviour.
    void sendMessage({ text: retryTarget }, { body: { retry: true } });
  }, [sendMessage, retryTarget]);

  // Position helpers for inline AskCard anchoring.
  const lastAssistantIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return i;
    }
    return -1;
  }, [messages]);

  // Inline anchors for the Research / Todo cards. Each card renders
  // directly under the AI bubble that triggered it (the supervisor's
  // "Researching…" / "Here's your … syllabus!" message) instead of at
  // the tail of the transcript, where a wrap-up reply or a follow-up
  // turn would push them out of context and make them look deleted.
  //
  // Anchor source: the server captures `state.messages.length` at the
  // moment the supervisor commits a `search` / `write` decision (see
  // graph/state.ts). That index is persisted in the LangGraph
  // checkpoint, mirrored to Redis, and replayed in BOTH `/state`
  // hydration and the live SSE stream — so the anchor survives reload
  // identically to how it appeared during the live run. We resolve
  // the index → message id at render time. If `messages[index]` is
  // missing (stream still catching up, or stale checkpoint past the
  // current message length), the tail fallback kicks in below.
  // Audit §3.6 — anchor maps key on `messages.length` rather than the
  // full `messages` reference so the streaming token loop (which
  // replaces the array reference on every delta to extend the last
  // assistant message's content) doesn't invalidate these memos. A
  // message's id never changes after creation, so reading
  // `messages[anchorIndex]?.id` at evaluation time is safe.
  const researchAnchorId = useMemo(() => {
    if (researchAnchorMsgIndex == null) return null;
    return messages[researchAnchorMsgIndex]?.id ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, researchAnchorMsgIndex]);
  const todoAnchorId = useMemo(() => {
    if (todoAnchorMsgIndex == null) return null;
    return messages[todoAnchorMsgIndex]?.id ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, todoAnchorMsgIndex]);

  // A signature that flips whenever the messages array is meaningfully
  // replaced (new message appended, or hydrate / resync swapped the
  // ids). Keying anchor maps on `messages.length` alone misses the
  // case where the resync substitutes the live `msg-XXX` ids with
  // hydrated `hist-N` ids without changing the array length — e.g.
  // a worksheet emission whose anchor index lands on a message
  // that's the same length away from the start in both views.
  // Concatenating first + last id is O(1) and stable across the
  // streaming lifecycle.
  const messagesIdentitySig = useMemo(() => {
    if (messages.length === 0) return "";
    return `${messages[0]!.id}|${messages[messages.length - 1]!.id}|${messages.length}`;
  }, [messages]);

  // Inline worksheet emissions, grouped by their anchor message id. Each
  // entry's `anchor_msg_index` points at the AIMessage where the
  // `emit_worksheet` tool call landed; we resolve to the FE message id
  // so the inline `<ActivityWorksheet>` renders under the same bubble
  // both during live streaming and after reload. Worksheets whose
  // anchor index is null or out of range fall through to the tail
  // fallback further down so they're never silently dropped.
  const { worksheetsByAnchorId, unanchoredWorksheets } = useMemo(() => {
    const map = new Map<string, typeof activityWorksheets>();
    const orphans: typeof activityWorksheets = [];
    for (const w of activityWorksheets) {
      if (w.anchor_msg_index == null) {
        orphans.push(w);
        continue;
      }
      const m = messages[w.anchor_msg_index];
      if (!m) {
        orphans.push(w);
        continue;
      }
      const arr = map.get(m.id) ?? [];
      arr.push(w);
      map.set(m.id, arr);
    }
    return { worksheetsByAnchorId: map, unanchoredWorksheets: orphans };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityWorksheets, messagesIdentitySig]);

  // Inline tool calls, grouped by the AIMessage that issued them. The
  // backend pins each ActivityToolCall.anchor_msg_index to the AI turn
  // that produced the call; we render a chip directly under that turn
  // (BEENET-style chronology) instead of aggregating every call in a
  // single rail at the tail of the conversation. Calls without an
  // anchor index — or whose anchor message is no longer in the array —
  // fall through to a tail block so chips are never silently dropped.
  const { toolCallsByAnchorId, unanchoredToolCalls } = useMemo(() => {
    const map = new Map<string, ActivityToolCall[]>();
    const orphans: ActivityToolCall[] = [];
    for (const call of activityToolCalls) {
      if (call.anchor_msg_index == null) {
        orphans.push(call);
        continue;
      }
      const m = messages[call.anchor_msg_index];
      if (!m) {
        orphans.push(call);
        continue;
      }
      const arr = map.get(m.id) ?? [];
      arr.push(call);
      map.set(m.id, arr);
    }
    return { toolCallsByAnchorId: map, unanchoredToolCalls: orphans };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityToolCalls, messagesIdentitySig]);

  // Same anchor-grouping for the deep-agent supervisor's live tool
  // calls (write_todos, vfs ops, `task`). The /state hydration walks
  // the LangGraph checkpoint and stamps `anchor_msg_index` on every
  // chip so reload renders inline; live wire frames don't (the FE
  // can't reliably compute the index mid-stream — the supervisor may
  // emit the tool call BEFORE any text reaches `messages[]`), so
  // those land in the tail block until /state resync upgrades them.
  const { liveToolCallsByAnchorId, unanchoredLiveToolCalls } = useMemo(() => {
    const map = new Map<
      string,
      import("../../stores/agent-store").LiveToolCall[]
    >();
    const orphans: import("../../stores/agent-store").LiveToolCall[] = [];
    for (const call of liveToolCalls) {
      if (call.anchor_msg_index == null) {
        orphans.push(call);
        continue;
      }
      const m = messages[call.anchor_msg_index];
      if (!m) {
        orphans.push(call);
        continue;
      }
      const arr = map.get(m.id) ?? [];
      arr.push(call);
      map.set(m.id, arr);
    }
    return {
      liveToolCallsByAnchorId: map,
      unanchoredLiveToolCalls: orphans,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveToolCalls, messagesIdentitySig]);

  // For each resolved ask, find the user message that holds the answer
  // (the FE wires answers via `append({role:'user', content: answer.text})`,
  // so equality is reliable in the common case). Walk a cursor so identical
  // answer texts don't all collide on the first occurrence. The resolved
  // card renders *before* the user message that answered it, which means
  // it sits right after the assistant turn that asked.
  //
  // Asymmetry: the API trims the answer before storing it on `interrupt`
  // (graph.service.ts trims `answer.text`), but the message text from the
  // checkpoint is stored verbatim. Compare both raw and trimmed so an
  // answer typed via the main chat input with stray whitespace still
  // anchors. Anything still unmatched falls back to a tail block below so
  // the resolved Q&A trail is never silently dropped.
  // Indices of user messages that hold the synthesized intake / activity
  // intake answer. The resolved-card mirror (rendered above each entry
  // in `resolvedByMessageIndex` below) already shows the synthesized
  // text in a richer card format — rendering the same string in a
  // user bubble right beneath duplicates it. Audit §2.3 fix #1: hide
  // the bubble for `intake_form` and `activity_intake` resolutions so
  // the card is the single source of truth for that turn. Freeform
  // `ask` answers still render as user bubbles (the answer is short
  // and reads naturally there).
  const { resolvedByMessageIndex, unanchoredResolved } = useMemo(() => {
    const map = new Map<number, AgentInterrupt>();
    const orphans: AgentInterrupt[] = [];
    let cursor = 0;
    for (const itr of interruptHistory) {
      if (!itr.answer) continue;
      const target = itr.answer.text;
      const targetTrimmed = target.trim();
      let found = -1;
      for (let i = cursor; i < messages.length; i++) {
        const m = messages[i];
        if (m.role !== "user") continue;
        const mText = getMessageText(m);
        if (mText === target || mText.trim() === targetTrimmed) {
          found = i;
          break;
        }
      }
      if (found >= 0) {
        map.set(found, itr);
        cursor = found + 1;
      } else {
        orphans.push(itr);
      }
    }
    return { resolvedByMessageIndex: map, unanchoredResolved: orphans };
    // §3.6 — user-message text doesn't stream (only assistant content
    // grows token-by-token), so once a user message exists at an
    // index its content is stable. Keying on `messages.length` +
    // `interruptHistory.length` is sufficient to detect "new bubble"
    // / "new resolved interrupt" without invalidating on every
    // streamed assistant token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interruptHistory.length, messages.length]);

  // Inline placeholder hints that appear during long phases. These render as
  // "soft" cards in the transcript — feels like Perplexity's progress UI.
  const phaseHint = useMemo(() => phaseToHint(phase, isLoading), [phase, isLoading]);

  return (
    <section className="flex h-full flex-col bg-[var(--background)]">
      <header className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-[var(--primary)]/15 ring-1 ring-[var(--primary)]/30">
            <Bot className="h-3.5 w-3.5 text-[var(--primary)]" />
          </span>
          <div className="flex flex-col leading-tight">
            <span className="text-[13px] font-semibold">Conversation</span>
            <span className="text-[10.5px] text-[var(--muted-foreground)]">
              thread <span className="font-mono">{threadId.slice(0, 8)}</span>
            </span>
          </div>
        </div>
        <RunBadge run={latestRun} phase={phase} loading={isLoading} />
      </header>

      <div
        ref={scrollerRef}
        className="flex-1 space-y-4 overflow-y-auto px-4 py-4"
      >
        {messages.length === 0 &&
        !researchPlan &&
        !todoPlan &&
        !interrupt &&
        !interruptHistory.length ? (
          <EmptyState agent={agent} />
        ) : null}

        {messages.map((m, i) => {
          // Anchor each resolved interrupt to the assistant turn that asked it.
          // Match by exact answer text (the user's reply was appended via
          // `append({role:'user', content: text})`, so the answer text equals
          // a human message verbatim) and walk a cursor forward so duplicate
          // answer texts don't all attach to the first occurrence.
          const resolvedHere = resolvedByMessageIndex.get(i);
          // Suppress the user bubble for intake resolutions — the resolved
          // card above this row already shows the synthesized text and
          // rendering the bubble too is the dup the audit calls out.
          const suppressBubble =
            resolvedHere &&
            (resolvedHere.kind === "intake_form" ||
              resolvedHere.kind === "activity_intake");
          // Live (unanswered) AskCard renders directly under the LAST assistant
          // message — that's always the turn that issued the ask, since the
          // graph pauses on the supervisor's `ask` decision.
          const liveHere =
            interrupt && i === lastAssistantIndex && m.role === "assistant";
          // Research / Todo cards anchor to the assistant message that
          // triggered the corresponding subgraph. Pinning them inline
          // (rather than at the tail) keeps the progress in
          // chronological context after the supervisor's wrap-up reply
          // and across multi-turn threads with multiple builds.
          const researchHere =
            researchPlan && researchAnchorId === m.id;
          const todoHere = todoPlan && todoAnchorId === m.id;
          const worksheetsHere = worksheetsByAnchorId.get(m.id) ?? [];
          const toolCallsHere = toolCallsByAnchorId.get(m.id) ?? [];
          const liveToolCallsHere = liveToolCallsByAnchorId.get(m.id) ?? [];
          // Activity threads represent every tool-call-only AI turn as
          // an empty assistant bubble. Hide that empty bubble so the
          // tool chips below tell the whole story (BEENET-style:
          // "agent decided → tool ran"); the chip already conveys the
          // intent. We KEEP the message in the array for anchor-index
          // resolution and only skip the visual `MessageRow` render.
          const isEmptyBubble =
            m.role === "assistant" && getMessageText(m).trim() === "";
          // Same for the worksheet's emit_worksheet ToolMessage: its
          // text is the synthetic "worksheet emitted (...)" string we
          // wrote on the API side. Match by tool-call presence rather
          // than substring so future tool-message variants stay
          // hidden. Tool calls anchored here imply this turn is the
          // AIMessage that issued them — the next message is the
          // ToolMessage(s); skip those by checking they're not the
          // user/non-empty assistant.
          return (
            <Fragment key={m.id}>
              {resolvedHere ? <ResolvedAskInline entry={resolvedHere} /> : null}
              {suppressBubble || isEmptyBubble ? null : (
                <MessageRow message={m} agent={agent} />
              )}
              {toolCallsHere.length > 0 ? (
                <InlineToolCalls
                  calls={toolCallsHere}
                  worksheets={activityWorksheets}
                  agent={agent}
                  selectedWorksheetId={selectedWorksheetId}
                  onSelectWorksheet={setSelectedWorksheet}
                />
              ) : null}
              {liveToolCallsHere.length > 0 ? (
                <InlineLiveToolCalls calls={liveToolCallsHere} />
              ) : null}
              {researchHere ? <ResearchCard plan={researchPlan} /> : null}
              {todoHere ? <TodoCard plan={todoPlan} /> : null}
              {agent === "activity-generator-tooled"
                ? null
                : worksheetsHere
                    .filter(
                      (w) =>
                        // Skip worksheets already rendered by the inline
                        // emit_worksheet chip above (which renders an
                        // EmitWorksheetToolRow card with the worksheet
                        // attached). Otherwise we'd double-render the
                        // worksheet — once from the chip, once here.
                        !toolCallsHere.some(
                          (c) =>
                            c.name === "emit_worksheet" &&
                            c.args.activity_id === w.activity_id,
                        ),
                    )
                    .map((w) => (
                      <InlineWorksheetCard
                        key={w.activity_id}
                        emission={w}
                        threadId={threadId}
                        agent={agent}
                        selected={selectedWorksheetId === w.activity_id}
                        onSelect={() => setSelectedWorksheet(w.activity_id)}
                      />
                    ))}
              {liveHere ? (
                interrupt.kind === "intake_form" ? (
                  <IntakeCard
                    interrupt={interrupt}
                    disabled={isLoading}
                    onSubmit={submitIntake}
                  />
                ) : interrupt.kind === "activity_intake" ? (
                  <ActivityIntakeCard
                    interrupt={interrupt}
                    disabled={isLoading}
                    onSubmit={submitActivityIntake}
                  />
                ) : (
                  <AskCard
                    interrupt={interrupt}
                    disabled={isLoading}
                    onAnswer={submitAnswer}
                  />
                )
              ) : null}
            </Fragment>
          );
        })}

        {/* Live text bubbles for follower tabs / disconnect-recovery.
            Driver tabs render this text via `useChat`'s `messages[]`
            (text-delta frames land directly in the array). The
            realtime hook checks the `driver_active` flag (set from
            this pane's `useChat.status`) and skips its
            `assistant_text_delta` mirror while the driver is healthy,
            so this list stays empty on the driver during a normal
            POST stream — no duplicate `<LiveAssistantBubble>`
            underneath the real bubble. It re-fills on a follower
            tab (no POST in flight) or on the driver during a
            connectivity gap (POST socket dropped, `resumeStream()`
            reattaching). Each entry corresponds to one assistant
            bubble (the supervisor minted a fresh blockId per node
            entry — see chat.controller.ts), so multi-bubble runs
            render as multiple bubbles, not one merged stream.
            Cleared the moment the final `assistant_text` lands on
            the wire. */}
        {liveTextBlocks.length ? (
          <div className="flex flex-col gap-2">
            {liveTextBlocks.map((b) => (
              <LiveAssistantBubble key={b.blockId} text={b.text} agent={agent} />
            ))}
          </div>
        ) : null}

        {/* Fallback for resolved interrupts whose answer text didn't match
            any user message verbatim (e.g. the message store rehydrated a
            different rendering of the answer). Render them at the bottom so
            the Q&A trail is never silently dropped — same behaviour as
            the old AskHistory tail block. */}
        {unanchoredResolved.length ? (
          <div className="flex flex-col gap-2">
            {unanchoredResolved.map((e) => (
              <ResolvedAskInline key={e.id} entry={e} />
            ))}
          </div>
        ) : null}

        {/* Fallback for the live AskCard when there is no assistant turn to
            anchor it under yet — e.g. the supervisor produced an interrupt
            but `extractLatestAiText` returned no text on this turn, or the
            ask arrived from a non-supervisor node. Without this, the user
            would see no question and no suggestions. Anchored render above
            takes precedence whenever an assistant message exists. */}
        {interrupt && lastAssistantIndex === -1 ? (
          interrupt.kind === "intake_form" ? (
            <IntakeCard
              interrupt={interrupt}
              disabled={isLoading}
              onSubmit={submitIntake}
            />
          ) : interrupt.kind === "activity_intake" ? (
            <ActivityIntakeCard
              interrupt={interrupt}
              disabled={isLoading}
              onSubmit={submitActivityIntake}
            />
          ) : (
            <AskCard
              interrupt={interrupt}
              disabled={isLoading}
              onAnswer={submitAnswer}
            />
          )
        ) : null}

        {/* Tail fallback for progress cards that didn't get anchored —
            either there was no assistant message yet when the plan
            first appeared, or the assistant message that anchored it
            was evicted (very long threads). Without this fallback the
            user would see a phase indicator but no card. The anchored
            render above takes precedence whenever the anchor message
            still exists. */}
        {researchPlan &&
        (!researchAnchorId ||
          !messages.some((m) => m.id === researchAnchorId)) ? (
          <ResearchCard plan={researchPlan} />
        ) : null}
        {todoPlan &&
        (!todoAnchorId ||
          !messages.some((m) => m.id === todoAnchorId)) ? (
          <TodoCard plan={todoPlan} />
        ) : null}

        {/* Tail fallback for tool calls that lost their anchor (legacy
            entries persisted before `anchor_msg_index` existed, or
            calls whose anchor message was evicted from the array).
            Inline rendering above is the primary path; this just
            ensures chips are never silently dropped. */}
        {unanchoredToolCalls.length > 0 ? (
          <InlineToolCalls
            calls={unanchoredToolCalls}
            worksheets={activityWorksheets}
            agent={agent}
            selectedWorksheetId={selectedWorksheetId}
            onSelectWorksheet={setSelectedWorksheet}
          />
        ) : null}

        {/* Tail block for live tool-call chips that haven't been
            anchored to a specific AI bubble yet. During a deepagent
            run the supervisor commonly emits a tool call BEFORE any
            text reaches `messages[]` (a tool-only AIMessage carries
            empty content), so the FE has no reliable index to anchor
            to until /state resync upgrades it. Filtered against
            `activityToolCalls` by id so the legacy chip rendering
            (which already shows the same calls for activity threads)
            doesn't double-up. */}
        {unanchoredLiveToolCalls.filter(
          (c) => !activityToolCalls.some((existing) => existing.id === c.id),
        ).length > 0 ? (
          <div className="flex flex-col gap-2">
            {unanchoredLiveToolCalls
              .filter(
                (c) =>
                  !activityToolCalls.some(
                    (existing) => existing.id === c.id,
                  ),
              )
              .map((c) =>
                c.name === "task" ? (
                  <TaskCard key={c.id} call={c} />
                ) : (
                  <LiveToolCallChipCard key={c.id} call={c} />
                ),
              )}
          </div>
        ) : null}

        {/* Tail fallback for worksheets whose anchor message vanished or
            was never set. Toolless mode renders these as full
            InlineWorksheetCards; tooled mode already shows the
            worksheet via its inline emit_worksheet chip above so we
            skip the duplicate. */}
        {agent === "activity-generator-tooled"
          ? null
          : unanchoredWorksheets.map((w) => (
              <InlineWorksheetCard
                key={w.activity_id}
                emission={w}
                threadId={threadId}
                agent={agent}
                selected={selectedWorksheetId === w.activity_id}
                onSelect={() => setSelectedWorksheet(w.activity_id)}
              />
            ))}

        {phaseHint ? (
          <div className="flex items-center gap-2 px-1 text-[12px] text-[var(--muted-foreground)] animate-fade-in">
            <Loader2 className="h-3 w-3 animate-spin text-[var(--primary)]" />
            <span>{phaseHint}</span>
          </div>
        ) : null}

        {showFailedCard ? (
          <FailedRunCard
            run={latestRun!}
            onRetry={retryTarget ? onRetry : null}
          />
        ) : null}
      </div>

      <AgentStatusPill
        phase={phase}
        isLoading={isLoading}
        isRunning={isRunning}
        isStopping={isStopping}
        runStatus={latestRun?.status ?? null}
        hasInterrupt={!!interrupt}
        agent={agent}
        activityProgress={activityGenerationProgress}
      />

      <form
        onSubmit={(e) => {
          // v5 useChat dropped the `handleSubmit` helper; recreate the
          // legacy form-submit semantics here. Empty / whitespace-only
          // input is a no-op (matches the v4 behavior the rest of the
          // pane assumes), and we clear the local input state on
          // success so the user can start typing again.
          e.preventDefault();
          const text = input.trim();
          if (!text) return;
          if (isRunning) return;
          void sendMessage({ text });
          setInput("");
        }}
        className="flex shrink-0 items-end gap-2 border-t border-[var(--border)] bg-[var(--card)]/40 px-3 py-3"
      >
        <input
          value={input}
          onChange={handleInputChange}
          placeholder={
            interrupt
              ? "Pick an option above or type your own answer…"
              : isRunning
                ? isLoading
                  ? "Agent is working…"
                  : "Agent is working in another session…"
                : "Send a message…"
          }
          className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[13.5px] outline-none transition focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]/40 placeholder:text-[var(--muted-foreground)] disabled:cursor-not-allowed"
          // Gate on actual server-side activity, not just the local SSE
          // flag. Without this, a reload mid-run leaves the input
          // enabled and the user can fire a second turn that races the
          // in-flight run.
          disabled={isRunning}
          title={
            isRunning && !isLoading
              ? "An agent run is still active for this thread (likely another tab). Wait for it to finish before sending."
              : undefined
          }
        />
        {isLoading || isRunning ? (
          <button
            type="button"
            onClick={async () => {
              // Two-step cancel:
              //   1. Tell the server to abort the run (in-process
              //      AbortController owned by RunRegistry → graph
              //      cancels at next node boundary).
              //   2. Close the local SSE fetch for instant UX feedback.
              // Closing the local fetch alone is NOT enough: the server
              // intentionally treats a `req.close` as "client just
              // disconnected, keep working" so navigations / tab
              // closes don't cancel the agent. Explicit Stop must go
              // through the cancel endpoint.
              const runId = latestRun?.id;
              if (runId) setStoppingRunId(runId);
              if (runId) {
                try {
                  const res = await fetch(
                    `${API}/api/chat/${threadId}/runs/${runId}/cancel`,
                    { method: "POST" },
                  );
                  if (!res.ok) throw new Error(`HTTP ${res.status}`);
                } catch {
                  setStoppingRunId(null);
                  toast.error("Could not stop the run", {
                    description:
                      "The run may have already finished. Refresh if the status does not update.",
                  });
                }
              }
              try {
                stop();
              } catch {
                // ignore
              }
              if (runId) {
                void (async () => {
                  for (let i = 0; i < 20; i++) {
                    const state = await resyncRef.current().catch(() => null);
                    const run = state?.latest_run;
                    if (
                      run?.id === runId &&
                      run.status !== "running" &&
                      run.status !== "queued"
                    ) {
                      return;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                  }
                })();
              }
            }}
            disabled={isStopping}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-[12.5px] text-[var(--muted-foreground)] transition hover:border-[var(--destructive)] hover:text-[var(--destructive)] disabled:cursor-wait disabled:opacity-70"
          >
            {isStopping ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Square className="h-3.5 w-3.5" />
            )}
            {isStopping ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim() || isRunning}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 py-2 text-[var(--primary-foreground)] shadow-[0_4px_16px_-8px_rgba(246,110,96,0.7)] transition hover:opacity-95 disabled:opacity-50"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        )}
      </form>
    </section>
  );
}

/**
 * Synthetic assistant bubble for follower tabs while a turn is
 * still streaming. Shape-matched to the `assistant` branch of
 * `MessageRow` (avatar, max-width, rounded corner, markdown body)
 * so it sits seamlessly in the message list. Adds a small
 * "blinking" caret span to telegraph "still typing" — that's the
 * only visual signal that distinguishes a live block from a
 * persisted bubble. The block is removed the moment the final
 * `assistant_text` lands on the wire (see realtime hook).
 */
// Artifact cards (Bolt-style inline `<artifact …/>` tags) are a
// Deep-Agent-only feature. Other agents never emit them, but to make
// the contract explicit (and bullet-proof against a model leak
// producing the literal string in a syllabus / activity reply) we
// only run the parser when `agent === "deepagent"`. Everywhere else
// we fall back to plain `Markdown` exactly as before.
function LiveAssistantBubble({
  text,
  agent,
}: {
  text: string;
  agent?: import("@mpfe/shared").AgentKind;
}) {
  if (!text) return null;
  return (
    <div className="flex animate-fade-in flex-row gap-2">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--primary)]/40 bg-[var(--primary)]/15">
        <Bot className="h-3.5 w-3.5 text-[var(--primary)]" />
      </div>
      <div className="max-w-[78%] rounded-2xl rounded-tl-sm border border-[var(--border)] bg-[var(--card)] px-3.5 py-2.5 text-[13.5px] leading-relaxed text-[var(--foreground)]/95 shadow-sm">
        {agent === "deepagent" ? (
          <MarkdownWithArtifacts source={text} />
        ) : (
          <Markdown source={text} />
        )}
        <span className="ml-0.5 inline-block h-3 w-1 animate-pulse rounded-sm bg-[var(--primary)]/50 align-text-bottom" />
      </div>
    </div>
  );
}

/**
 * Inline rendering of supervisor tool calls anchored under the
 * AI bubble that issued them. `task` calls get a dedicated
 * `TaskCard` (subagent name + description + canvas link); every
 * other tool (write_todos, vfs ops) renders as the generic
 * `LiveToolCallChip`.
 */
function InlineLiveToolCalls({
  calls,
}: {
  calls: import("../../stores/agent-store").LiveToolCall[];
}) {
  // Indent + clamp width so the cards line up under the assistant
  // bubble's avatar (`h-7 w-7` + `gap-2` ≈ 36px ≈ `ml-9`) and don't
  // overflow past the bubble's right edge on narrow viewports —
  // matches the activity-tool-call layout. Without this the cards
  // ran the full chat-pane width and looked visually disconnected
  // from the AI turn that issued them, which is the "not well
  // aligned" complaint the deep-agent thread page was getting on
  // mobile.
  return (
    <div className="ml-9 flex max-w-[calc(100%-2.25rem)] flex-col gap-2 sm:max-w-[78%]">
      {calls.map((c) =>
        c.name === "task" ? (
          <TaskCard key={c.id} call={c} />
        ) : (
          <LiveToolCallChipCard key={c.id} call={c} />
        ),
      )}
    </div>
  );
}

/**
 * Dedicated card for supervisor `task` tool calls — the deepagent
 * supervisor's "delegate to a subagent" primitive. Shows which
 * subagent was dispatched, the description the supervisor asked it
 * to handle, and a status pill. Clicking the card reveals the
 * matching subagent run in the canvas (workbench) — on desktop the
 * canvas is already side-by-side so we just scroll/highlight the
 * row; on mobile the parent view should switch to the canvas tab.
 *
 * The `id` of the live tool call equals the `call_id` of the
 * matching `subagent_run` in `useAgentStore.subagent_runs`, so the
 * canvas can find the row in O(1) by id.
 */
function TaskCard({
  call,
}: {
  call: import("../../stores/agent-store").LiveToolCall;
}) {
  const requestCanvasFocus = useAgentStore((s) => s.requestCanvasFocus);
  const subagentName =
    typeof call.args?.subagent_type === "string"
      ? (call.args.subagent_type as string)
      : "subagent";
  const description =
    typeof call.args?.description === "string"
      ? (call.args.description as string)
      : null;
  const statusLabel =
    call.status === "calling"
      ? "dispatching…"
      : call.status === "ok"
        ? "completed"
        : "failed";
  const statusColor =
    call.status === "calling"
      ? "bg-[var(--primary)]/15 text-[var(--primary)]"
      : call.status === "ok"
        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
        : "bg-red-500/15 text-red-600 dark:text-red-400";
  const handleClick = () => {
    // Single signal that the user wants to inspect this subagent
    // run on the canvas. Bumps `canvas_focus_request.counter` so
    // (a) `deepagent-view` flips its mobile `Chat | Canvas`
    // switcher to "canvas" — previously this click was silent on
    // mobile because the canvas pane was hidden behind the chat
    // tab — and (b) `deepagent-canvas` switches its inner tab to
    // "subagents" and scrolls the matching `<SubagentRunRow>` into
    // view via the rAF inside its focus effect.
    requestCanvasFocus({
      kind: "subagents",
      subagent_call_id: call.id,
    });
  };
  return (
    <button
      type="button"
      onClick={handleClick}
      className="flex w-full animate-fade-in cursor-pointer flex-col gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2.5 text-left text-[12.5px] transition hover:border-[var(--primary)]/40 hover:bg-[var(--card)]/80"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Bot className="h-3.5 w-3.5 shrink-0 text-[var(--primary)]" />
        <span className="min-w-0 truncate font-medium text-[var(--foreground)]">
          {subagentName}
        </span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${statusColor}`}
        >
          {statusLabel}
        </span>
        <span className="ml-auto hidden shrink-0 text-[11px] text-[var(--muted-foreground)] sm:inline">
          open in workbench →
        </span>
      </div>
      {description ? (
        <div className="line-clamp-2 text-[12px] text-[var(--muted-foreground)]">
          {description}
        </div>
      ) : null}
      {call.preview ? (
        <div className="border-t border-[var(--border)] pt-1.5 text-[11.5px] text-[var(--muted-foreground)]">
          <span className="font-medium text-[var(--foreground)]">
            result:
          </span>{" "}
          {call.preview}
        </div>
      ) : null}
    </button>
  );
}

function MessageRow({
  message,
  agent,
}: {
  message: MpfeUIMessage;
  agent?: import("@mpfe/shared").AgentKind;
}) {
  const text = getMessageText(message);
  const isUser = message.role === "user";
  // Skip empty assistant rows entirely. Tool-call-only AIMessages and
  // hydrated ToolMessages both serialise to empty text; rendering an
  // empty bubble for them was the long-standing visual noise (see the
  // `isEmptyBubble` filter at the call site). The render-loop also
  // pre-filters with `isEmptyBubble`, but keeping the guard here is
  // belt-and-braces: any future caller of MessageRow that forgets the
  // outer check still won't render a stray empty bubble.
  if (!isUser && text.trim() === "") return null;
  return (
    <div
      className={
        "flex animate-fade-in gap-2 " +
        (isUser ? "flex-row-reverse" : "flex-row")
      }
    >
      <div
        className={
          "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border " +
          (isUser
            ? "border-[var(--secondary)]/40 bg-[var(--secondary)]/15"
            : "border-[var(--primary)]/40 bg-[var(--primary)]/15")
        }
      >
        {isUser ? (
          <UserIcon className="h-3.5 w-3.5 text-[var(--secondary)]" />
        ) : (
          <Bot className="h-3.5 w-3.5 text-[var(--primary)]" />
        )}
      </div>
      <div
        className={
          "max-w-[78%] rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-relaxed shadow-sm " +
          (isUser
            ? "rounded-tr-sm bg-[var(--primary)]/15 text-[var(--foreground)] ring-1 ring-[var(--primary)]/25"
            : "rounded-tl-sm border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)]/95")
        }
      >
        {isUser || agent !== "deepagent" ? (
          <Markdown source={text} />
        ) : (
          <MarkdownWithArtifacts source={text} />
        )}
      </div>
    </div>
  );
}

// Per-agent empty-state copy. Audit §3.4 — the previous single string
// ("Ask the agent to build a syllabus.") was literally wrong on
// activity-tooled threads (the agent there cannot build a syllabus,
// it picks an existing lesson and grounds a worksheet) and read as
// boilerplate on activity-toolless threads. Each agent now gets a
// headline + a short example prompt + a contextual hint about how
// the agent reads the request.
const EMPTY_STATE_COPY: Record<
  import("@mpfe/shared").AgentKind,
  { headline: string; example: string; hint: string }
> = {
  "syllabus-generator": {
    headline: "Ask the agent to build a syllabus.",
    example: "Create a 2-chapter syllabus on graph databases",
    hint: "— or send something vague to see the agent ask a clarifying question.",
  },
  "activity-generator-tooled": {
    headline: "Ask for a worksheet grounded in the bound syllabus.",
    example: "Build a practice worksheet for the B-tree lesson",
    hint: "— the agent will pick a lesson via MCP and ground every question in its body.",
  },
  "activity-generator-toolless": {
    headline: "Describe the worksheet you want the agent to draft.",
    example: "Make 5 MCQs on hash indexes for CS undergrads",
    hint: "— no syllabus binding, the agent drafts straight from your prompt.",
  },
  deepagent: {
    headline: "Talk to the deep agent.",
    example: "Hello — call the echo tool with the text 'ping'.",
    hint: "— supervisor-only test agent, no subagents wired yet.",
  },
};

function EmptyState({
  agent,
}: {
  agent?: import("@mpfe/shared").AgentKind;
}) {
  const copy = EMPTY_STATE_COPY[agent ?? "syllabus-generator"];
  return (
    <div className="mx-auto mt-8 max-w-md animate-fade-in rounded-xl border border-dashed border-[var(--border)] bg-[var(--card)]/40 px-5 py-8 text-center">
      <div className="mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-[var(--secondary)]/15 ring-1 ring-[var(--secondary)]/30">
        <Sparkles className="h-4 w-4 text-[var(--secondary)]" />
      </div>
      <p className="text-[13.5px] font-medium">{copy.headline}</p>
      <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--muted-foreground)]">
        Try{" "}
        <span className="rounded bg-[var(--muted)] px-1 py-px font-mono text-[11px] text-[var(--secondary)]">
          {copy.example}
        </span>{" "}
        {copy.hint}
      </p>
    </div>
  );
}

/**
 * Composite badge that fuses server-side run lifecycle with graph phase.
 *
 * Run status is the primary signal:
 *  - `running`/`queued` → show the active phase ("researching", "writing"…)
 *    so the badge matches what the inline cards are doing.
 *  - `paused` → "Awaiting answer" (the supervisor paused on `ask`).
 *  - `failed` → "Failed" with destructive tone; details live in the
 *    inline FailedRunCard below.
 *  - `completed` → "Idle" (the previous run finished cleanly; the chat
 *    is ready for the next turn). We deliberately don't keep showing
 *    "completed" forever — that's noise.
 *  - no run yet → "Idle".
 *
 * If `loading` is true (this tab is actively SSE-streaming) we always
 * pulse the dot, even on `idle`/`completed` runs, so the user gets
 * instant feedback during the gap between request fire and the first
 * `phase` data part.
 */
function RunBadge({
  run,
  phase,
  loading,
}: {
  run: RunSnapshot | null;
  phase: AgentPhase;
  loading: boolean;
}) {
  const status = run?.status ?? null;
  let label: string;
  let tone: string;
  if (loading || status === "running" || status === "queued") {
    // Live: prefer phase. Falls back to a generic "Working" if the
    // graph hasn't emitted a phase yet (first turn cold start).
    label =
      phase && phase !== "idle"
        ? phase[0].toUpperCase() + phase.slice(1)
        : "Working";
    tone =
      phase === "asking"
        ? "border-[var(--secondary)]/50 bg-[var(--secondary)]/15 text-[var(--secondary)]"
        : "border-[var(--primary)]/45 bg-[var(--primary)]/15 text-[var(--primary)]";
  } else if (status === "paused") {
    label = "Awaiting answer";
    tone =
      "border-[var(--secondary)]/50 bg-[var(--secondary)]/15 text-[var(--secondary)]";
  } else if (status === "failed") {
    label = "Failed";
    tone =
      "border-[var(--destructive)]/45 bg-[var(--destructive)]/15 text-[var(--destructive)]";
  } else {
    label = "Idle";
    tone =
      "border-[var(--border)] bg-[var(--muted)] text-[var(--muted-foreground)]";
  }
  const dotPulse =
    loading || status === "running" || status === "queued" || status === "paused";
  return (
    <span
      className={
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[10.5px] uppercase tracking-wider " +
        tone
      }
      title={run?.error ?? undefined}
    >
      <span
        aria-hidden
        className={
          "h-1.5 w-1.5 rounded-full bg-current " +
          (dotPulse ? "animate-pulse" : "")
        }
      />
      {label}
    </span>
  );
}

/**
 * Inline card surfaced when the latest run failed and we're not already
 * working on a new turn. Today the chat UI's only signal that something
 * went wrong is a transient toast that the user can easily miss — and
 * after reload, even that's gone. This card is the persistent surface:
 * it tells the user WHAT happened (the error string), and gives them a
 * one-click retry of the last user message instead of expecting them
 * to copy-paste it.
 */
function FailedRunCard({
  run,
  onRetry,
}: {
  run: RunSnapshot;
  onRetry: (() => void) | null;
}) {
  return (
    <div className="rounded-lg border border-[var(--destructive)]/40 bg-[var(--destructive)]/10 px-3 py-2.5 text-[12.5px] animate-fade-in">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--destructive)]" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-[var(--destructive)]">
            Agent run failed
          </div>
          {run.error ? (
            <div className="mt-0.5 break-words text-[var(--muted-foreground)]">
              {run.error}
            </div>
          ) : null}
        </div>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-[11.5px] text-[var(--foreground)] transition hover:border-[var(--primary)] hover:text-[var(--primary)]"
          >
            <RotateCcw className="h-3 w-3" />
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Inline tool-call chips, rendered directly under the AIMessage that
 * issued the calls. Replaces the old "AGENT TOOL CALLS" rail at the
 * tail of the conversation — chips now appear in chat chronology
 * (BEENET-style), so the user sees each tool flip from `calling →
 * complete` exactly when the agent invoked it.
 *
 * `emit_worksheet` calls get an `EmitWorksheetToolRow` (chip + the
 * inline worksheet card preview) so the worksheet renders alongside
 * the chip without a separate `InlineWorksheetCard` further down the
 * transcript. All other calls render as a compact `ActivityToolCallRow`.
 */
function InlineToolCalls({
  calls,
  worksheets,
  agent,
  selectedWorksheetId,
  onSelectWorksheet,
}: {
  calls: ActivityToolCall[];
  worksheets: import("@mpfe/shared").ActivityWorksheetEmission[];
  agent?: import("@mpfe/shared").AgentKind;
  selectedWorksheetId: string | null;
  onSelectWorksheet: (id: string | null) => void;
}) {
  // Stable, server-reported invocation order. Each call's started_at
  // is set by the API at dispatch time, so this preserves the actual
  // chronological tool sequence even when React re-renders mid-stream.
  const ordered = [...calls].sort((a, b) => {
    if (a.started_at < b.started_at) return -1;
    if (a.started_at > b.started_at) return 1;
    return 0;
  });
  return (
    <div className="ml-9 flex max-w-[78%] flex-col gap-1.5 animate-fade-in">
      {ordered.map((call) => {
        const activityId =
          call.name === "emit_worksheet" &&
          typeof call.args.activity_id === "string"
            ? call.args.activity_id
            : null;
        const emission = activityId
          ? worksheets.find((w) => w.activity_id === activityId)
          : null;
        if (emission) {
          return (
            <EmitWorksheetToolRow
              key={call.id}
              call={call}
              emission={emission}
              agent={agent}
              selected={selectedWorksheetId === emission.activity_id}
              onSelect={() => onSelectWorksheet(emission.activity_id)}
            />
          );
        }
        return <ActivityToolCallRow key={call.id} call={call} />;
      })}
    </div>
  );
}

function ActivityToolCallRow({ call }: { call: ActivityToolCall }) {
  const isCalling = call.status === "calling";
  const isError = call.status === "error";
  return (
    <div className="flex items-start gap-2 rounded-lg border border-[var(--border)]/70 bg-[var(--background)]/60 px-2.5 py-2">
      <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[var(--muted)]">
        {isCalling ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--primary)]" />
        ) : isError ? (
          <AlertTriangle className="h-3.5 w-3.5 text-[var(--destructive)]" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 text-[var(--success)]" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-mono text-[12px] text-[var(--foreground)]">
            {call.name}
          </span>
          <span
            className={
              "rounded px-1.5 py-0.5 text-[10px] font-medium " +
              (isCalling
                ? "bg-[var(--primary)]/15 text-[var(--primary)]"
                : isError
                  ? "bg-[var(--destructive)]/15 text-[var(--destructive)]"
                  : "bg-[var(--success)]/15 text-[var(--success)]")
            }
          >
            {call.status}
          </span>
        </div>
        <div className="mt-0.5 truncate text-[11.5px] text-[var(--muted-foreground)]">
          {call.result_preview || call.error || summarizeToolArgs(call.args)}
        </div>
      </div>
    </div>
  );
}

function summarizeToolArgs(args: Record<string, unknown>): string {
  const id =
    typeof args.lesson_id === "string"
      ? args.lesson_id
      : typeof args.thread_id === "string"
        ? args.thread_id
        : "";
  return id ? `id ${id.slice(0, 8)}…` : "Preparing call…";
}

function EmitWorksheetToolRow({
  call,
  emission,
  agent,
  selected,
  onSelect,
}: {
  call?: ActivityToolCall;
  emission: import("@mpfe/shared").ActivityWorksheetEmission;
  agent?: import("@mpfe/shared").AgentKind;
  selected: boolean;
  onSelect: () => void;
}) {
  const parsed = useMemo(() => {
    const res = WorksheetSchema.safeParse(emission.worksheet);
    return res.success ? res.data : null;
  }, [emission.worksheet]);
  if (!parsed) return null;
  const kind = agent ?? "activity-generator-toolless";
  const isCalling = call?.status === "calling";
  const isError = call?.status === "error";
  return (
    <div className="rounded-lg border border-[var(--border)]/70 bg-[var(--background)]/60 px-2.5 py-2">
      <div className="mb-2 flex items-center gap-2">
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-emerald-400/15">
          {isCalling ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--primary)]" />
          ) : isError ? (
            <AlertTriangle className="h-3.5 w-3.5 text-[var(--destructive)]" />
          ) : (
            <FileText className="h-3.5 w-3.5 text-emerald-300" />
          )}
        </span>
        <span className="font-mono text-[12px] text-[var(--foreground)]">
          emit_worksheet
        </span>
        <span
          className={
            "rounded px-1.5 py-0.5 text-[10px] font-medium " +
            (isCalling
              ? "bg-[var(--primary)]/15 text-[var(--primary)]"
              : isError
                ? "bg-[var(--destructive)]/15 text-[var(--destructive)]"
                : "bg-[var(--success)]/15 text-[var(--success)]")
          }
        >
          {call?.status ?? "complete"}
        </span>
      </div>
      <WorksheetToolCallChip
        worksheet={parsed}
        lessonTitle={emission.lesson_title}
        agent={kind}
        selected={selected}
        onSelect={onSelect}
      />
    </div>
  );
}

/**
 * Renders one inline worksheet emission as two layouts side-by-side:
 *   - Desktop (lg+): a compact tool-call chip (Cursor-style) that opens
 *     the full worksheet in the right-pane workbench when clicked.
 *   - Mobile/narrow (< lg): the full `<ActivityWorksheet>` rendered
 *     inline as a fallback, since the workbench pane isn't visible
 *     alongside chat on small screens.
 *
 * The worksheet payload comes straight from the agent's `emit_worksheet`
 * tool-call args (via the data stream), NOT from Supabase — so multiple
 * worksheets can coexist in one thread anchored to the assistant turn
 * that produced them, and reload picks up the same set from the
 * persisted state. We synthesize an `ActivityRow`-shaped object so we
 * can reuse the existing component for the mobile fallback.
 */
function InlineWorksheetCard({
  emission,
  threadId,
  agent,
  selected,
  onSelect,
}: {
  emission: import("@mpfe/shared").ActivityWorksheetEmission;
  threadId: string;
  agent?: import("@mpfe/shared").AgentKind;
  selected: boolean;
  onSelect: () => void;
}) {
  const parsed = useMemo(() => {
    const res = WorksheetSchema.safeParse(emission.worksheet);
    return res.success ? res.data : null;
  }, [emission.worksheet]);
  if (!parsed) return null;
  // Default to the toolless badge if the parent didn't pass an agent
  // kind — the inline card is only emitted by activity agents anyway,
  // so this fallback only affects the badge color, not correctness.
  const kind = agent ?? "activity-generator-toolless";
  const row: import("@mpfe/shared").ActivityRow = {
    id: emission.activity_id,
    thread_id: threadId,
    lesson_id: emission.lesson_id,
    kind: "worksheet",
    prompt: "",
    lesson_title: emission.lesson_title,
    content: parsed,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  return (
    <>
      <div className="hidden lg:block">
        <WorksheetToolCallChip
          worksheet={parsed}
          lessonTitle={emission.lesson_title}
          agent={kind}
          selected={selected}
          onSelect={onSelect}
        />
      </div>
      <div className="lg:hidden">
        <ActivityWorksheet row={row} agent={kind} />
      </div>
    </>
  );
}

function phaseToHint(phase: AgentPhase, isLoading: boolean): string | null {
  if (!isLoading) return null;
  switch (phase) {
    case "researching":
      return "Researching sources…";
    case "planning":
      return "Drafting the syllabus plan…";
    case "writing":
      return "Writing lessons…";
    case "asking":
      return null; // Ask card handles its own UI.
    case "chatting":
      return "Thinking…";
    case "idle":
    default:
      return "Thinking…";
  }
}

/**
 * Persistent live status row pinned just above the chat input. Mirrors
 * the kind of "Agent is …" presence indicator that Devin / Cursor /
 * Perplexity show next to their input, so the user always knows
 * whether the agent is idle, working, blocked on them, or recovering
 * from a failure — without having to scan the transcript or notice
 * the small phase pill in the header.
 *
 * Decision order is what's most actionable to the user, NOT what's
 * most recently changed: an active interrupt (= "I need your answer")
 * always wins over a phase string, because the agent is technically
 * idle while waiting on a human. Failed runs that are NOT being
 * retried get their own row so the empty-input state isn't a
 * confidence-eroding "Awaiting instructions" sitting next to a
 * silently-failed run.
 */
function AgentStatusPill({
  phase,
  isLoading,
  isRunning,
  isStopping,
  runStatus,
  hasInterrupt,
  agent,
  activityProgress,
}: {
  phase: AgentPhase;
  isLoading: boolean;
  isRunning: boolean;
  isStopping: boolean;
  runStatus: import("@mpfe/shared").RunStatus | null;
  hasInterrupt: boolean;
  agent?: import("@mpfe/shared").AgentKind;
  activityProgress: import("@mpfe/shared").ActivityGenerationProgress | null;
}) {
  // 1. Awaiting human input — an Ask/Intake card is rendered above.
  if (hasInterrupt) {
    return (
      <StatusRow
        tone="secondary"
        pulse
        label="Agent is awaiting your answer"
      />
    );
  }
  // 2. Failed and not currently retrying — paired with FailedRunCard above.
  if (runStatus === "failed" && !isRunning) {
    return <StatusRow tone="destructive" label="Last run failed" />;
  }
  if (isStopping) {
    return <StatusRow tone="destructive" pulse label="Stopping agent run…" />;
  }
  // 3. Queued server-side — the worker hasn't picked it up yet.
  if (runStatus === "queued" && !isLoading) {
    return <StatusRow tone="primary" pulse label="Agent is queued, picking up…" />;
  }
  // 4. Live working — pick label off the LangGraph phase. Falls back
  //    to "thinking" before the first phase event arrives (cold start).
  //    The activity-generator overrides the writing label with live
  //    item counts whenever an `activity_progress` slice is present.
  if (isLoading || isRunning) {
    return (
      <StatusRow
        tone="primary"
        pulse
        label={phaseToLiveLabel(phase, agent, activityProgress)}
      />
    );
  }
  // 5. True idle.
  return (
    <StatusRow tone="muted" label="Agent is awaiting instructions" />
  );
}

function phaseToLiveLabel(
  phase: AgentPhase,
  agent?: import("@mpfe/shared").AgentKind,
  activityProgress?:
    | import("@mpfe/shared").ActivityGenerationProgress
    | null,
): string {
  // Activity-generator: while the writer LLM is streaming JSON we have
  // a live item counter — surface it instead of the static "building
  // the worksheet…" copy. Falls back to the static copy when no
  // progress slice is active (pre-stream / between turns).
  if (
    activityProgress &&
    (agent === "activity-generator-tooled" ||
      agent === "activity-generator-toolless")
  ) {
    return `Agent is building the worksheet — ${formatActivityProgress(activityProgress)}`;
  }
  switch (phase) {
    case "researching":
      return "Agent is searching the web…";
    case "planning":
      return "Agent is drafting the plan…";
    case "writing":
      return agent === "syllabus-generator"
        ? "Agent is writing lessons…"
        : "Agent is building the worksheet…";
    case "asking":
      // Covered by the interrupt branch above, but kept defensively
      // for the brief window between phase=asking and the interrupt
      // landing in the store.
      return "Agent is preparing a question…";
    case "chatting":
      return "Agent is thinking…";
    case "idle":
    default:
      return "Agent is thinking…";
  }
}

/**
 * Compact "3/5 MCQs · 1/2 SA · ✓ worked example" summary for the live
 * progress slice. Skips empty parts so a worksheet with no short-answers
 * doesn't render "0/0 SA".
 */
function formatActivityProgress(
  p: import("@mpfe/shared").ActivityGenerationProgress,
): string {
  const parts: string[] = [];
  if (p.mcqs_total > 0) {
    parts.push(`${p.mcqs_done}/${p.mcqs_total} MCQs`);
  }
  if (p.short_answers_total > 0) {
    parts.push(`${p.short_answers_done}/${p.short_answers_total} SA`);
  }
  if (p.worked_example_expected) {
    parts.push(p.worked_example_done ? "✓ worked example" : "worked example…");
  }
  return parts.length > 0 ? parts.join(" · ") : "thinking…";
}

function StatusRow({
  tone,
  label,
  pulse,
}: {
  tone: "primary" | "secondary" | "destructive" | "muted";
  label: string;
  pulse?: boolean;
}) {
  const dotCls = {
    primary: "bg-[var(--primary)]",
    secondary: "bg-[var(--secondary)]",
    destructive: "bg-[var(--destructive)]",
    muted: "bg-[var(--muted-foreground)]/60",
  }[tone];
  const textCls = {
    primary: "text-[var(--primary)]",
    secondary: "text-[var(--secondary)]",
    destructive: "text-[var(--destructive)]",
    muted: "text-[var(--muted-foreground)]",
  }[tone];
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-[var(--border)] bg-[var(--card)]/30 px-4 py-1.5">
      <span
        aria-hidden
        className={
          "h-1.5 w-1.5 rounded-full " +
          dotCls +
          (pulse ? " animate-pulse" : "")
        }
      />
      <span
        className={"text-[11.5px] font-medium tracking-tight " + textCls}
        aria-live="polite"
      >
        {label}
      </span>
    </div>
  );
}

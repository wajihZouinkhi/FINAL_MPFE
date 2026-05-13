import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import {
  AgentInterrupt,
  AgentPhase,
  ManifestItem,
  ResearchPlan,
  ResearchStep,
  SyllabusPlan,
  TodoPlan,
  TodoStep,
} from "@mpfe/shared";

const RESEARCH_PLAN_REPLACE = Symbol("research_plan_replace");

type ResearchPlanNext = ResearchPlan & { [RESEARCH_PLAN_REPLACE]?: true };

export function replaceResearchPlan(plan: ResearchPlan): ResearchPlanNext {
  return { ...plan, [RESEARCH_PLAN_REPLACE]: true };
}

export function mergeResearchPlan(
  prev: ResearchPlanNext | null,
  next: ResearchPlanNext | null | undefined,
): ResearchPlanNext | null {
  if (next === null || next === undefined) return next ?? prev;
  if (prev === null) return next;
  if (next[RESEARCH_PLAN_REPLACE]) return next;
  const byId = new Map(prev.steps.map((s) => [s.id, s] as const));
  for (const s of next.steps) byId.set(s.id, s);
  const stepIdNum = (id: string) => {
    const m = /^s(\d+)$/.exec(id);
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  };
  return {
    goal: next.goal || prev.goal,
    steps: [...byId.values()].sort(
      (a, b) => stepIdNum(a.id) - stepIdNum(b.id),
    ),
  };
}

/**
 * GraphState — strictly partitioned. Heavy text NEVER lives here.
 *
 *  - messages:               LLM conversation memory (Supervisor's view)
 *  - phase:                  high-level phase, mirrors UI tab/state
 *  - research_plan:          live search-subgraph progress (steps + statuses)
 *  - todo_plan:              live command-subgraph progress (writer/critic)
 *  - manifest:               committed-row mirror; FileTree fast-render source
 *  - interrupt:              ask_user payload while graph is paused
 *  - search_plan_internal:   LLM-private candidate URLs (never streamed)
 *  - search_summary:         compacted brief injected back to the supervisor
 *                            as a ToolMessage; kept for cross-turn visibility
 *  - syllabus_plan:          structured plan committed by the supervisor
 *  - draft_cache_ids:        per-lesson Redis cache keys for in-flight markdown
 */
export const GraphAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  phase: Annotation<AgentPhase>({
    reducer: (_prev, next) => next,
    default: () => "idle" as AgentPhase,
  }),
  /**
   * The reducer merges by step.id rather than overwriting the whole
   * plan. The legacy sequential `search_step` node always emitted the
   * full plan with one step modified (via `patchResearchStep`), so
   * merge-by-id is a no-op for it. Parallel `search_topic` workers
   * (Send-fanout) instead emit a plan containing only THEIR own step:
   * the reducer preserves siblings from concurrent branches that
   * resolved earlier so we don't lose data when N workers complete
   * out of order.
   *
   * Reset semantics: when the supervisor routes to a NEW search cycle,
   * it marks the empty `{ goal, steps: [] }` with `replaceResearchPlan`.
   * Plain empty / single-step `next.steps` values can also appear from
   * parallel `search_topic` worker returns and must NOT wipe siblings.
   */
  research_plan: Annotation<ResearchPlanNext | null>({
    reducer: mergeResearchPlan,
    default: () => null,
  }),
  todo_plan: Annotation<TodoPlan | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  manifest: Annotation<ManifestItem[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  interrupt_payload: Annotation<AgentInterrupt | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  /**
   * Permanent record of every ask the supervisor has issued in this thread,
   * with the user's answer once provided. The FE renders this as an inline
   * Q&A trail in the transcript so reload reproduces the conversation.
   */
  interrupt_history: Annotation<AgentInterrupt[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  search_plan_internal: Annotation<{
    goal: string;
    topics: string[];
    /**
     * Conversation language pinned by the supervisor (same value used in
     * the supervisor's USER_LANGUAGE system message). The summarizer
     * writes its output in this language so the writer downstream is fed
     * a brief in the user's tongue, not English. The picker only
     * consults it as a tie-breaker when two candidates are equally
     * authoritative but one is in the user's language.
     */
    language?: string;
    candidates_by_topic: Record<
      string,
      Array<{
        id: number;
        url: string;
        title: string;
        snippet: string;
        /**
         * Coarse source category tagged by the picker. Carried through
         * to scraping + summarization so source labels like
         * `[curriculum]` / `[textbook]` end up in the brief, and so the
         * writer can prefer curriculum docs when sources disagree.
         */
        source_type?:
          | "curriculum"
          | "textbook"
          | "paper"
          | "course"
          | "official_docs"
          | "reference"
          | "other";
      }>
    >;
  } | null>({
    // Merges by topic key so concurrent `search_topic` workers
    // (Send-fanout) can each contribute their own candidate slice
    // without clobbering siblings' contributions OR the planner's
    // authoritative topics array.
    //
    // Two slice shapes flow through here:
    //   1) Planner / supervisor re-plan: `topics` is the full N-
    //      element array, `candidates_by_topic` is empty (`{}`). This
    //      seeds the slot from scratch.
    //   2) Worker (Send-fanout) and legacy sequential `search_step`:
    //      `candidates_by_topic` is non-empty (1+ key) — the slice
    //      asserts new candidate data. The worker also returns a
    //      single-element `topics` array, but it has no business
    //      resetting the authoritative topic list, so we keep prev's.
    //
    // Disambiguator: empty `next.candidates_by_topic` means "reseed /
    // reset" (legacy reducer had this for free because it overwrote);
    // non-empty means "merge my candidate keys, leave topics alone".
    // This preserves the legacy sequential path: it always returns
    // `{ ...prev, candidates_by_topic: cmap }` with the full topics
    // array, so prev.topics === next.topics and keeping prev.topics
    // is a no-op.
    reducer: (prev, next) => {
      if (next === null || next === undefined) return next ?? prev;
      if (prev === null) return next;
      const nextHasCandidates =
        Object.keys(next.candidates_by_topic ?? {}).length > 0;
      if (!nextHasCandidates) {
        // Reset / reseed (planner first run, supervisor re-plan).
        return next;
      }
      // Worker / legacy slice asserting new candidates.
      return {
        goal: prev.goal,
        topics: prev.topics,
        language: prev.language ?? next.language,
        candidates_by_topic: {
          ...(prev.candidates_by_topic ?? {}),
          ...(next.candidates_by_topic ?? {}),
        },
      };
    },
    default: () => null,
  }),
  search_summary: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  /**
   * Index of the topic currently being researched in the search subgraph.
   * The search subgraph processes one topic per node invocation so each
   * step transition gets checkpointed and streamed (Perplexity-style live
   * progress + reload-friendly hydration). The planner resets this to 0
   * before fanning out.
   */
  search_step_index: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  /**
   * Sub-stage within the current topic. Splitting search → pick → scrape
   * into separate node calls means the FE sees status transitions
   * ("searching_urls" → "picking_candidates" → "scraping" → "done") as
   * they happen rather than only at the end of the topic. Reload during
   * any sub-stage shows the correct status.
   */
  search_substep: Annotation<"search" | "pick" | "scrape" | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  syllabus_plan: Annotation<typeof SyllabusPlan._type | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  draft_cache_ids: Annotation<Record<string, string>>({
    reducer: (prev, next) => ({ ...prev, ...next }),
    default: () => ({}),
  }),
  /**
   * Deprecated. The command subgraph used to iterate one lesson per
   * `command_write_one` invocation, advancing this cursor on each
   * call. The writer is now wave-based: each invocation processes
   * every lesson whose `depends_on` set is already in
   * `committed_lesson_ids`, in parallel, then loops back for the next
   * wave. Kept on the state shape so old checkpoints rehydrate cleanly
   * but no node reads or writes it anymore.
   */
  command_lesson_cursor: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  /**
   * IDs of lessons whose row has been UPSERTed into Supabase. The
   * conditional edge out of `command_write_one` checks this against
   * the total lesson count to decide loop-vs-finalize, and the
   * wave-scheduler inside `command_write_one` filters the
   * "depends_on" set against this same array. Union-merged so
   * parallel branches — if the subgraph ever switches to `Send`
   * fan-out — don't clobber each other.
   */
  committed_lesson_ids: Annotation<string[]>({
    reducer: (prev, next) => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const id of prev ?? []) {
        if (!seen.has(id)) {
          seen.add(id);
          out.push(id);
        }
      }
      for (const id of next ?? []) {
        if (!seen.has(id)) {
          seen.add(id);
          out.push(id);
        }
      }
      return out;
    },
    default: () => [],
  }),
  /**
   * Transient signal set by `command_finalize` and consumed by the
   * supervisor on its next entry. After the writer commits the
   * syllabus the graph routes back through the supervisor for a
   * brief, friendly wrap-up reply (instead of ending silently). This
   * flag tells the supervisor "you just finished writing — choose
   * action='reply'", so the user actually hears that the build is
   * done. The supervisor clears it on the way out so subsequent
   * turns aren't biased.
   */
  command_just_finalized: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
  thread_id: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
  /**
   * Routing hint set by the supervisor and read by the conditional edge.
   * Annotated explicitly so langgraph preserves it across the node boundary.
   */
  next_route: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  /**
   * Index in `state.messages` of the AIMessage that triggered the
   * current ResearchCard / TodoCard. Captured server-side at the moment
   * the supervisor decides to route to search / write, BEFORE the new
   * AIMessage is appended — so the index is `state.messages.length`
   * pre-mutation, which becomes the new message's slot post-merge.
   *
   * Why two fields instead of "anchor to last assistant on FE":
   *  - The previous timing-based approach worked only during the live
   *    POST stream (anchor = last assistant message at the moment the
   *    typed slice arrived). On `/state` hydration (reload, or just
   *    navigating into a finished thread) all messages arrive at once
   *    and there is no "moment of arrival" to anchor against — both
   *    cards collapsed onto the wrap-up message and ended up at the
   *    tail of the transcript, looking like they had been deleted.
   *  - With these explicit indices in graph state, hydration is
   *    deterministic: messages[research_anchor_msg_index] is the AI
   *    bubble that triggered the research card, regardless of whether
   *    the page was open during the run or reloaded after.
   */
  research_anchor_msg_index: Annotation<number | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  todo_anchor_msg_index: Annotation<number | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
});

export type GraphStateType = typeof GraphAnnotation.State;

// ─── Patch helpers ─────────────────────────────────────────────────────────

export function patchResearchStep(
  plan: ResearchPlan | null,
  update: Partial<ResearchStep> & { id: string },
): ResearchPlan {
  const base: ResearchPlan = plan ?? { goal: "", steps: [] };
  const exists = base.steps.some((s) => s.id === update.id);
  const steps = exists
    ? base.steps.map((s) => (s.id === update.id ? { ...s, ...update } : s))
    : [
        ...base.steps,
        {
          id: update.id,
          title: update.title ?? "",
          queries: update.queries ?? [],
          status: update.status ?? "pending",
          picked_count: update.picked_count ?? 0,
          scraped_count: update.scraped_count ?? 0,
          picked: update.picked ?? [],
          // Preserve the streaming-draft marker through merge so the FE
          // can shimmer rows that arrived via supervisor.topics[*] before
          // search_planner's on_chain_end snapshot replaces them.
          ...(update.__draft !== undefined ? { __draft: update.__draft } : {}),
        },
      ];
  return { ...base, steps };
}

export function patchTodoStep(
  plan: TodoPlan | null,
  update: Partial<TodoStep> & { id: string },
): TodoPlan {
  const base: TodoPlan = plan ?? { steps: [] };
  const exists = base.steps.some((s) => s.id === update.id);
  const steps = exists
    ? base.steps.map((s) => (s.id === update.id ? { ...s, ...update } : s))
    : [
        ...base.steps,
        {
          id: update.id,
          chapter_ref: update.chapter_ref ?? "",
          name: update.name ?? "",
          status: update.status ?? "pending",
          attempts: update.attempts ?? 0,
          ...(update.__draft !== undefined ? { __draft: update.__draft } : {}),
        },
      ];
  return { ...base, steps };
}

export function patchManifestItem(
  manifest: ManifestItem[],
  update: { id: string } & Partial<ManifestItem>,
): ManifestItem[] {
  const exists = manifest.some((m) => m.id === update.id);
  return exists
    ? manifest.map((m) => (m.id === update.id ? { ...m, ...update } : m))
    : [
        ...manifest,
        {
          id: update.id,
          title: update.title ?? "",
          chapter_title: update.chapter_title,
          status: update.status ?? "pending",
          db_id: update.db_id ?? null,
          review_required: update.review_required ?? false,
          block_issues: update.block_issues ?? [],
          critic_issues: update.critic_issues ?? [],
          depends_on: update.depends_on ?? [],
          ...(update.__draft !== undefined ? { __draft: update.__draft } : {}),
        },
      ];
}

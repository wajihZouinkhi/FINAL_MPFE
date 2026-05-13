import { Injectable, Logger } from "@nestjs/common";
import { GraphStateType, patchResearchStep } from "../state";
import { SerperSearchProvider } from "./serper.provider";
import { Scraper } from "./scraper";
import { CacheService } from "../../cache/cache.service";
import { LlmConfigService } from "../../config/llm-config.service";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { dispatchLlmUsage } from "../streaming/llm-usage-event";
import { z } from "zod";
import type {
  ResearchPickedSource,
  ResearchPlan,
  ResearchStep,
} from "@mpfe/shared";

// Per-call wall-clock budgets. Audit §2.1 found a single slow scrape
// could stall a whole research turn for >2 min; with parallelism a
// hung Serper / picker call can still bottleneck the parent step.
// These caps are deliberately generous on the LLM tier (the picker's
// utility model can be slow under load) but tight on network I/O.
const TIMEOUT_SERPER_MS = 12_000;
const TIMEOUT_PICK_MS = 25_000;
const TIMEOUT_SCRAPE_MS = 15_000;

/**
 * Race a promise against a timer. Rejects with a TimeoutError-shaped
 * message if `ms` elapses first. Used to bound per-call wall-clock
 * exposure inside parallel search_topic workers — a single dead URL
 * or hung picker invocation no longer holds up sibling topics.
 */
async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Project the internal candidate-with-source_type shape down to the
 * shared `ResearchPickedSource` wire shape so the FE only ever sees
 * the fields it needs. Drops the internal numeric `id` (only valid
 * within a single Serper response) and clamps the snippet to 220
 * chars so a 3-source step stays well under 1 kB on the wire even
 * when Serper returns prose-heavy snippets. Audit §3.1.
 */
function pickedToWire(
  picked: Array<{
    url: string;
    title: string;
    snippet: string;
    source_type?: string;
  }>,
): ResearchPickedSource[] {
  return picked.map((p) => ({
    url: p.url,
    title: p.title,
    source_type:
      (p.source_type as ResearchPickedSource["source_type"]) ?? "other",
    snippet: (p.snippet ?? "").slice(0, 220),
  }));
}

/**
 * Payload shape for a parallel search_topic worker. Sent from the
 * planner's conditional edge as an array of `Send("search_topic", …)`
 * — one per topic the supervisor proposed.
 */
export type SearchTopicPayload = {
  topic_index: number;
  topic: string;
  goal: string;
  language?: string;
  thread_id: string;
};

// Picker v2 output. The model returns up to 3 picks tagged with a coarse
// source category so the writer / summarizer can prefer curriculum docs on
// contradictions and so the diversity rule (max 1 pick per category) can
// be enforced post-hoc as a safety net even if the prompt fails to
// internalize it.
const SourceType = z.enum([
  "curriculum",
  "textbook",
  "paper",
  "course",
  "official_docs",
  "reference",
  "other",
]);
const PickerOutput = z.object({
  picks: z
    .array(
      z.object({
        id: z.number().int().nonnegative(),
        source_type: SourceType.default("other"),
      }),
    )
    .max(3),
});

/**
 * Map-Reduce search nodes wired directly into the parent graph (no
 * subgraph indirection). Compiled subgraphs in LangGraph JS execute as
 * a single parent step: their internal node returns are NOT propagated
 * to the parent's checkpointer until the subgraph completes. That made
 * /state return `research_plan.steps: []` on reload mid-research, even
 * after the subgraph emitted topics live over SSE. Inlining the nodes
 * means every sub-stage transition is a parent-level checkpoint, so the
 * FE both sees Perplexity-style live progress AND can reload mid-flight
 * to hydrate the latest substep state.
 *
 * Flow:
 *   planner → step | summarizer
 *   step → step | summarizer   (loops while search_substep != null)
 *   summarizer → supervisor
 */
@Injectable()
export class SearchSubgraph {
  private readonly logger = new Logger(SearchSubgraph.name);

  constructor(
    private readonly serper: SerperSearchProvider,
    private readonly scraper: Scraper,
    private readonly cache: CacheService,
    private readonly llm: LlmConfigService,
  ) {}

  /** Initialize research_plan from the topics the supervisor produced. */
  async planner(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    const internal = state.search_plan_internal;
    if (!internal) return {};
    let plan: ResearchPlan = { goal: internal.goal, steps: [] };
    for (let i = 0; i < internal.topics.length; i++) {
      plan = patchResearchStep(plan, {
        id: `s${i}`,
        title: internal.topics[i],
        queries: [internal.topics[i]],
        status: "pending",
        picked_count: 0,
        scraped_count: 0,
      });
    }
    return {
      phase: "researching",
      research_plan: plan,
      search_step_index: 0,
      search_substep: internal.topics.length ? "search" : null,
      // Reset the candidate map so reruns don't reuse stale picks.
      search_plan_internal: { ...internal, candidates_by_topic: {} },
    };
  }

  /**
   * @deprecated Sequential per-substep loop. Replaced by `searchTopic`
   * (Send-fanout parallel worker) as part of audit §2.1's
   * optimisation. Retained because legacy checkpoints still reference
   * `search_step_index` / `search_substep`, but no longer wired into
   * the graph; safe to delete in a follow-up once no in-flight runs
   * could resume here.
   *
   * Process one sub-stage of one topic per invocation. Returning between
   * sub-stages is what let the parent checkpointer persist progress and
   * let the SSE stream emit a `research_plan` data part for every status
   * change — that property is now provided by `dispatchCustomEvent
   * ("research_progress", …)` from inside `searchTopic`.
   */
  async step(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    const internal = state.search_plan_internal;
    if (!internal) return { search_substep: null };
    const i = state.search_step_index;
    if (i >= internal.topics.length) return { search_substep: null };

    const topic = internal.topics[i];
    const stepId = `s${i}`;
    let plan = state.research_plan;
    const cmap = { ...(internal.candidates_by_topic ?? {}) };

    if (state.search_substep === "search") {
      plan = patchResearchStep(plan, { id: stepId, status: "searching_urls" });
      const results = await this.serper.search(topic, 5);
      const candidates = results.map((r, id) => ({
        id,
        url: r.link,
        title: r.title,
        snippet: r.snippet,
      }));
      if (candidates.length === 0) {
        plan = patchResearchStep(plan, { id: stepId, status: "failed" });
        cmap[topic] = [];
        return this.advance(state, plan, { ...internal, candidates_by_topic: cmap });
      }
      plan = patchResearchStep(plan, {
        id: stepId,
        status: "picking_candidates",
      });
      cmap[topic] = candidates;
      return {
        research_plan: plan,
        search_plan_internal: { ...internal, candidates_by_topic: cmap },
        search_substep: "pick",
      };
    }

    if (state.search_substep === "pick") {
      const candidates = cmap[topic] ?? [];
      const picks = await this.pick(topic, candidates, internal.language);
      const pickedIds = new Set(picks.map((p) => p.id));
      const sourceTypeById = new Map(picks.map((p) => [p.id, p.source_type]));
      const picked = candidates
        .filter((c) => pickedIds.has(c.id))
        .map((c) => ({ ...c, source_type: sourceTypeById.get(c.id) }));
      plan = patchResearchStep(plan, {
        id: stepId,
        picked_count: picked.length,
        picked: pickedToWire(picked),
        status: "scraping",
      });
      cmap[topic] = picked;
      return {
        research_plan: plan,
        search_plan_internal: { ...internal, candidates_by_topic: cmap },
        search_substep: "scrape",
      };
    }

    // search_substep === "scrape"
    const picked = cmap[topic] ?? [];
    const cachedKeys: string[] = [];
    for (const c of picked) {
      const text = await this.scraper.fetchReadable(c.url);
      if (text) {
        const key = `scrape:${state.thread_id}:${stepId}:${c.id}`;
        await this.cache.set(key, text, 60 * 30);
        cachedKeys.push(key);
      }
    }
    plan = patchResearchStep(plan, {
      id: stepId,
      scraped_count: cachedKeys.length,
      picked: pickedToWire(picked),
      status: "done",
    });
    this.logger.log(
      `topic "${topic}" → ${picked.length} picked, ${cachedKeys.length} scraped`,
    );
    return this.advance(state, plan, { ...internal, candidates_by_topic: cmap });
  }

  /**
   * Move on to the next topic, or terminate the loop by clearing
   * `search_substep` so the conditional edge routes to the summarizer.
   */
  private advance(
    state: GraphStateType,
    plan: ResearchPlan | null,
    internal: NonNullable<GraphStateType["search_plan_internal"]>,
  ): Partial<GraphStateType> {
    const next = state.search_step_index + 1;
    const more = next < internal.topics.length;
    return {
      research_plan: plan,
      search_plan_internal: internal,
      search_step_index: next,
      search_substep: more ? "search" : null,
    };
  }

  /**
   * Parallel per-topic worker. One invocation processes a SINGLE topic
   * end-to-end (search → pick → scrape) and returns a state slice
   * containing only that topic's contribution.
   *
   * The graph wires N copies of this node via `Send("search_topic", …)`
   * so all topics' Serper queries / picker LLM calls / scrape fan-outs
   * run concurrently. Cross-branch state is reconciled by the
   * `research_plan` and `search_plan_internal` reducers (merge by
   * step.id and by topic key, respectively).
   *
   * Per-call timeouts (`withTimeout`) bound a worker's wall-clock
   * budget so a single hung Serper / picker / scrape can't stall the
   * whole research turn. A worker that exhausts a timeout marks its
   * step `failed` and returns; siblings continue.
   *
   * Per-substep progress is broadcast via `dispatchCustomEvent
   * ("research_progress", …)` because LangGraph only checkpoints node
   * RETURNS — without custom events the FE would jump from "pending"
   * straight to "done" for each topic. The chat controller subscribes
   * to these events and emits `research_plan` typed slices live, so
   * the FE keeps its Perplexity-style status transitions per topic
   * even with parallelism.
   */
  async searchTopic(
    payload: SearchTopicPayload,
  ): Promise<Partial<GraphStateType>> {
    const { topic_index, topic, goal, language, thread_id } = payload;
    const stepId = `s${topic_index}`;
    const stepBase: ResearchStep = {
      id: stepId,
      title: topic,
      queries: [topic],
      status: "pending",
      picked_count: 0,
      scraped_count: 0,
      picked: [],
    };

    const emitProgress = async (patch: Partial<ResearchStep>) => {
      try {
        await dispatchCustomEvent("research_progress", {
          step_id: stepId,
          patch,
        });
      } catch (err) {
        this.logger.warn(
          `dispatchCustomEvent(research_progress) failed: ${(err as Error).message}`,
        );
      }
    };

    const failed = (
      reason: string,
    ): Partial<GraphStateType> => {
      this.logger.warn(`topic "${topic}" failed: ${reason}`);
      return {
        research_plan: {
          goal,
          steps: [{ ...stepBase, status: "failed" }],
        },
        search_plan_internal: {
          goal,
          topics: [topic],
          language,
          candidates_by_topic: { [topic]: [] },
        },
      };
    };

    // 1) SEARCH — Serper query.
    await emitProgress({ status: "searching_urls" });
    let serperResults;
    try {
      serperResults = await withTimeout(
        this.serper.search(topic, 5),
        TIMEOUT_SERPER_MS,
        `serper(${topic})`,
      );
    } catch (err) {
      return failed(`serper: ${(err as Error).message}`);
    }
    if (serperResults.length === 0) {
      await emitProgress({ status: "failed" });
      return failed("serper returned no results");
    }
    const candidates = serperResults.map((r, id) => ({
      id,
      url: r.link,
      title: r.title,
      snippet: r.snippet,
    }));

    // 2) PICK — utility-tier LLM ranks candidates by teaching value.
    await emitProgress({ status: "picking_candidates" });
    let picks: Array<{
      id: number;
      source_type: z.infer<typeof SourceType>;
    }> = [];
    try {
      picks = await withTimeout(
        this.pick(topic, candidates, language),
        TIMEOUT_PICK_MS,
        `pick(${topic})`,
      );
    } catch (err) {
      this.logger.warn(
        `pick timed out for "${topic}", falling back to top-2 by rank: ${(err as Error).message}`,
      );
      picks = candidates
        .slice(0, 2)
        .map((c) => ({ id: c.id, source_type: "other" as const }));
    }
    const pickedIds = new Set(picks.map((p) => p.id));
    const sourceTypeById = new Map(picks.map((p) => [p.id, p.source_type]));
    const picked = candidates
      .filter((c) => pickedIds.has(c.id))
      .map((c) => ({ ...c, source_type: sourceTypeById.get(c.id) }));

    // 3) SCRAPE — concurrent within the topic, each call bounded.
    // Cache hits are still O(1); misses are the long pole. Promise.allSettled
    // so one dead URL doesn't sink the topic.
    const pickedWire = pickedToWire(picked);
    await emitProgress({
      status: "scraping",
      picked_count: picked.length,
      picked: pickedWire,
    });
    const scrapeResults = await Promise.allSettled(
      picked.map(async (c) => {
        const text = await withTimeout(
          this.scraper.fetchReadable(c.url),
          TIMEOUT_SCRAPE_MS,
          `scrape(${c.url})`,
        );
        if (text) {
          const key = `scrape:${thread_id}:${stepId}:${c.id}`;
          await this.cache.set(key, text, 60 * 30);
          return key;
        }
        return null;
      }),
    );
    const scrapedCount = scrapeResults.reduce((n, r) => {
      if (r.status === "fulfilled" && r.value) return n + 1;
      if (r.status === "rejected") {
        this.logger.warn(
          `scrape failure in topic "${topic}": ${(r.reason as Error)?.message ?? r.reason}`,
        );
      }
      return n;
    }, 0);

    await emitProgress({
      status: "done",
      picked_count: picked.length,
      scraped_count: scrapedCount,
      picked: pickedWire,
    });

    this.logger.log(
      `topic "${topic}" → ${picked.length} picked, ${scrapedCount} scraped`,
    );
    return {
      research_plan: {
        goal,
        steps: [
          {
            ...stepBase,
            status: "done",
            picked_count: picked.length,
            scraped_count: scrapedCount,
            picked: pickedWire,
          },
        ],
      },
      search_plan_internal: {
        goal,
        topics: [topic],
        language,
        candidates_by_topic: { [topic]: picked },
      },
    };
  }

  /**
   * Picker v2.
   *
   * The MVP picker treated every authoritative URL as equivalent. That
   * produced research dumps stuffed with reference docs and zero teaching
   * artifacts — Wikipedia + an API spec is great for explaining "what",
   * useless for designing a lesson around "how to teach". The picker now:
   *
   *  - Sees the candidate URL alongside title+snippet so it can read
   *    domain hints (`*.edu`, ACM/IEEE, MOOC platforms, official docs).
   *  - Categorises each pick (curriculum / textbook / paper / course /
   *    official_docs / reference / other) so downstream nodes can label
   *    sources and prefer curriculum on contradictions.
   *  - Is told to keep the picks DIVERSE — at most one per source_type
   *    when possible. If we end up with 3 reference picks and zero
   *    curriculum picks the resulting brief has no teaching signal.
   *  - Uses USER_LANGUAGE only as a tie-breaker; an authoritative English
   *    source still beats an SEO blog in the user's language.
   *  - As a safety net, the post-hoc dedupe filters out dupes-by-source_type
   *    if the model returns 3 of the same kind.
   */
  private async pick(
    topic: string,
    candidates: Array<{
      id: number;
      url: string;
      title: string;
      snippet: string;
    }>,
    language: string | undefined,
  ): Promise<Array<{ id: number; source_type: z.infer<typeof SourceType> }>> {
    if (candidates.length === 0) return [];
    const lang = language ?? "English";
    try {
      const picker = this.llm.get("utility", { temperature: 0 });
      const pickerModel = this.llm.rawConfig("utility").model;
      const lines = candidates
        .map((c) => `${c.id}: [${c.url}] ${c.title} — ${c.snippet}`)
        .join("\n");
      const prompt = [
        new SystemMessage(
          `You select sources for designing a teaching syllabus, not for explaining a topic. ` +
            `Pick up to 3 candidate IDs that together give a TEACHER what they need: structure, prerequisites, common misconceptions, ` +
            `and authoritative content.\n\n` +
            `Categorise each pick with one of:\n` +
            `  - curriculum     : ACM/IEEE/IB/Common Core/NGSS standards, departmental syllabi, exam boards\n` +
            `  - textbook       : established textbook chapter, lecture notes that read like a textbook\n` +
            `  - paper          : SIGCSE / education-research paper, peer-reviewed content\n` +
            `  - course         : MOOC / university course page (Coursera, edX, MIT OCW, Stanford CS, …)\n` +
            `  - official_docs  : official software/standard documentation (e.g. python.org, w3.org)\n` +
            `  - reference      : encyclopedic reference (Wikipedia, MDN reference pages, glossaries)\n` +
            `  - other          : anything else that's still high quality\n\n` +
            `Hard rules:\n` +
            `- Prefer DIVERSITY: at most ONE pick per source_type when the candidate pool allows it. ` +
            `Three "reference" picks is almost always wrong because reference sources don't tell you how to teach.\n` +
            `- If a curriculum/standards source AND a textbook/course source are both available and credible, both should be among the picks.\n` +
            `- Reject SEO-bait articles, content farms, paywalled excerpts, short marketing pages, and AI-generated listicles. ` +
            `If a domain looks like seo-tutorials.com / *.medium.com / dev.to / a personal blog of an unknown author, only pick it if no better option exists.\n` +
            `- USER_LANGUAGE is "${lang}". Use it only as a tie-breaker when two candidates are equally authoritative — an authoritative English source still beats a low-authority source in ${lang}.\n` +
            `- If two candidates clearly cover the same content, keep only the more authoritative one.\n\n` +
            `Reply with strict JSON only:\n` +
            `{"picks":[{"id":<int>,"source_type":"<one of the 7 categories>"}, ...]}\n` +
            `No prose. No code fences.`,
        ),
        new HumanMessage(`Topic: ${topic}\n\nCandidates:\n${lines}`),
      ];
      const reply = await picker.invoke(prompt);
      await dispatchLlmUsage(reply, {
        node: "search:source_picker",
        tier: "utility",
        model: pickerModel,
      });
      const txt = String(reply.content ?? "").trim();
      const json = this.extractJson(txt);
      const parsed = PickerOutput.safeParse(json);
      if (parsed.success) {
        const validIds = new Set(candidates.map((c) => c.id));
        let picks = parsed.data.picks.filter((p) => validIds.has(p.id));
        // Diversity safety net: if the model returned more than one pick of
        // the same SPECIFIC source_type, dedupe (keep the first occurrence).
        // This matches the prompt's "at most ONE per source_type" rule even
        // when the model fails to internalize it.
        //
        // "other" is exempt from the dedupe — it's a catch-all for
        // legitimately high-quality picks that don't fit the 6 specific
        // categories, and it's also what `SourceType.default("other")` fills
        // in when the model omits source_type entirely. Collapsing those
        // would silently drop up to 3 valid picks down to 1 and starve the
        // research summary of breadth for that topic.
        const seen = new Set<string>();
        picks = picks.filter((p) => {
          if (p.source_type === "other") return true;
          if (seen.has(p.source_type)) return false;
          seen.add(p.source_type);
          return true;
        });
        if (picks.length > 0) return picks;
      }
    } catch (err) {
      this.logger.warn(`picker failed: ${(err as Error).message}`);
    }
    // Fallback: top-2 by Serper rank, untyped. The summarizer downstream
    // copes with missing source_type by labelling them `[other]`.
    return candidates
      .slice(0, 2)
      .map((c) => ({ id: c.id, source_type: "other" as const }));
  }

  /** Pull all scraped text from cache and synthesize a brief. */
  async summarizer(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    const internal = state.search_plan_internal;
    if (!internal) return {};
    let plan = state.research_plan;
    // Mark every step as summarizing so the FE shows the synthesis stage.
    if (plan) {
      for (const s of plan.steps) {
        if (s.status === "done") {
          plan = patchResearchStep(plan, { id: s.id, status: "summarizing" });
        }
      }
    }

    const sections: string[] = [];
    for (let i = 0; i < internal.topics.length; i++) {
      const stepId = `s${i}`;
      const topic = internal.topics[i];
      const cands = internal.candidates_by_topic[topic] ?? [];
      const blocks: string[] = [];
      for (const c of cands) {
        const key = `scrape:${state.thread_id}:${stepId}:${c.id}`;
        const text = await this.cache.get(key);
        if (text) {
          // Tag each scraped block with its source_type so the summarizer
          // can label downstream claims with [curriculum] / [textbook] /
          // etc. and so the writer can prefer curriculum on conflicts.
          const stype = c.source_type ?? "other";
          blocks.push(
            `SOURCE_TYPE: ${stype}\nSOURCE_URL: ${c.url}\n${text.slice(0, 4000)}`,
          );
        }
      }
      if (blocks.length) {
        sections.push(`### ${topic}\n${blocks.join("\n\n---\n\n")}`);
      }
    }

    // Mark only steps that reached summarization as done. Steps that
    // already failed (zero candidates, scrape errors) stay failed so the
    // research card doesn't lie about partial outcomes.
    if (plan) {
      for (const s of plan.steps) {
        if (s.status === "summarizing") {
          plan = patchResearchStep(plan, { id: s.id, status: "done" });
        }
      }
    }

    if (!sections.length) {
      return { phase: "chatting", research_plan: plan, search_summary: "" };
    }

    const lang = internal.language ?? "English";
    const writer = this.llm.get("writer", { temperature: 0.2 });
    const writerModel = this.llm.rawConfig("writer").model;
    // Summarizer v2 — produces a STRUCTURED PEDAGOGICAL BRIEF, not a bullet
    // dump. The MVP summarizer collapsed everything into "3-6 bullets per
    // topic" with no slot for prerequisites, misconceptions, or pacing —
    // so the writer downstream had nothing teaching-shaped to work with.
    // The v2 brief is keyed by topic but each topic block has fixed
    // sections the writer will quote from when generating lessons.
    const prompt = [
      new SystemMessage(
        `You synthesize background research for an upcoming TEACHING syllabus. ` +
          `You are not writing an article — you are writing a brief a teacher will use to design lessons. ` +
          `Your output is consumed verbatim by the writer node downstream, so be precise and structured.\n\n` +
          `LANGUAGE: write the brief in ${lang}. Section headings ("## Topic", "Core concepts", "Prerequisites", etc.) ` +
          `must also be translated to ${lang} (keep the same semantic meaning). ` +
          `Source labels in [brackets] stay in English (they're enums).\n\n` +
          `For EACH topic, produce a ## <topic> heading followed by these labelled sub-sections, in this order:\n` +
          `  1. Core concepts                — 3–6 dense bullets covering the central ideas a learner must understand.\n` +
          `  2. Prerequisites                — bullets listing what a learner should already know to engage with this topic.\n` +
          `  3. Common misconceptions        — bullets surfacing student difficulties / frequent confusions, drawn from teaching-oriented sources when present.\n` +
          `  4. Worked example seeds         — 1–3 concrete scenarios a writer can develop into a worked example. Each MUST be specific (a real dataset / problem / scenario), not "an example of X".\n` +
          `  5. Real-world applications      — 2–4 bullets on where this matters in practice.\n` +
          `  6. Suggested progression        — 1–3 bullets on a sensible teaching order if this topic spans multiple lessons (e.g. "introduce idea before terminology", "demo before theory").\n` +
          `  7. Source conflicts             — 0–3 bullets where credible sources disagree. Surface the disagreement explicitly. If none, write "None observed.".\n\n` +
          `Source labelling:\n` +
          `- Every factual bullet MUST end with a source label in brackets matching the SOURCE_TYPE of its supporting source — one of [curriculum], [textbook], [paper], [course], [official_docs], [reference], [other]. ` +
          `If multiple sources support the same bullet, list them comma-separated, e.g. "[curriculum, textbook]".\n` +
          `- Bullets in "Common misconceptions" should preferentially cite [paper] or [course] sources; if those are absent, flag the bullet with "[reference: needs verification]".\n` +
          `- Bullets in "Source conflicts" MUST list the conflicting source types side-by-side, e.g. "[curriculum] says X, [reference] says Y".\n\n` +
          `Hard rules:\n` +
          `- Use ONLY facts present in the provided sources — do NOT invent, extrapolate, or generalize beyond them.\n` +
          `- If a sub-section has no usable content for a topic, write the section heading and the single line "Not present in research." (in ${lang}). DON'T omit the section, because the writer keys off the structure.\n` +
          `- If a topic has no usable content at all, omit its entire ## section.\n` +
          `- No URL citations, no marketing copy, no SEO fluff, no "introduction" / "conclusion" / "abstract" framing.\n` +
          `- Total length: budget ~12–20 bullets per topic across all sub-sections, hard cap ~120 bullets total.`,
      ),
      new HumanMessage(
        `Goal: ${internal.goal}\n\nResearch sources by topic (each block is prefixed with SOURCE_TYPE):\n\n${sections.join("\n\n")}\n\nWrite the structured brief.`,
      ),
    ];
    const out = await writer.invoke(prompt);
    await dispatchLlmUsage(out, {
      node: "search:summarizer",
      tier: "writer",
      model: writerModel,
    });
    const summary = String(out.content ?? "").trim();
    return { phase: "chatting", research_plan: plan, search_summary: summary };
  }

  private extractJson(txt: string): unknown {
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

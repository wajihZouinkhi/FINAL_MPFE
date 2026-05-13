import { Injectable, Logger } from "@nestjs/common";
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { GraphStateType } from "../state";
import { LlmConfigService } from "../../config/llm-config.service";
import { SupabaseService } from "../../supabase/supabase.service";
import type { SyllabusPlan } from "@mpfe/shared";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import type {
  AgentInterrupt,
  ManifestItem,
  ResearchStep,
  TodoPlan,
  TodoStep,
} from "@mpfe/shared";
import { streamLlmAndExtractStructure } from "../streaming/partial-json-stream";
import { dispatchLlmUsage } from "../streaming/llm-usage-event";

// ── Decision schemas ────────────────────────────────────────────────────────
//
// All pedagogical-contract fields are OPTIONAL on the wire. Older models or
// degraded prompts that emit only the v1 shape continue to parse and the
// downstream nodes treat empty arrays / zeros as "not specified" and fall
// back to v1 behaviour. The supervisor v2 prompt below requires the model
// to populate them on every new build; if it doesn't, the critic surfaces
// it as a `pedagogy` block issue on the affected lessons.
const AudienceSchema = z.object({
  level: z
    .enum(["school", "undergrad", "grad", "professional"])
    .default("undergrad"),
  prior_knowledge: z.array(z.string()).default([]),
  language: z.string().default("English"),
});

const ScopeSchema = z.object({
  duration_hours: z.number().nonnegative().default(0),
  target_outcome: z.string().default(""),
  constraints: z.array(z.string()).default([]),
});

const PedagogySchema = z.object({
  style: z
    .enum(["lecture", "lab", "flipped", "self_study"])
    .default("self_study"),
  assessment: z.enum(["formative", "summative", "mixed"]).default("formative"),
  differentiation: z.boolean().default(false),
});

const LearningObjectiveSchema = z.object({
  text: z.string().min(1),
  bloom_level: z
    .enum(["remember", "understand", "apply", "analyze", "evaluate", "create"])
    .default("understand"),
});

// Structured pointer to another lesson in the same plan. Numbered
// 1-indexed because the supervisor prompt presents the syllabus to the
// LLM in human-counted form ("Chapter 1, Lesson 2"); keeping the wire
// shape the same as the prompt's mental model has been more reliable
// in production than asking the model for 0-based indices or raw
// UUIDs (which it doesn't see at decision time — they're allocated by
// `buildPlan` after parsing). `buildPlan` resolves these refs to
// pre-allocated lesson UUIDs; refs that don't resolve OR that point at
// the current lesson / a later lesson in reading order are dropped
// with a warning. The earlier-only rule keeps the resulting graph
// acyclic by construction so the writer can always read a dep's
// committed body before its dependent runs.
const LessonRefSchema = z.object({
  chapter: z.number().int().positive(),
  lesson: z.number().int().positive(),
});

const PlannedLessonSchema = z.object({
  title: z.string().min(1),
  brief: z.string().default(""),
  learning_objectives: z.array(LearningObjectiveSchema).default([]),
  prerequisites: z.array(z.string()).default([]),
  key_terms: z.array(z.string()).default([]),
  worked_example_seed: z.string().default(""),
  assessment_idea: z.string().default(""),
  duration_min: z.number().int().nonnegative().default(0),
  depends_on: z.array(LessonRefSchema).default([]),
});

const PlannedChapterSchema = z.object({
  title: z.string().min(1),
  outcomes: z.array(z.string()).default([]),
  prerequisites: z.array(z.string()).default([]),
  lessons: z.array(PlannedLessonSchema).min(1).max(6),
});

const Decision = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("search"),
    goal: z.string().min(1),
    topics: z.array(z.string().min(1)).min(1).max(6),
    user_message: z.string().min(1),
  }),
  z.object({
    action: z.literal("write"),
    title: z.string().min(1),
    description: z.string().default(""),
    audience: AudienceSchema.optional(),
    scope: ScopeSchema.optional(),
    pedagogy: PedagogySchema.optional(),
    chapters: z.array(PlannedChapterSchema).min(1).max(8),
    user_message: z.string().min(1),
  }),
  z.object({
    action: z.literal("ask"),
    question: z.string().min(1),
    suggestions: z
      .array(
        z.object({
          value: z.string().min(1),
          label: z.string().optional(),
          recommended: z.boolean().optional(),
        }),
      )
      .max(6)
      .default([]),
    allow_free_text: z.boolean().default(true),
    user_message: z.string().min(1),
  }),
  // Pre-research intake — emits a structured `intake_form` interrupt
  // instead of a freeform ask. The supervisor optionally pre-fills any
  // fields it could infer from the user's first message; the FE renders
  // the rest as form controls. Resume payload is structured JSON, not
  // prose, so non-English replies don't need natural-language parsing.
  z.object({
    action: z.literal("intake"),
    question: z.string().min(1),
    user_message: z.string().min(1),
    fields: z
      .array(
        z.enum([
          "audience_level",
          "prior_knowledge",
          "duration_hours",
          "language",
          "target_outcome",
        ]),
      )
      .min(1)
      .default([
        "audience_level",
        "prior_knowledge",
        "duration_hours",
        "language",
        "target_outcome",
      ]),
    defaults: z
      .object({
        audience_level: z
          .enum(["school", "undergrad", "grad", "professional"])
          .optional(),
        prior_knowledge: z.array(z.string()).optional(),
        duration_hours: z.number().optional(),
        language: z.string().optional(),
        target_outcome: z.string().optional(),
      })
      .default({}),
  }),
  z.object({
    action: z.literal("reply"),
    user_message: z.string().min(1),
  }),
]);
type DecisionType = z.infer<typeof Decision>;

const DECISION_INSTRUCTIONS = `You are the Supervisor of a syllabus-generation agent. Your job is NOT to write the lessons themselves — it is to decide one of five actions per turn ("intake", "search", "ask", "write", "reply") and to design a pedagogically sound plan that the writer can execute. Reply with STRICT JSON only — no prose outside the JSON.

You are designing a syllabus a teacher should be able to use to teach real students right away. That standard runs through every decision: what to research, what to ask, how to structure chapters, and what learning objectives each lesson must hit.

IMPORTANT — field order: ALWAYS emit "user_message" as the FIRST key in the JSON object, before "action" and any other fields. The chat UI streams the user_message text live as you produce it; putting it first means the user sees your reply typing immediately instead of waiting for the routing fields to finish.

Schema (one of):
{"user_message":"<one-sentence status>","action":"search","goal":"<one-sentence research goal>","topics":["<content topic 1>","<content topic 2>","<pedagogical topic>"]}
{"user_message":"<≤60 words; preview structure, audience, total duration>",
 "action":"write",
 "title":"<syllabus title>",
 "description":"<2–3 sentence overview>",
 "audience":{"level":"school|undergrad|grad|professional","prior_knowledge":["..."],"language":"<language>"},
 "scope":{"duration_hours":<number>,"target_outcome":"<one sentence>","constraints":["..."]},
 "pedagogy":{"style":"lecture|lab|flipped|self_study","assessment":"formative|summative|mixed","differentiation":<boolean>},
 "chapters":[{
   "title":"<chapter title>",
   "outcomes":["By the end of this chapter, students will be able to ...","..."],
   "prerequisites":["..."],
   "lessons":[{
     "title":"<lesson title>",
     "brief":"<1–2 sentence scope of what this lesson covers>",
     "learning_objectives":[
       {"text":"By the end of this lesson, you will be able to <action verb> ...","bloom_level":"remember|understand|apply|analyze|evaluate|create"}
     ],
     "prerequisites":["..."],
     "key_terms":["..."],
     "worked_example_seed":"<concrete scenario, not 'an example of X'>",
     "assessment_idea":"<1 sentence; aligns to ONE specific LO>",
     "duration_min":<integer>,
     "depends_on":[{"chapter":<int>,"lesson":<int>}]
   }]
 }]}
{"user_message":"<≤30 words; tell the user you need a few setup details before researching>","action":"intake","question":"<one-sentence framing of why you need these inputs>","fields":["audience_level","prior_knowledge","duration_hours","language","target_outcome"],"defaults":{"audience_level":"undergrad","prior_knowledge":["..."],"duration_hours":6,"language":"<USER_LANGUAGE>","target_outcome":"..."}}
{"user_message":"<one-sentence framing>","action":"ask","question":"<the question>","suggestions":[{"value":"option A","recommended":true},{"value":"option B"}],"allow_free_text":true}
{"user_message":"<conversational reply>","action":"reply"}

Rules — language:
- A USER_LANGUAGE pin is provided in a separate system message. Reply in that exact language. The user_message, question, suggestion values, syllabus title, chapter and lesson titles, briefs, outcomes, learning_objectives.text, key_terms, worked_example_seed, and assessment_idea ALL must match it. Never switch languages mid-conversation.
- If the user writes "Hi" / "hello" / "hey" the pin will be English — reply in English. Do NOT respond in Spanish, German, French, etc. unless USER_LANGUAGE explicitly says so.

Rules — when to "search":
- For brand-new syllabus requests, choose "search" first.
- Topics: 3–6 total, mix of CONTENT topics (noun phrases you'd paste into Google verbatim — official docs, established textbook subjects) and at least 1–2 PEDAGOGICAL topics that target teaching signals. Examples of pedagogical topics: "common misconceptions about <subject>", "prerequisite knowledge for <subject>", "<subject> curriculum standards ACM/IEEE/IB/Common Core/NGSS", "assessment patterns for introductory <subject> courses", "worked example archetypes for <subject>", "typical pacing for a <duration> course on <subject>".
- Avoid topics that overlap each other.
- Skip "search" when the user gave you a fully-specified, well-known topic AND your prior knowledge is sufficient (rare for technical topics).

Rules — when to "intake":
- "intake" is the FIRST possible action on a brand-new syllabus build, BEFORE any search. It emits a STRUCTURED form (audience level, prior knowledge tags, duration in hours, language, target outcome) instead of a freeform question — the user submits typed JSON, not prose.
- Use "intake" exactly ONCE per build, on turn 1, when the user's first message is missing ANY of these load-bearing inputs: audience level, time budget, target outcome.
- Skip "intake" only when the user's first message ALREADY pins down audience level, duration, AND a clear target outcome. (If they say "build me a 6-hour intro to graph databases for undergrads ending in a Cypher mini-project" — skip intake and go straight to "search".)
- "fields" — list only the inputs you genuinely need. If the user already gave you audience_level explicitly, omit it from "fields" so the form doesn't re-ask. Always include "audience_level", "duration_hours", and "target_outcome" UNLESS they were stated. Always include "prior_knowledge" (it's almost never volunteered upfront). Always include "language" UNLESS the user wrote in clear English/known language.
- "defaults" — pre-fill anything you could infer. The form is editable, so an inferred-but-wrong default is better than blank. For language, default to USER_LANGUAGE.
- "question" should be one short sentence framing why these inputs matter (e.g. "Quick setup so the syllabus matches your students and time budget."). NOT a list of sub-questions — the form fields are the questions.
- "user_message" is what the user sees in chat under the form (e.g. "Before I research, a couple of setup details — pick your audience and time budget so the syllabus fits.").
- The graph pauses on intake. The user's structured response arrives as a synthesized human turn that begins with "[Intake]" and lists each field. On your NEXT turn, treat those values as load-bearing constraints — they MUST flow into the eventual write decision's audience.level / scope.duration_hours / scope.target_outcome / audience.language fields.

Rules — when to "ask" (post-research clarify only):
- "ask" is now reserved for POST-RESEARCH CLARIFY. Use it AFTER the research summary lands, NEVER before — pre-research uncertainty goes through "intake" instead.
- Cap: at most TWO "ask" turns per build (down from 2 + 1 pre-research; intake replaces the pre-research slot).
- ONLY ask when the research summary surfaced a CONCRETE ambiguity that materially changes the syllabus shape. Specific allowed triggers (use exact wording in your reasoning to yourself; don't paste this list into the question):
  • Two source types disagree on the canonical framing of the topic (e.g. textbook vs reference doc treats "transactions" with materially different scope) — ask which framing to align to. Cite the source types neutrally.
  • The user's intake duration_hours doesn't fit cleanly into the chapter count the research suggests (e.g. research surfaces 6 standard sub-topics but user gave you 4h — ask whether to compress to 3 chapters or extend to 6h).
  • A prerequisite the picker surfaced is NOT in audience.prior_knowledge AND is too foundational to teach inline — ask whether to include a prerequisite chapter or assume it.
  • Multiple legitimate curriculum standards apply (ACM CS2013 vs IEEE vs IB vs an industry cert) — ask which to align to.
  • The audience level + assessment style combination is ambiguous (e.g. undergrad + summative could mean a final project OR a written exam) — ask which.
- FORBIDDEN ask triggers (the critic / system will count these as wasted turns):
  • Anything that the intake form ALREADY captured.
  • "Is this scope OK?" / "Does this look right?" — checkpoint asks add no information.
  • Asking the user to choose between two ways YOU could phrase the same thing.
  • Asking about font, style, output format, or anything cosmetic.
- Each "ask" must be answerable in one click: provide 2–4 concrete, distinct suggestions and ONE recommended default. Include an "I'm not sure — pick a sensible default" suggestion if the user reasonably can't choose.
- The graph pauses until the user answers; their answer arrives as the next human turn.

Rules — when to "write":
- Choose "write" once research is sufficient AND any required asks have been answered.
- "write" payload requirements (every one is mandatory; the critic will fail lessons whose contract is incomplete):
  • audience.level: pick from the user's intake answer or research/default. audience.language MUST equal USER_LANGUAGE.
  • scope.duration_hours: total estimated learner time. Tune chapter / lesson counts to fit. Default 6h for an undergrad mini-course, 12h for a regular course, 24h for a semester. Adjust based on user statement.
  • pedagogy.style: pick one. Affects how the writer treats examples (labs need code-along, lectures need worked-example narratives, flipped needs pre-class readings, self_study needs more checks-for-understanding).
  • chapters: 2–6. Each chapter MUST have outcomes (chapter-level "students will be able to ..." statements, 2–4 of them). Sequence chapters: prerequisites of chapter N must be covered by outcomes of chapters 1..N-1 OR by audience.prior_knowledge. Forbid forward references.
  • lessons per chapter: 2–4 typically; up to 6 for short, focused lessons. Each lesson MUST have:
    - learning_objectives: 2–4 entries. Each LO starts with "By the end of this lesson, you will be able to ..." and uses an OBSERVABLE action verb (explain, implement, compare, evaluate, design, derive, classify, predict, debug). FORBID vague verbs: "understand", "know", "be familiar with", "appreciate", "be aware of". The critic fails lessons that use these.
    - bloom_level per LO: at least one lesson per chapter MUST have at least one LO at "apply" or higher. A chapter that stays entirely at remember/understand produces lectures, not learning. The critic fails the lesson that should have lifted the chapter's Bloom ceiling but didn't.
    - prerequisites: refer to outcomes of earlier lessons in the same syllabus, or to audience.prior_knowledge. Forbid forward references.
    - key_terms: 3–8 terms the lesson defines or uses. The writer renders these in a key-terms section.
    - worked_example_seed: a SPECIFIC scenario, not "an example illustrating X". E.g. for SQL JOINs: "a library database with books and authors where every book has at least one author and we want to list books with their author names". The writer turns it into a step-by-step worked example.
    - assessment_idea: ONE concrete formative assessment idea aligned to ONE specific LO. E.g. "Given a flawed query, identify which JOIN type would correct the result". Forbid generic ideas like "ask students questions".
    - duration_min: 15–60. Sum of all lesson duration_min across the syllabus must be within ±20% of scope.duration_hours * 60. The writer scales the lesson length accordingly.
    - depends_on: explicit, structured pointers to EARLIER lessons (in any chapter) whose accepted bodies this lesson references or builds on. Each entry is {"chapter":<1-indexed chapter number>,"lesson":<1-indexed lesson number within that chapter>}. Use this for any lesson that needs the writer to literally re-use a term, example, or result from an earlier lesson — the writer is given the dep lesson's body as context, so it can reference it precisely instead of redefining it. Cross-chapter is fine; the rule is only that {chapter,lesson} must come BEFORE the current lesson in reading order (chapter < current chapter, OR same chapter and lesson < current lesson). Do NOT add deps for lessons that merely share a topic — only add when the LATER lesson concretely builds on the EARLIER one. Lessons that are independent (the most common case for sibling lessons inside a chapter) MUST emit []. Self-references and forward references will be dropped server-side.
- Be specific in titles — every chapter and lesson title should describe a single, learnable, gradeable concept.
- "user_message" for "write": ≤60 words. Preview structure (chapter count, total lessons, total duration) and audience level. Plain prose. Example: "Here's a 6-hour undergrad syllabus on 'Intro to Graph Databases' — 3 chapters, 9 lessons, ending with a hands-on Cypher mini-project. The writer will start in a moment."

Rules — when to "reply":
- Greetings, clarifications, refusals, and follow-up turns AFTER a syllabus has been committed. Keep it short and friendly. Do NOT include lesson markdown, JSON, or instructor notes.
- If a syllabus already exists for this thread (a FACT will be injected) choose "reply" unless explicitly asked to extend or revise.

General rules:
- Output exactly one JSON object. No code fences. No commentary. No additional keys.
- "user_message" is the ONLY text the user will see for that turn. Never put markdown lessons or raw JSON inside it.`;

/**
 * The supervisor is an LLM-driven router. It outputs a structured Decision
 * each turn; the orchestrator routes search/write to subgraphs and "reply"
 * to END. The supervisor's `user_message` is what streams to the chat pane.
 */
@Injectable()
export class SupervisorNode {
  private readonly logger = new Logger(SupervisorNode.name);

  constructor(
    private readonly llm: LlmConfigService,
    private readonly supa: SupabaseService,
  ) {}

  /**
   * Run the supervisor LLM and return the parsed decision plus the
   * AIMessage that should be appended to state (for memory).
   */
  async decide(state: GraphStateType): Promise<{
    decision: DecisionType;
    aiMessage: AIMessage;
  }> {
    const ctx = await this.buildContext(state);
    const lang = this.detectConversationLanguage(state.messages);
    const messages: BaseMessage[] = [new SystemMessage(DECISION_INSTRUCTIONS)];
    messages.push(
      new SystemMessage(
        `USER_LANGUAGE: ${lang}. All user-visible text in the JSON output (user_message, question, suggestion values, syllabus title, chapter and lesson titles, briefs) MUST be in ${lang}. Stick to ${lang} for the rest of this thread; do not switch even if the model is multilingual.`,
      ),
    );
    if (ctx) messages.push(new SystemMessage(ctx));
    messages.push(...this.compactHistory(state.messages));

    const llm = this.llm
      .get("supervisor", { temperature: 0 })
      .bind({ response_format: { type: "json_object" } });
    const llmModel = this.llm.rawConfig("supervisor").model;
    // Stream the JSON envelope and extract `user_message` characters
    // live as they arrive, dispatching one `assistant_text_token`
    // custom event per chunk. The chat controller pipes those tokens
    // straight into the wire's text frames so the user sees the
    // assistant turn type in real time instead of waiting 10–30s for
    // the full envelope. The structured fields (`action`, `topics`,
    // `chapters`, …) still come from a single Zod parse over the
    // complete buffer once the stream closes — routing remains
    // deterministic and unchanged.
    const text = (
      await streamLlmAndExtractStructure(llm, messages, {
        textField: "user_message",
        node: "supervisor",
        tier: "supervisor",
        model: llmModel,
        paths: this.buildDraftPathSubscriptions(),
      })
    ).trim();
    const decision = this.parseDecision(text);
    return {
      decision,
      aiMessage: new AIMessage(decision.user_message),
    };
  }

  /**
   * Path subscribers fired against the supervisor's streaming JSON
   * envelope. Each handler dispatches the same custom event the chat
   * controller already consumes for the corresponding subgraph live
   * progress (`research_progress`, `todo_progress`, `interrupt_progress`),
   * so the controller-side wiring is reused unchanged.
   *
   * Drafts are stamped with `__draft: true` so the FE can apply a
   * shimmer / pulse treatment until the eventual `on_chain_end` snapshot
   * lands and the `emit()` dedupe drops the marker. IDs are synthesized
   * deterministically (`s${i}` for research steps to match the search
   * planner; `draft-…` for chapter / lesson rows since their real UUIDs
   * are only allocated by `buildPlan` after the envelope finishes
   * parsing — the on_chain_end emit overwrites the draft snapshot
   * wholesale, so the synthetic ids never reach durable storage).
   */
  private buildDraftPathSubscriptions() {
    // Cumulative draft state for the `write` decision branch — chapters
    // and lessons trickle in over many parser callbacks, so we keep an
    // accumulator and re-emit the full snapshot each time.
    const todo: TodoStep[] = [];
    const manifest: ManifestItem[] = [];
    const seenLessonIds = new Set<string>();

    // Cumulative draft state for `ask` / `intake`. Same envelope, two
    // shapes. The `action` key lands before the variant fields (the
    // supervisor prompt forces user_message → action → variant), so we
    // resolve the kind from `action` and only dispatch interrupts once
    // it's known. This avoids a brief flicker where an `intake` turn's
    // `question` would render as an AskCard before `fields` arrived.
    //
    // `resolvedKind` stays null for `search` / `write` / `reply` — those
    // never produce an interrupt slice. `pendingDispatch` queues a
    // dispatch for the rare case where `question` happens to land
    // before `action`; it's flushed once action resolves.
    const interruptDraft: AgentInterrupt = {
      id: "draft-interrupt",
      kind: "ask",
      question: "",
      suggestions: [],
      allow_free_text: true,
      answer: null,
      intake: null,
      intake_answer: null,
      activity_intake: null,
      activity_intake_answer: null,
      __draft: true,
    };
    let resolvedKind: "ask" | "intake_form" | null = null;
    let pendingDispatch = false;

    const dispatchInterrupt = () => {
      if (resolvedKind === null) {
        // Action hasn't landed yet — buffer and flush once it does so
        // we don't ship an AskCard with the wrong kind for an intake
        // turn (or vice versa). The deferred dispatch is at most one
        // frame late, after `action` arrives.
        pendingDispatch = true;
        return;
      }
      void dispatchCustomEvent("interrupt_progress", {
        interrupt: { ...interruptDraft },
      }).catch(() => {
        /* best-effort */
      });
    };

    const dispatchTodo = () => {
      const todoPlan: TodoPlan = { steps: [...todo], __draft: true };
      void dispatchCustomEvent("todo_progress", {
        todo_plan: todoPlan,
        manifest: [...manifest],
      }).catch(() => {
        /* best-effort */
      });
    };

    return [
      // ── action → resolve interrupt kind, flush deferred dispatch ─────
      // The supervisor prompt forces field order user_message → action
      // → variant fields, so this typically resolves before any of the
      // interrupt-shaped fields (`question` / `suggestions` / `fields`
      // / `defaults`) land. For `search` / `write` / `reply` we leave
      // `resolvedKind` null — those decisions never produce an
      // interrupt slice, so any deferred draft is silently dropped.
      {
        path: "action",
        handler: (value: unknown) => {
          if (value === "ask") resolvedKind = "ask";
          else if (value === "intake") resolvedKind = "intake_form";
          else return;
          interruptDraft.kind = resolvedKind;
          if (pendingDispatch) {
            pendingDispatch = false;
            dispatchInterrupt();
          }
        },
      },
      // ── search.topics[*] → research_plan draft ─────────────────────
      {
        path: "topics.*",
        handler: (value: unknown, indices: (string | number)[]) => {
          const i = Number(indices[0]);
          if (!Number.isInteger(i) || typeof value !== "string") return;
          const patch: Partial<ResearchStep> & { id: string } = {
            id: `s${i}`,
            title: value,
            queries: [value],
            status: "pending",
            picked_count: 0,
            scraped_count: 0,
            __draft: true,
          };
          void dispatchCustomEvent("research_progress", {
            step_id: patch.id,
            patch,
          }).catch(() => {
            /* best-effort */
          });
        },
      },
      // ── write.chapters[*] → todo_plan + manifest draft ─────────────
      // Each completed chapter object is appended cumulatively. The
      // controller's `todo_progress` handler emits both `todo_plan`
      // and `manifest` via `emit()` which dedupes by JSON.stringify,
      // so re-emitting the growing snapshot is cheap.
      {
        path: "chapters.*",
        handler: (value: unknown, indices: (string | number)[]) => {
          const ci = Number(indices[0]);
          if (!Number.isInteger(ci) || !value || typeof value !== "object")
            return;
          const ch = value as {
            title?: unknown;
            lessons?: Array<{ title?: unknown }>;
          };
          const chapterTitle =
            typeof ch.title === "string" ? ch.title : `Chapter ${ci + 1}`;
          const lessons = Array.isArray(ch.lessons) ? ch.lessons : [];
          for (let li = 0; li < lessons.length; li++) {
            const lessonId = `draft-c${ci}-l${li}`;
            if (seenLessonIds.has(lessonId)) continue;
            seenLessonIds.add(lessonId);
            const lessonTitle =
              typeof lessons[li]?.title === "string"
                ? (lessons[li].title as string)
                : `Lesson ${li + 1}`;
            todo.push({
              id: lessonId,
              chapter_ref: chapterTitle,
              name: lessonTitle,
              status: "pending",
              attempts: 0,
              __draft: true,
            });
            manifest.push({
              id: lessonId,
              title: lessonTitle,
              chapter_title: chapterTitle,
              status: "pending",
              db_id: null,
              review_required: false,
              block_issues: [],
              critic_issues: [],
              // Streaming-envelope rows don't yet carry the supervisor's
              // dependency allocations — those land on the manifest when
              // the command subgraph seeds plans from the final typed
              // output. Leaving this empty here means the FE shows no
              // "depends on …" line until the typed plan replaces the
              // __draft row, which matches what the user sees for every
              // other contract field at this point in the flow.
              depends_on: [],
              __draft: true,
            });
          }
          dispatchTodo();
        },
      },
      // ── ask / intake.question → interrupt draft ────────────────────
      {
        path: "question",
        handler: (value: unknown) => {
          if (typeof value !== "string") return;
          interruptDraft.question = value;
          dispatchInterrupt();
        },
      },
      // ── ask.suggestions[*] → interrupt draft ────────────────────────
      {
        path: "suggestions.*",
        handler: (value: unknown, indices: (string | number)[]) => {
          const i = Number(indices[0]);
          if (!Number.isInteger(i) || !value || typeof value !== "object")
            return;
          const sug = value as {
            value?: unknown;
            label?: unknown;
            recommended?: unknown;
          };
          if (typeof sug.value !== "string") return;
          interruptDraft.suggestions[i] = {
            id: `draft-sug-${i}`,
            value: sug.value,
            label: typeof sug.label === "string" ? sug.label : undefined,
            recommended:
              typeof sug.recommended === "boolean" ? sug.recommended : undefined,
          };
          dispatchInterrupt();
        },
      },
      // ── intake.fields[*] / intake.defaults → interrupt draft ───────
      {
        path: "fields.*",
        handler: (value: unknown, indices: (string | number)[]) => {
          const i = Number(indices[0]);
          if (!Number.isInteger(i) || typeof value !== "string") return;
          if (!interruptDraft.intake) {
            interruptDraft.intake = { fields: [], defaults: {} };
          }
          // Cast through `unknown`: the value is already validated as a
          // string at runtime, and the post-stream Zod parse will reject
          // unknown enum members — drafts that the model later corrects
          // are replaced wholesale by the on_chain_end snapshot.
          interruptDraft.intake.fields[i] =
            value as unknown as (typeof interruptDraft.intake.fields)[number];
          dispatchInterrupt();
        },
      },
      {
        path: "defaults",
        handler: (value: unknown) => {
          if (!value || typeof value !== "object") return;
          if (!interruptDraft.intake) {
            interruptDraft.intake = { fields: [], defaults: {} };
          }
          interruptDraft.intake.defaults = {
            ...(value as typeof interruptDraft.intake.defaults),
          };
          dispatchInterrupt();
        },
      },
    ];
  }

  /**
   * Build a structured plan ready for the command subgraph. UUIDs allocated
   * here are reused as cache keys, manifest ids, and DB primary keys —
   * which is exactly how committer retries become idempotent UPSERTs.
   */
  buildPlan(decision: Extract<DecisionType, { action: "write" }>): SyllabusPlan {
    const syllabus_id = uuidv4();

    // Pass 1 — allocate ids and stash a (chapter,lesson) → (uuid,
    // flatIndex) lookup. Keys are 1-indexed to mirror the supervisor's
    // wire shape exactly so dep refs translate without arithmetic
    // surprises. flatIndex (reading-order rank) makes the forward-ref
    // check in pass 2 a single integer compare.
    const chapters = decision.chapters.map((c, ci) => ({
      id: uuidv4(),
      title: c.title,
      order_index: ci,
      outcomes: c.outcomes,
      prerequisites: c.prerequisites,
      lessons: c.lessons.map((l) => ({ ...l, id: uuidv4() })),
    }));
    const idTable = new Map<
      string,
      { uuid: string; flatIndex: number }
    >();
    {
      let flat = 0;
      for (let ci = 0; ci < chapters.length; ci++) {
        for (let li = 0; li < chapters[ci].lessons.length; li++) {
          idTable.set(`${ci + 1}.${li + 1}`, {
            uuid: chapters[ci].lessons[li].id,
            flatIndex: flat,
          });
          flat += 1;
        }
      }
    }

    // Pass 2 — resolve depends_on refs to UUIDs. Drop unresolved /
    // self / forward references with a logger.warn so a misbehaving
    // supervisor turn never aborts the build; the FE Viewer just
    // shows the dependent lesson with no "depends on" chip.
    let cur = 0;
    const resolvedChapters = chapters.map((c, ci) => ({
      id: c.id,
      title: c.title,
      order_index: c.order_index,
      outcomes: c.outcomes,
      prerequisites: c.prerequisites,
      lessons: c.lessons.map((l, li) => {
        const here = cur;
        cur += 1;
        const decisionLesson = decision.chapters[ci].lessons[li];
        const deps: string[] = [];
        for (const ref of decisionLesson.depends_on ?? []) {
          const key = `${ref.chapter}.${ref.lesson}`;
          const hit = idTable.get(key);
          if (!hit) {
            this.logger.warn(
              `dropping unresolved dep ref ${key} on ${ci + 1}.${li + 1} "${l.title}"`,
            );
            continue;
          }
          if (hit.flatIndex >= here) {
            this.logger.warn(
              `dropping forward/self dep ref ${key} on ${ci + 1}.${li + 1} "${l.title}"`,
            );
            continue;
          }
          if (deps.includes(hit.uuid)) continue;
          deps.push(hit.uuid);
        }
        return {
          id: l.id,
          title: l.title,
          brief: l.brief,
          learning_objectives: l.learning_objectives,
          prerequisites: l.prerequisites,
          key_terms: l.key_terms,
          worked_example_seed: l.worked_example_seed,
          assessment_idea: l.assessment_idea,
          duration_min: l.duration_min,
          depends_on: deps,
        };
      }),
    }));

    return {
      syllabus_id,
      title: decision.title,
      description: decision.description,
      audience: decision.audience,
      scope: decision.scope,
      pedagogy: decision.pedagogy,
      chapters: resolvedChapters,
    };
  }

  /**
   * Inject DB facts the supervisor needs:
   *  - whether a syllabus already exists for this thread (so it doesn't
   *    pile up duplicates / triggers an "I've already built it" reply);
   *  - the latest search_summary, so post-research turns choose "write".
   */
  private async buildContext(state: GraphStateType): Promise<string | null> {
    const parts: string[] = [];
    if (state.thread_id) {
      const { data } = await this.supa.client
        .from("syllabuses")
        .select("id,title")
        .eq("thread_id", state.thread_id)
        .maybeSingle();
      if (data) {
        parts.push(
          `FACT: A syllabus titled "${data.title}" already exists for this thread (id=${data.id}). For follow-up turns choose "reply" unless explicitly asked to extend.`,
        );
      }
    }
    if (state.search_summary) {
      parts.push(
        `FACT: Background research summary is available below — use it to plan. After reading, the next action should be "write".\n\n=== RESEARCH SUMMARY ===\n${state.search_summary}\n=== END ===`,
      );
    }
    return parts.length ? parts.join("\n\n") : null;
  }

  /**
   * Detect the conversation language from the FIRST user turn and use that
   * for the rest of the thread. Pinning early avoids flip-flopping when
   * later turns are short ("ok", "continue") and provide no signal.
   *
   * Heuristic only — script ranges first, then a small set of stopwords for
   * the common Latin-script languages. Misdetections fall back to English,
   * which is the safest default for a tool that targets developers.
   */
  /**
   * Public so the parent graph can attach the conversation language to the
   * search subgraph state, keeping the summarizer/picker aligned with the
   * supervisor's USER_LANGUAGE pin without re-detecting.
   */
  detectLanguage(history: BaseMessage[]): string {
    return this.detectConversationLanguage(history);
  }

  private detectConversationLanguage(history: BaseMessage[]): string {
    const firstHuman = history.find((m) => m instanceof HumanMessage);
    const text = String(firstHuman?.content ?? "").toLowerCase().trim();
    if (!text) return "English";

    if (/[\u0600-\u06FF]/.test(text)) return "Arabic";
    if (/[\u0400-\u04FF]/.test(text)) return "Russian";
    if (/[\u4E00-\u9FFF]/.test(text)) return "Chinese";
    if (/[\u3040-\u30FF]/.test(text)) return "Japanese";
    if (/[\uAC00-\uD7AF]/.test(text)) return "Korean";
    if (/[\u0590-\u05FF]/.test(text)) return "Hebrew";
    if (/[\u0900-\u097F]/.test(text)) return "Hindi";

    // Use Unicode-aware word boundaries instead of `\b`. JavaScript's
    // `\b` is anchored on `\w` (= `[A-Za-z0-9_]`) and never fires next
    // to accented letters like `é`, `á`, `ù`, so patterns ending in
    // `qué`, `olá`, `où`, `perché` would silently never match. The
    // lookarounds below treat any Unicode letter or digit as a word
    // character, so `olá` correctly matches in `Olá amigo`.
    const NB = "(?<![\\p{L}\\p{N}])"; // not preceded by a letter/digit
    const NA = "(?![\\p{L}\\p{N}])"; //   not followed by a letter/digit
    const word = (alts: string) => new RegExp(`${NB}(?:${alts})${NA}`, "u");

    const tests: Array<[string, RegExp]> = [
      [
        "Spanish",
        // Avoid English homographs like "soy" (soy milk / soy sauce).
        word(
          "hola|qué|cómo|gracias|por\\s+favor|señor|señora|necesito|quiero|estoy|tengo|hablar|español",
        ),
      ],
      [
        "French",
        // Avoid English homographs like "comment" / "tout" / "je" alone.
        // Stick to clearly French tokens.
        word(
          "bonjour|salut|merci|s'il\\s+vous\\s+plaît|je\\s+suis|j'ai|c'est|où|qu'est-ce|français",
        ),
      ],
      [
        "German",
        word(
          "hallo|guten\\s+tag|danke|bitte|wie|ich\\s+bin|ich\\s+habe|nicht|sehr|deutsch",
        ),
      ],
      [
        "Italian",
        // Avoid English homographs like "come" / "sono" / "dove".
        word("ciao|grazie|prego|cosa|perché|italiano|buongiorno"),
      ],
      [
        "Portuguese",
        word(
          "olá|obrigado|obrigada|por\\s+favor|como|estou|sou|onde|português",
        ),
      ],
      ["Dutch", word("hallo|hoi|dank\\s+je|alstublieft|nederlands")],
      ["Turkish", word("merhaba|selam|teşekkür|nasıl|türkçe")],
    ];
    for (const [name, re] of tests) {
      if (re.test(text)) return name;
    }
    return "English";
  }

  /**
   * The supervisor only needs short conversational context, not every
   * scraped page. Keep the last 8 messages and replace ToolMessage content
   * with a one-line marker since their body lives in `state.search_summary`.
   *
   * Strip trailing AIMessages before returning. After a `search` decision
   * the graph loops back through `search_summarizer → supervisor`, and the
   * supervisor's own previous user-facing status (an AIMessage) is the
   * tail of `state.messages`. Sending that to the supervisor LLM as the
   * last message makes chat templates that require the conversation to
   * end with `system|user|tool` (e.g. NVIDIA Nemotron) refuse with
   * `400 Cannot set add_generation_prompt to True when the last message
   * is from the assistant`. The supervisor's previous status carries no
   * context the next decision needs — the research summary is already
   * injected as a SystemMessage in `buildContext`. Dropping it leaves
   * the prompt ending on the user's turn (or a ToolMessage marker),
   * which every chat template accepts.
   */
  private compactHistory(history: BaseMessage[]): BaseMessage[] {
    let end = history.length;
    while (end > 0 && history[end - 1] instanceof AIMessage) end--;

    // Audit §2.5 pin set: in addition to the recent window we always
    // surface (a) the very first user turn — carries the load-bearing
    // build prompt the rest of the conversation refers back to — and
    // (b) the most recent synthesized intake submission (a HumanMessage
    // whose content begins with "[Intake]" or "[Activity Intake]"), so
    // the supervisor never loses sight of the structured constraints
    // (audience level, duration, language, picked lessons, …) that
    // shape every downstream `write` decision. Without these pins, a
    // sufficiently long activity-tooled thread used to drift back to
    // re-asking which lesson to ground in even right after the user
    // had submitted the activity intake — the answer scrolled out of
    // the 8-message window. The recent window is reduced from 8 to 6
    // to keep the average prompt size flat.
    const RECENT_WINDOW = 6;
    const pinIndices = new Set<number>();

    const firstHumanIdx = history.findIndex((m) => m instanceof HumanMessage);
    if (firstHumanIdx !== -1) pinIndices.add(firstHumanIdx);

    for (let i = end - 1; i >= 0; i--) {
      const m = history[i];
      if (!(m instanceof HumanMessage)) continue;
      const txt = String(m.content ?? "");
      if (
        txt.startsWith("[Intake]") ||
        txt.startsWith("[Activity Intake]")
      ) {
        pinIndices.add(i);
        break;
      }
    }

    const recentStart = Math.max(0, end - RECENT_WINDOW);
    const indices = new Set<number>(pinIndices);
    for (let i = recentStart; i < end; i++) indices.add(i);

    const ordered = Array.from(indices).sort((a, b) => a - b);
    const compacted = ordered.map((i) => history[i]);

    return compacted.map((m) => {
      if (m instanceof ToolMessage) {
        return new ToolMessage({
          content: "[tool result available in research summary]",
          tool_call_id: m.tool_call_id ?? "supervisor",
        });
      }
      return m;
    });
  }

  private parseDecision(raw: string): DecisionType {
    const json = this.extractJson(raw);
    const parsed = Decision.safeParse(json);
    if (parsed.success) return parsed.data;
    this.logger.warn(
      `Supervisor JSON parse failed (${parsed.error.issues
        .map((i) => i.message)
        .join("; ")}). Raw=${JSON.stringify(raw).slice(0, 400)}`,
    );
    // Prefer the LLM's own `user_message` if it produced one — it
    // already typed onto the wire via the live token stream, and
    // overriding with the generic apology would make the controller's
    // suppression check miss and concatenate two assistant texts in a
    // single bubble. Fall back to the apology only when the field is
    // absent or empty (genuinely no user-visible text was produced).
    const streamedUserMessage =
      json &&
      typeof json === "object" &&
      "user_message" in json &&
      typeof (json as { user_message?: unknown }).user_message === "string" &&
      ((json as { user_message: string }).user_message as string).length > 0
        ? (json as { user_message: string }).user_message
        : null;
    return {
      action: "reply",
      user_message:
        streamedUserMessage ??
        "Sorry — I had trouble organizing my thoughts on that. Could you restate what you'd like me to build?",
    };
  }

  private extractJson(txt: string): unknown {
    const fenced = txt.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced?.[1] ?? txt;
    const m = candidate.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }

  /** Stream the decision's user_message back to the client one chunk at a time. */
  async *streamUserMessage(text: string): AsyncGenerator<string> {
    // Token-ish chunking so the chat pane animates rather than dumping at once.
    const chunkSize = 24;
    for (let i = 0; i < text.length; i += chunkSize) {
      yield text.slice(i, i + chunkSize);
      await new Promise((r) => setTimeout(r, 8));
    }
  }

  /**
   * Generate a brief, friendly closing message after the command
   * subgraph has committed every lesson. Called from the supervisor
   * node when `state.command_just_finalized` is set — bypasses the
   * regular Decision LLM (which might re-pick "write" / "search" and
   * loop) and produces a deterministic wrap-up reply instead.
   *
   * Falls back to a hardcoded message if the LLM call errors so the
   * user always sees a closing message even on transient failures.
   */
  async composeWrapUp(state: GraphStateType): Promise<AIMessage> {
    const plan = state.syllabus_plan;
    const manifest = state.manifest ?? [];
    const totalLessons = manifest.length;
    const succeeded = manifest.filter((m) => m.status === "done").length;
    const failed = totalLessons - succeeded;
    const chapterCount = plan?.chapters.length ?? 0;
    const audienceLevel = plan?.audience?.level ?? null;
    const totalDurationMin = (plan?.chapters ?? []).reduce(
      (n, c) => n + c.lessons.reduce((m, l) => m + (l.duration_min ?? 0), 0),
      0,
    );
    const totalDurationLabel =
      totalDurationMin > 0
        ? totalDurationMin >= 60
          ? `${Math.round(totalDurationMin / 60)}h`
          : `${totalDurationMin} min`
        : null;
    const lang = this.detectConversationLanguage(state.messages);

    const fallback = (): string => {
      if (!plan)
        return "All done — your syllabus is ready in the panel on the right. Open Lesson 1.1 to start.";
      const audiencePart = audienceLevel ? `${audienceLevel} ` : "";
      const durationPart = totalDurationLabel ? `, ~${totalDurationLabel}` : "";
      if (failed === 0) {
        return `Done — "${plan.title}" is ready: ${chapterCount} chapter${chapterCount === 1 ? "" : "s"}, ${totalLessons} ${audiencePart}lesson${totalLessons === 1 ? "" : "s"}${durationPart}. Open Lesson 1.1 in the tree to start.`;
      }
      return `Finished "${plan.title}" — ${succeeded} of ${totalLessons} lessons committed${durationPart}. ${failed} hit issues; ask me to retry those when you're ready.`;
    };

    const sys = new SystemMessage(
      `You are wrapping up a syllabus build. The writer has just committed every lesson to the database. ` +
        `Send ONE short, friendly closing message (≤60 words) to the user. ` +
        `It MUST: (1) confirm what was built (chapter count, lesson count, audience level, total duration in hours/minutes), ` +
        `and (2) end with ONE concrete next action (e.g. "Open Lesson 1.1 to start" or "Want me to add an instructor guide?"). ` +
        `Plain prose only — no JSON, no markdown headings, no code blocks, no bullet lists. ` +
        `LANGUAGE: respond strictly in ${lang}.`,
    );
    const user = new HumanMessage(
      plan
        ? `Syllabus title: "${plan.title}"\n` +
          `Chapters: ${chapterCount}\n` +
          `Lessons committed: ${succeeded} of ${totalLessons}` +
          (failed > 0 ? ` (${failed} failed and were skipped)` : "") +
          (audienceLevel ? `\nAudience level: ${audienceLevel}` : "") +
          (totalDurationLabel ? `\nTotal duration: ~${totalDurationLabel}` : "") +
          `\n\nWrite the closing message.`
        : `Syllabus committed (no plan summary available). Write a short closing message inviting the user to open Lesson 1.1.`,
    );
    try {
      const out = await this.llm.get("supervisor", { temperature: 0.3 }).invoke([sys, user]);
      await dispatchLlmUsage(out, {
        node: "supervisor:wrap_up",
        tier: "supervisor",
        model: this.llm.rawConfig("supervisor").model,
      });
      const text = String(out.content ?? "").trim();
      // Strip accidental code fences / JSON the model may wrap around it.
      const cleaned = text.replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
      return new AIMessage(cleaned || fallback());
    } catch (err) {
      this.logger.warn(`composeWrapUp LLM call failed: ${(err as Error).message}`);
      return new AIMessage(fallback());
    }
  }

  // helper for unused-imports check
  static keepHumanMessageImported = HumanMessage;
}

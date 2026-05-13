import { Callout } from "@/components/docs/Callout";
import { CriticGateSimulator } from "@/components/docs/CriticGateSimulator";
import { DocShell } from "@/components/docs/DocShell";
import { LessonTraceStepper } from "@/components/docs/LessonTraceStepper";
import { MermaidDiagram } from "@/components/docs/MermaidDiagram";
import { PatchApplierDemo } from "@/components/docs/PatchApplierDemo";

export const metadata = {
  title: "Syllabus Generator — Agent Architecture",
  description:
    "How the syllabus-generator agent works: supervisor routing, search subgraph, single-shot writer/critic gate with rehydration and patch-based revisions, and the off-state data plane.",
};

const TOP_LEVEL_GRAPH = `flowchart TD
    classDef router fill:#231a12,stroke:#f66e60,color:#f5ede3,stroke-width:2px;
    classDef search fill:#2e2218,stroke:#fcaf41,color:#f5ede3;
    classDef cmd fill:#2e2218,stroke:#4ade80,color:#f5ede3;
    classDef sink fill:#1a140e,stroke:#a08060,color:#a08060;

    START([user turn / resume]):::sink --> SUP{{supervisor<br/>LLM router}}:::router

    SUP -- "action: search" --> SP[search_planner]:::search
    SUP -- "action: write" --> CSP[command_seed_plans]:::cmd
    SUP -- "action: ask / intake / reply" --> END_TURN([end turn<br/>interrupt or final reply]):::sink

    SP -- "has next subquery" --> SS[search_step]:::search
    SP -- "no subqueries" --> SUM[search_summarizer]:::search
    SS -- "loop until exhausted" --> SS
    SS -- "done" --> SUM
    SUM --> SUP

    CSP --> CCS[command_commit_syllabus]:::cmd
    CCS -- "lessons > 0" --> CWO[command_write_one<br/>one WAVE per invocation:<br/>all ready lessons run in parallel]:::cmd
    CCS -- "no lessons (defensive)" --> CFIN[command_finalize]:::cmd
    CWO -- "committed < total" --> CWO
    CWO -- "all lessons committed" --> CFIN
    CFIN --> SUP
`;

const WRITER_CRITIC_LOOP = `flowchart TD
    classDef state fill:#231a12,stroke:#f66e60,color:#f5ede3;
    classDef llm   fill:#2e2218,stroke:#fcaf41,color:#f5ede3;
    classDef gate  fill:#1a140e,stroke:#4ade80,color:#f5ede3;
    classDef cache fill:#1a140e,stroke:#a08060,color:#fcaf41;
    classDef sink  fill:#1a140e,stroke:#a08060,color:#a08060;

    START([per-lesson cycle starts]):::sink --> R{{rehydrate from redis<br/>draft:thread:lesson}}:::cache
    R -- "prior draft exists" --> RM[revision mode = true<br/>attempt 0 starts with prior draft]:::state
    R -- "no prior draft" --> FRESH[revision mode = false<br/>attempt 0 generates from scratch]:::state

    RM --> WRITER
    FRESH --> WRITER

    WRITER{{writer LLM<br/>full-rewrite OR<br/>SEARCH/REPLACE blocks}}:::llm

    WRITER -- "fresh / fallback" --> NEW[markdown draft]:::state
    WRITER -- "patch blocks" --> APPLY{apply blocks<br/>fuzzy whitespace match<br/>refuse ambiguous}:::gate
    APPLY -- "ok" --> NEW
    APPLY -- "no match / ambiguous /<br/>FALLBACK_FULL_REWRITE" --> WRITER_FB[writer LLM<br/>full-rewrite fallback]:::llm
    WRITER_FB --> NEW

    NEW --> CRITIC{{critic LLM<br/>severity-aware<br/>block / warn / nit<br/>(invoked once)}}:::llm
    CRITIC --> GATE{pass &&<br/>blockCount === 0 ?}:::gate

    GATE -- "yes" --> COMMIT[commit lesson<br/>accepted=true<br/>findings dropped]:::state
    GATE -- "no" --> CACHE_W[cache.set draft<br/>TTL 30 min]:::cache
    CACHE_W --> WRITER_REV{{writer LLM<br/>revision-mode<br/>(no second critic call)}}:::llm
    WRITER_REV --> COMMIT2[commit lesson<br/>accepted=true<br/>findings dropped]:::state

    COMMIT --> CACHE_F[cache.set draft]:::cache
    COMMIT2 --> CACHE_F
    CACHE_F --> END_C([next lesson in wave<br/>or finalize]):::sink
`;

const LESSON_LIFECYCLE = `flowchart LR
    classDef start fill:#1a140e,stroke:#a08060,color:#a08060;
    classDef inflight fill:#231a12,stroke:#fcaf41,color:#f5ede3;
    classDef happy fill:#1a140e,stroke:#4ade80,color:#4ade80;
    classDef sad fill:#1a140e,stroke:#f66e60,color:#f66e60;

    INIT([no row yet]):::start --> PEND[pending<br/>row inserted by<br/>command_commit_syllabus]:::inflight
    PEND --> WRT[writing<br/>command_write_one<br/>attempt 0 starts]:::inflight
    WRT --> CRT[critique<br/>critic LLM done<br/>(invoked once)]:::inflight
    CRT -- "gate fails" --> REV[revising<br/>rehydrate +<br/>SEARCH/REPLACE blocks<br/>(no second critic call)]:::inflight
    CRT -- "gate passes<br/>(blockCount === 0)" --> ACC([accepted<br/>row promoted]):::happy
    REV --> ACC2([accepted<br/>findings dropped]):::happy
    ACC --> DONE([terminal]):::start
    ACC2 --> DONE
`;

const STREAMING_SEQUENCE = `sequenceDiagram
    autonumber
    participant FE as Chat UI
    participant API as NestJS API
    participant Redis as Redis Stream
    participant LG as LangGraph
    participant Reaper as Reaper

    FE->>API: POST /runs (user turn)
    API->>LG: execute graph (streamEvents v2)
    activate LG
    FE->>API: SSE subscribe ?after=lastEntryId
    API->>Redis: XRANGE backfill (reconnect replay)
    Redis-->>API: previous entries
    API-->>FE: backfilled slices
    par live fan-out
      API->>Redis: XREAD BLOCK (per replica)
    and graph progress
      LG->>API: on_chain_end (per node)
      API->>Redis: XADD MAXLEN ~ N {kind, value}
    end
    Redis-->>API: new entries
    API-->>FE: live slices (phase, manifest, ...)
    LG-->>API: done
    deactivate LG
    API->>Redis: XADD {kind:'done'} + EXPIRE 24h
    Redis-->>FE: done event

    Note over Reaper,Redis: every 5s, independent of any HTTP request
    Reaper->>API: scan agent_runs WHERE last_heartbeat < now-30s
    Reaper->>Redis: XADD synthetic {kind:'error'} for stuck runs
`;

const DATA_PLANE = `flowchart LR
    classDef state fill:#231a12,stroke:#f66e60,color:#f5ede3;
    classDef redis fill:#2e2218,stroke:#fcaf41,color:#f5ede3;
    classDef pg    fill:#2e2218,stroke:#4ade80,color:#f5ede3;
    classDef llm   fill:#1a140e,stroke:#a08060,color:#fcaf41;

    LLM(((LLM nodes))):::llm

    subgraph S [LangGraph state — hot, small]
      direction TB
      ST1[messages]:::state
      ST2[phase / next_route]:::state
      ST3[committed_lesson_ids set]:::state
      ST4[interrupt_payload]:::state
    end

    subgraph R [Redis — ephemeral, mid-sized]
      direction TB
      RD1[draft:thread:lesson<br/>30 min TTL]:::redis
      RD3[research scrape blobs]:::redis
      RD4[run:&lt;runId&gt;:events<br/>Redis Stream]:::redis
    end

    subgraph P [Supabase Postgres — durable, accepted only]
      direction TB
      PG1[syllabus / chapters / lessons rows]:::pg
      PG2[lessons.status = accepted]:::pg
      PG3[agent_runs ledger]:::pg
    end

    LLM <-- "read / write per cycle" --> R
    LLM -- "read once at boundaries" --> S
    R -- "promote on accept" --> P
    LLM -- "manifest mirror only" --> S
`;

export default function SyllabusGeneratorDocPage() {
  return (
    <DocShell
      eyebrow="agent / syllabus-generator"
      title="Syllabus Generator"
      subtitle="A supervisor-routed multi-agent system that researches a topic, plans a syllabus, and writes pedagogically-grounded lessons under a critic loop. This page documents the full graph topology and every optimisation we layered on top of the original ReAct baseline."
      updatedAt="2026-04 (post-PR #91 — wire on Vercel AI SDK v5 UI Message Stream)"
    >
      <h2 id="what-it-does">What this agent does</h2>
      <p>
        The user opens a thread, types a goal (&ldquo;teach me graph databases
        for CS undergrads, 2 chapters&rdquo;), and over the course of one or
        more conversational turns the agent: (1) clarifies the brief if it
        is too vague, (2) researches the topic on the open web,
        (3) commits a syllabus skeleton (chapters &amp; lesson plans) to
        Postgres, (4) writes lessons through a single-shot writer / critic
        gate &mdash; in topologically-scheduled waves, so chapters and the
        lessons inside them write in parallel unless an explicit{" "}
        <code>depends_on</code> link forces ordering &mdash; and (5) streams
        the whole thing back to the chat UI live as it happens. Every
        lesson is gated by a severity-aware critic before it is allowed to
        land in the database; the critic&rsquo;s findings are never
        persisted, so the manifest a teacher sees has zero “review me”
        flags.
      </p>

      <h2 id="why-not-react">The naive ReAct baseline (and why it fell over)</h2>
      <p>
        The first iteration was a single LLM in a tool-calling loop —
        classic <strong>ReAct</strong>. One model decided what to research,
        what the chapters should be, and wrote the lessons, choosing its
        own next action on every step. It worked on toy prompts and
        collapsed on real ones. Three failure modes dominated:
      </p>
      <ul>
        <li>
          <strong>Chapter hallucination.</strong> With the chapter list
          embedded in a free-form &ldquo;think out loud&rdquo; turn, the
          model would invent chapters that didn&rsquo;t match the user&rsquo;s
          audience, drift between turns, or quietly merge two distinct
          topics into one chapter.
        </li>
        <li>
          <strong>No clean handoff between research and writing.</strong>{" "}
          The same LLM held the entire transcript, so the &ldquo;writer&rdquo;
          phase was contaminated by the agent&rsquo;s own earlier
          deliberations and started repeating thoughts instead of citing
          sources.
        </li>
        <li>
          <strong>No way to gate output.</strong> Lessons were emitted as
          tool calls; the only feedback signal was a vague self-review
          turn. Anything the model wrote landed in the UI.
        </li>
      </ul>
      <p>
        We rebuilt the agent as a <strong>supervisor-worker graph</strong>:
        a router LLM picks one of a small, typed set of next actions, and
        each action has a dedicated subgraph that does <em>only</em> that
        kind of work. The supervisor never writes lessons. The writer
        never decides what chapter comes next.
      </p>

      <h2 id="top-level-graph">Top-level graph</h2>
      <p>
        The whole agent is one <a href="https://langchain-ai.github.io/langgraphjs/">
        LangGraph</a> state machine. Nodes are TypeScript functions that
        return a partial <code>GraphState</code>; conditional edges read
        the state and pick the next node. The supervisor is the only
        node that ever enters <code>END</code>.
      </p>
      <MermaidDiagram
        chart={TOP_LEVEL_GRAPH}
        caption="Top-level LangGraph topology. Subgraph nodes are inlined into the parent graph (not compiled as nested subgraphs) so that mid-flight reload, per-step checkpointing, and live SSE all work."
      />
      <Callout variant="note" title="why the subgraphs are inlined">
        LangGraph JS treats compiled subgraphs as a single parent step.
        That means inner <code>on_chain_end</code> events never reach the
        parent&rsquo;s event stream and the parent checkpointer doesn&rsquo;t
        see intermediate state. We tried it both ways; inlining the search
        and command nodes directly into the parent graph is what makes
        reload-mid-flight hydration and per-lesson live updates actually
        work.
      </Callout>

      <h2 id="supervisor">The supervisor router</h2>
      <p>
        The supervisor is an LLM call constrained to a Zod{" "}
        <code>discriminatedUnion</code>: it must emit exactly one of{" "}
        <code>search</code>, <code>write</code>, <code>ask</code>,{" "}
        <code>intake</code>, or <code>reply</code>. The discriminator key
        is <code>action</code>; everything else in the payload is action-
        specific (a <code>write</code> must carry <code>chapters</code>; a
        <code>search</code> must carry <code>topics</code>; etc.). Schema
        violations bubble up as a parse error, the run is marked failed
        with a structured reason, and we never feed half-typed payloads
        into a downstream node.
      </p>
      <p>The five actions map to:</p>
      <ul>
        <li>
          <code>search</code> — route into the search subgraph with a
          goal + topic list.
        </li>
        <li>
          <code>write</code> — route into the command (writing) subgraph
          with a fully-typed plan (audience, scope, pedagogy, chapters,
          lessons).
        </li>
        <li>
          <code>ask</code> — emit a freeform clarification interrupt and
          wait for the user.
        </li>
        <li>
          <code>intake</code> — emit a structured intake-form interrupt
          (audience level, prior knowledge, duration, language, target
          outcome) so non-English users don&rsquo;t have to free-text
          their pedagogical context.
        </li>
        <li>
          <code>reply</code> — emit a final assistant message and end the
          turn.
        </li>
      </ul>
      <p>
        Every supervisor invocation also increments a hop counter; if it
        loops more than a small fixed number of times in a single turn we
        force a <code>reply</code> rather than spin forever. After the
        command subgraph commits a syllabus it sets a{" "}
        <code>command_just_finalized</code> flag and routes back into the
        supervisor; the supervisor recognises the flag and emits a
        deterministic wrap-up message instead of asking the LLM (which
        would otherwise be tempted to start another <code>write</code>
        loop).
      </p>

      <h2 id="search">The search subgraph</h2>
      <p>
        Three nodes, executed in series with one inner loop:
      </p>
      <ul>
        <li>
          <strong>search_planner</strong> — turns the supervisor&rsquo;s{" "}
          <code>{`{ goal, topics }`}</code> into a list of concrete subqueries.
          Sets <code>search_substep</code> to point at the first one.
        </li>
        <li>
          <strong>search_step</strong> — fires one query against{" "}
          <a href="https://serper.dev">Serper</a>, fetches the top results,
          scrapes their pages, and writes the raw scrape blobs into Redis
          (not into LangGraph state — see the data-plane section below).
          Loops to itself until <code>search_substep</code> is exhausted.
        </li>
        <li>
          <strong>search_summarizer</strong> — reads the scrape blobs out
          of Redis and produces a small structured summary that fits in
          state, then routes back to the supervisor.
        </li>
      </ul>
      <p>
        The supervisor sees the summary, not the raw scrapes, on its next
        decision step. Multi-hop research (search → supervisor → search
        again with a refined goal) falls out naturally from this loop.
      </p>

      <h2 id="command">The command (writing) subgraph</h2>
      <p>
        Four nodes, executed in series with one inner loop:
      </p>
      <ul>
        <li>
          <strong>command_seed_plans</strong> — takes the supervisor&rsquo;s
          fully-typed plan and seeds an in-memory manifest of lessons to
          write, including each lesson&rsquo;s <code>depends_on</code> set
          so the writer can schedule waves topologically.
        </li>
        <li>
          <strong>command_commit_syllabus</strong> — writes the syllabus
          shell (course, chapters, empty lesson rows with status{" "}
          <code>pending</code>) to Supabase. Pre-allocates lesson UUIDs so
          that the same UUID is used on every retry / re-entry of the
          graph for the same lesson — this is what makes per-lesson Redis
          rehydration possible across turns.
        </li>
        <li>
          <strong>command_write_one</strong> — runs ONE wave of the
          writer / critic gate. Each invocation finds every lesson whose{" "}
          <code>depends_on</code> set is already in{" "}
          <code>committed_lesson_ids</code>, processes them in parallel
          via <code>Promise.all</code>, and unions the newly-committed
          IDs back into state. Inside each branch the gate is single-shot
          (writer once → critic at most once → optional revision-mode
          writer pass) and the lesson is always committed with{" "}
          <code>accepted: true</code> — the critic&rsquo;s findings are
          dropped on the floor at persist time so a teacher never has a
          &ldquo;review me&rdquo; badge to dismiss. The conditional edge
          out of the node loops back to itself for the next wave until
          every lesson is committed, then routes to finalize.
        </li>
        <li>
          <strong>command_finalize</strong> — sets{" "}
          <code>command_just_finalized: true</code> and flips the phase
          back to <code>chatting</code>; the parent edge sends control
          back to the supervisor for the wrap-up reply.
        </li>
      </ul>
      <p>
        Why one wave per parent-graph step instead of a single fan-out
        and one tight inner loop? Two reasons. First, every iteration of{" "}
        <code>command_write_one</code> becomes its own parent-level
        checkpoint, so a process crash mid-wave resumes at the last
        completed wave (committed lessons are not re-written). Second,
        the parent graph&rsquo;s <code>streamEvents</code> emits an{" "}
        <code>on_chain_end</code> per wave — the chat UI uses that to
        flip every lesson card from <em>writing</em> to{" "}
        <em>accepted</em> the moment the row hits Postgres.
      </p>

      <h2 id="lifecycle">Lesson lifecycle (state machine)</h2>
      <p>
        Each lesson row in the database moves through a small finite
        state machine driven by <code>command_commit_syllabus</code>
        (insert) and the single-shot writer/critic gate inside{" "}
        <code>command_write_one</code> (everything else). Both terminal
        states are <code>accepted</code> — the gate-passes path keeps
        the writer&rsquo;s first draft as-is, the gate-fails path
        commits the revised draft — and in both cases the lesson row
        carries an empty <code>critic_issues</code> array and{" "}
        <code>review_required: false</code>. Zero trace of the revision
        lands in persistent state.
      </p>
      <MermaidDiagram
        chart={LESSON_LIFECYCLE}
        caption="Per-lesson state machine. Every transition corresponds to a concrete code path in command.subgraph.ts; both terminal states are 'accepted' (the FE makes no visible distinction). The critic is invoked at most once per lesson and its findings are deliberately discarded at persist time."
      />

      <h2 id="writer-critic">The writer / critic gate (single-shot, zero-trace)</h2>
      <p>
        This is the inner sequence inside one branch of a{" "}
        <code>command_write_one</code> wave. It is{" "}
        <strong>not a loop</strong>: the writer runs once, the critic
        runs at most once, and on a critic failure the writer is invoked
        exactly one more time in revision mode — then the lesson is
        committed. The commit is always <code>accepted: true</code> with
        empty <code>critic_issues</code>; the writer&rsquo;s revision
        pass is its own reward and never surfaces a &ldquo;review
        me&rdquo; badge a teacher would only have to dismiss. The earlier
        multi-revision design (with a block-fingerprint deadlock
        short-circuit) is gone.
      </p>
      <MermaidDiagram
        chart={WRITER_CRITIC_LOOP}
        caption="Per-lesson writer / critic gate. Single critic invocation; on failure the writer revises once and the lesson is committed as accepted with the critic's findings dropped silently. The orchestrator gate (pass && blockCount === 0) is the source of truth, not the critic's pass field on its own."
      />

      <h3 id="critic-gate">Optimisation 1 — severity-aware critic gating</h3>
      <Callout variant="warn" title="every lesson failed the critic">
        The critic system prompt told the model to fail any draft with
        ANY issue on the first two attempts &mdash; even nit-level ones
        like &ldquo;use the Oxford comma&rdquo; or &ldquo;this sentence
        could be one word shorter&rdquo;. With the multi-revision
        budget in place at the time, the critic ran on attempt 0 and
        attempt 1; both were instructed to reject. Real LLM drafts
        always have at least one nit, so the loop always exited via the
        force-pass branch with the lesson silently flagged as
        final-attempt. End-to-end the manifest showed a sea of red.
      </Callout>
      <Callout variant="win" title="block / warn / nit">
        We rewrote the critic to emit issues with an explicit severity
        field (<code>block</code>, <code>warn</code>, or <code>nit</code>),
        and we moved the actual gating decision out of the critic prompt
        and into the orchestrator. The orchestrator passes the lesson if
        and only if the critic returned <code>pass: true</code>{" "}
        <strong>and</strong> the count of <code>block</code>-severity
        issues is zero. Warns and nits are tolerated on the only critic
        invocation. Lessons with substantive grounding problems still
        fail and trigger the single revision pass; lessons with cosmetic
        findings pass directly.
      </Callout>
      <CriticGateSimulator />

      <h3 id="rehydrate">Optimisation 2 — context rehydration from Redis</h3>
      <Callout variant="warn" title="every turn started from a blank page">
        The Redis cache key <code>draft:&lt;thread&gt;:&lt;lesson&gt;</code>{" "}
        was being <em>written</em> after every cycle but{" "}
        <strong>never read back</strong> by anything. A follow-up turn that
        re-entered the writer for the same lesson would start from
        scratch, throwing away the previous draft and the critic&rsquo;s
        prior findings. The user would say &ldquo;the introduction is too
        long&rdquo;, the agent would re-research, rewrite the entire
        lesson, and the introduction would still be too long.
      </Callout>
      <Callout variant="win" title="actually use the cache">
        At the start of every per-lesson cycle the writer now reads both{" "}
        <code>draft:&lt;thread&gt;:&lt;lesson&gt;</code> and a new sibling
        key <code>critic_issues:&lt;thread&gt;:&lt;lesson&gt;</code>. If
        either is present the loop enters <strong>revision mode on
        attempt 0</strong> &mdash; with the prior draft and the prior
        critic&rsquo;s findings as context, the same way attempt 1 used
        to. Both keys are persisted after every writer + critic pass with
        a 30-minute TTL. Same lesson UUID seen on a follow-up turn ⇒ the
        agent picks up where it left off instead of starting blind. The
        UUID continuity comes from{" "}
        <code>command_commit_syllabus</code> pre-allocating lesson IDs
        once, on first commit, and reusing them on every re-entry.
      </Callout>

      <h3 id="patch">Optimisation 3 — patch-based revisions</h3>
      <Callout variant="warn" title="rewriting the world to fix a typo">
        On retry, the writer was given the previous draft + critic issues
        and asked to <em>regenerate</em> the entire lesson. Two
        consequences: (a) huge revision outputs even when the critic only
        flagged one paragraph &mdash; expensive in tokens and slow; and
        (b) the writer would silently drift on sections that weren&rsquo;t
        flagged, sometimes introducing new problems while fixing the old
        ones.
      </Callout>
      <Callout variant="win" title="aider-style search/replace blocks">
        When the loop is in revision mode, the writer is now prompted to
        emit an Aider-style sequence of <code>SEARCH / REPLACE</code>{" "}
        blocks instead of a full rewrite. Each block names an exact
        snippet from the prior draft and what to replace it with. We
        parse the blocks and apply them with a fuzzy whitespace-tolerant
        matcher that <strong>refuses ambiguous matches</strong> &mdash; if
        the same SEARCH would match in two places we treat the patch as
        invalid rather than guess. If anything goes wrong (no parseable
        blocks, no match, ambiguous match, or the writer voluntarily
        emits the explicit <code>FALLBACK_FULL_REWRITE</code> marker
        because the surgical change is too big) the loop transparently
        falls back to the original full-rewrite revision prompt. No stale
        drafts ever ship: either the patch applies cleanly or the writer
        rewrites end-to-end.
      </Callout>
      <p>
        The patch parser and applier live in their own module
        (<code>apps/api/src/graph/command/patch.ts</code>) with an
        independent unit test suite covering single blocks, multi-block
        application order, no-match rejection, ambiguous-match
        rejection, whitespace tolerance, empty-SEARCH append, and an
        end-to-end realistic revision case.
      </p>
      <PatchApplierDemo />

      <h3 id="trace">Click-through: one full lesson cycle</h3>
      <p>
        End-to-end walkthrough of one accepted lesson, from rehydrate to
        Supabase commit. At every step you can see the Redis op, the
        state diff, and the actual log line the API would emit.
      </p>
      <LessonTraceStepper />

      <h2 id="data-plane">Heavy data outside the agent state</h2>
      <p>
        LangGraph state is a hot path: every conditional edge reads it,
        every checkpoint writes it. Stuffing scraped HTML, full lesson
        markdown, or lists of critic issues into state would make the
        checkpointer crawl and the SSE stream gigantic. Our rule is:{" "}
        <strong>state is for routing decisions and small typed
        slices</strong>; everything heavy lives next to the agent and is
        addressed by stable keys.
      </p>
      <MermaidDiagram
        chart={DATA_PLANE}
        caption="Three-tier data plane. State stays small. Redis carries the per-lesson hot context and the per-run live event stream. Supabase is the durable, audit-able record — only accepted lessons land there."
      />
      <p>
        Concretely:
      </p>
      <ul>
        <li>
          <strong>State</strong>: chat messages, current phase, next route,
          the union-merged set of committed lesson IDs (drives the
          wave-scheduler), manifest mirror, the active interrupt payload.
          Tens of KB at most. Persisted by the LangGraph checkpointer on
          every parent-graph step.
        </li>
        <li>
          <strong>Redis</strong>: per-lesson draft markdown (so a same-UUID
          re-entry can pick up the previous turn&rsquo;s draft as
          revision-mode context), raw scrape blobs from search, and the
          per-run event stream that the FE subscribes to. All keys carry
          an explicit TTL so we never accumulate stale data.
        </li>
        <li>
          <strong>Supabase</strong>: the syllabus shell, chapter rows,
          accepted lesson rows, the <code>agent_runs</code> ledger. Only
          things that must outlive the working session land here.
        </li>
      </ul>

      <h2 id="streaming">Streaming infrastructure</h2>
      <MermaidDiagram
        chart={STREAMING_SEQUENCE}
        caption="End-to-end streaming. The Redis Stream is both the live channel (XREAD BLOCK) and the reconnect-replay log (XRANGE). The reaper runs as an independent worker — no HTTP request can keep a 'running' row alive past 30 s without a fresh heartbeat."
      />
      <p>
        The FE doesn&rsquo;t talk to LangGraph directly. The API exposes a
        single SSE endpoint per run that fans out a Redis Stream
        (<code>run:&lt;runId&gt;:events</code>). The graph nodes write
        typed slices (<code>phase</code>, <code>research_plan</code>,{" "}
        <code>todo_plan</code>, <code>manifest</code>,{" "}
        <code>interrupt</code>, <code>run</code>, <code>done</code>,{" "}
        <code>error</code>) onto the stream as they happen; the FE
        subscribes via <code>XREAD BLOCK</code> for live fan-out and
        replays via <code>XRANGE</code> on reconnect, using the last seen
        entry ID it persisted to <code>sessionStorage</code>.
      </p>
      <p>
        The wire format itself is{" "}
        <strong>Vercel AI SDK v5 UI Message Stream</strong> (since PR #91).
        Each typed slice ships as an SSE frame{" "}
        <code>data: &#123;&quot;type&quot;:&quot;data-&lt;kind&gt;&quot;,&quot;data&quot;:&hellip;,&quot;transient&quot;:true&#125;</code>;
        live tokens ship as <code>text-delta</code> chunks; the
        terminator is the literal <code>data: [DONE]</code> line. The FE
        uses <code>useChat</code> from <code>@ai-sdk/react</code> v2 plus
        <code>DefaultChatTransport</code>, with each <code>data-&lt;kind&gt;</code>
        chunk routed via <code>onData</code> into the same Zustand store
        that the v4 demuxer used.
      </p>
      <Callout variant="note" title="why a Redis Stream and not Supabase Realtime">
        Cross-tab + reload latency is sub-millisecond on a Redis Stream
        vs. 100&ndash;300 ms via Postgres logical replication into
        Supabase Realtime. Native per-stream <code>MAXLEN</code> and{" "}
        <code>EXPIRE</code> handle retention without a bookkeeping cron.
        And it&rsquo;s multi-replica safe: any API replica can serve the
        replay because Redis is shared. Stream keys expire 24 h after the
        run terminates, which is the cold-storage cut-off we agreed on.
      </Callout>
      <p>
        Crashed runs are handled by a separate worker (the{" "}
        <strong>stale-run reaper</strong>): every 5 seconds it looks for
        rows in <code>agent_runs</code> with status <code>running</code>{" "}
        and a <code>last_heartbeat</code> older than 30 seconds, marks
        them <code>failed</code>, and appends a synthetic{" "}
        <code>kind=&apos;error&apos;</code> entry to the run&rsquo;s event
        log. That event is what flips the FE from &ldquo;still
        streaming&rdquo; to &ldquo;process died&rdquo; without the user
        having to refresh.
      </p>

      <h2 id="recap">Recap of optimisations vs. the ReAct baseline</h2>
      <ul>
        <li>
          <strong>LLM-decides-everything ReAct</strong> →{" "}
          <strong>typed supervisor router</strong> with a{" "}
          <code>discriminatedUnion</code> of five actions; chapter
          structure is now a schema-validated payload, not free-form
          model output.
        </li>
        <li>
          <strong>Single mixed-context model</strong> →{" "}
          <strong>dedicated subgraphs</strong> for research and writing;
          each subgraph receives only the slice it needs and writes only
          the slice it&rsquo;s allowed to.
        </li>
        <li>
          <strong>&ldquo;Any issue fails&rdquo; critic</strong> →{" "}
          <strong>severity-aware gate</strong> (<code>block</code> /{" "}
          <code>warn</code> / <code>nit</code>); only{" "}
          <code>block</code>-severity findings can fail a lesson.
        </li>
        <li>
          <strong>Blank-page revisions every turn</strong> →{" "}
          <strong>Redis rehydration</strong> of prior draft + prior
          critic issues, keyed by stable lesson UUID with a 30-minute TTL.
        </li>
        <li>
          <strong>Full-rewrite on every retry</strong> →{" "}
          <strong>SEARCH/REPLACE patch blocks</strong> with a fuzzy
          whitespace-tolerant applier and a transparent full-rewrite
          fallback; ambiguous matches are refused, not guessed.
        </li>
        <li>
          <strong>Heavy payloads in state</strong> →{" "}
          <strong>off-state data plane</strong>: state stays small,
          Redis carries hot per-lesson context + the live event stream,
          Supabase is the durable accepted-only ledger.
        </li>
        <li>
          <strong>Polling Postgres for live updates</strong> →{" "}
          <strong>Redis Streams via SSE</strong> with sub-ms fan-out and
          deterministic replay across reloads and tabs; a separate
          stale-run reaper handles process death.
        </li>
      </ul>
    </DocShell>
  );
}

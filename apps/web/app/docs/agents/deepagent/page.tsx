import { DocShell } from "../../../../components/docs/DocShell";
import { Callout } from "../../../../components/docs/Callout";

export const metadata = {
  title: "Deep Agent — FINAL_MPFE",
  description:
    "Generalist supervisor that composes pedagogy_planner / writer / activity_maker / pedagogy_critic subagents based on the user's request. Builds syllabuses, makes worksheets, critiques lessons.",
};

export default function DeepAgentDoc() {
  return (
    <DocShell
      eyebrow="docs / agents"
      title="Deep Agent"
      subtitle="Generalist supervisor with four specialist subagents. The supervisor decides at runtime — based on the user's request — whether to build a syllabus, make a worksheet, critique an existing artefact, or just answer a pedagogical question."
      updatedAt="2026-05"
    >
      <Callout variant="note">
        The deep-agent thread is the place to start any pedagogical
        task — building a course from scratch, generating a worksheet
        for an existing lesson, asking for a critique of a draft, or
        just asking pedagogical questions. Tell it what you want and
        it picks the right capability.
      </Callout>

      <h2>The supervisor is a generalist</h2>
      <p>
        The supervisor does not assume the user wants a syllabus.
        Each turn, it reads the user's request and decides which
        capability fits — sometimes one, sometimes a sequence in the
        same chat. It dispatches specialist subagents via the
        deepagents <code>task</code> tool and embeds the right
        artifact card (or no card, for critiques and conversation) in
        its closing message.
      </p>
      <p>
        Capabilities the supervisor composes:
      </p>
      <ol>
        <li>
          <strong>Build a syllabus</strong> — pedagogy_planner →
          writer × N → <code>&lt;artifact kind=&quot;syllabus&quot;</code> card.
        </li>
        <li>
          <strong>Make an activity</strong> — activity_maker →{" "}
          <code>&lt;artifact kind=&quot;worksheet&quot;</code> card.
          Either lesson-grounded (binds to an existing syllabus
          lesson) or standalone (no syllabus binding).
        </li>
        <li>
          <strong>Critique a lesson, chapter, plan, or worksheet</strong>{" "}
          — pedagogy_critic → severity-tagged findings reported as
          conversational text. No card.
        </li>
        <li>
          <strong>Just answer</strong> — pure conversation, no
          dispatch. Pedagogical advice, exploration, follow-up
          questions.
        </li>
      </ol>

      <h2>The cast</h2>
      <ul>
        <li>
          <strong>Supervisor</strong> — the user-facing chat agent
          and conductor. Maps the user's request to one or more
          capabilities and orchestrates the subagents. Owns the
          syllabus row (the only agent that calls{" "}
          <code>create_syllabus</code>) and embeds artifact card tags
          in its prose.
        </li>
        <li>
          <strong>pedagogy_planner</strong> — senior curriculum
          designer. LLM-only when no Serper API key is configured;
          otherwise has <code>web_search</code> + <code>web_fetch</code>{" "}
          tools to ground duration / outcome estimates. Writes one
          file: <code>/pedagogy_plan.md</code>. Never touches the
          database.
        </li>
        <li>
          <strong>writer</strong> — subject-matter writer dispatched
          once per chapter. Reads the chapter spec from the
          supervisor's task description, runs <code>list_chapters</code>{" "}
          / <code>list_lessons</code> first to stay idempotent,
          creates the chapter row + its lesson rows, and mirrors each
          lesson body to <code>/lessons/&lt;lesson_id&gt;.md</code> so
          the supervisor can inspect without a DB round trip.
        </li>
        <li>
          <strong>activity_maker</strong> — worksheet designer.
          Produces one MCQ / short-answer / worked-example worksheet
          per dispatch and persists it via <code>create_activity</code>.
          Two flavours decided by the supervisor: lesson-grounded
          (fetches the lesson body via <code>get_lesson</code> before
          drafting questions) or standalone (no syllabus binding,
          generates from topic + audience). Mirrors output to{" "}
          <code>/activities/&lt;activity_id&gt;.json</code>.
        </li>
        <li>
          <strong>pedagogy_critic</strong> — read-only senior
          reviewer. Critiques a pedagogy plan, a chapter, a lesson
          body, or a worksheet against the audience profile and
          Bloom progression. Writes a severity-tagged critique to{" "}
          <code>/critiques/&lt;target&gt;.md</code> (block / revise /
          polish) and returns a one-paragraph summary so the
          supervisor can decide whether to re-task the writer or
          activity_maker. Never touches the database.
        </li>
      </ul>

      <h2>Capability A — Build a syllabus</h2>
      <ol>
        <li>
          <strong>Intake.</strong> Supervisor greets the user. If
          audience details are missing it asks one or two short
          questions (level, language, duration), then writes the
          answers to <code>/user_profile.md</code>.
        </li>
        <li>
          <strong>Seed the syllabus.</strong> Supervisor calls{" "}
          <code>create_syllabus(thread_id, title, audience, scope, pedagogy)</code>{" "}
          — populating the pedagogical contract from the intake. The
          returned <code>id</code> is the value that ends up in the
          artifact card.
        </li>
        <li>
          <strong>Plan.</strong> Supervisor dispatches{" "}
          <code>task(pedagogy_planner, …)</code> exactly once. The
          planner reads <code>/user_profile.md</code>, optionally
          searches the web for grounding sources, and writes a
          structured chapter-by-chapter plan to{" "}
          <code>/pedagogy_plan.md</code>.
        </li>
        <li>
          <strong>Write.</strong> Supervisor reads the plan, builds a
          todo list (one per chapter), and dispatches the writer
          chapter by chapter. The writer's task description includes
          the syllabus_id and the full chapter spec verbatim from the
          plan.
        </li>
        <li>
          <strong>Verify.</strong> After each writer dispatch, the
          supervisor calls <code>list_lessons(chapter_id)</code> to
          confirm the database matches the plan. Mismatches trigger a
          re-dispatch with corrective context.
        </li>
        <li>
          <strong>Optional critique — single-shot.</strong> Either when
          the user asks ("review chapter 3") or when the supervisor
          suspects quality issues, it dispatches the pedagogy_critic
          AT MOST ONCE per target in this user turn against{" "}
          <code>/lessons/&lt;id&gt;.md</code> or the plan. If the
          critique flags block-severity issues the supervisor may
          re-task the writer ONCE to address them — then commit and
          deliver. The supervisor does NOT call{" "}
          <code>task(pedagogy_critic, …)</code> a second time on the
          same target in the same turn to verify the writer&rsquo;s
          fix; the user verifies it (or asks for another critique) in
          their next message. This is a tool, not a fixed gate — it
          runs only when needed, and at most once per target per turn.
        </li>
        <li>
          <strong>Deliver.</strong> Final message contains the inline{" "}
          <code>
            &lt;artifact kind=&quot;syllabus&quot; id=&quot;…&quot;
            title=&quot;…&quot; /&gt;
          </code>{" "}
          tag rendered as a clickable chip by the FE parser. The chip
          navigates to <code>/syllabuses/&lt;id&gt;</code>, a
          dedicated read-only viewer that loads the chapter / lesson
          tree by syllabus id.
        </li>
      </ol>

      <h2>Capability B — Make an activity</h2>
      <p>
        Triggered when the user asks for a worksheet, quiz, set of
        MCQs, or practice problems. The supervisor disambiguates two
        flavours before dispatching:
      </p>
      <ul>
        <li>
          <strong>Lesson-grounded</strong> — "make a worksheet for
          chapter 2 lesson 3 of the syllabus we just built." The
          supervisor passes a <code>lesson_id</code>; activity_maker
          fetches the lesson body via <code>get_lesson</code> before
          generating questions. Questions must be answerable from the
          lesson body — no out-of-scope facts.
        </li>
        <li>
          <strong>Standalone</strong> — "5 MCQs on photosynthesis."
          No syllabus binding. activity_maker generates from its own
          knowledge plus the audience profile.
        </li>
      </ul>
      <p>
        After dispatch the worksheet lands in the{" "}
        <code>activities</code> table and the supervisor returns an
        inline{" "}
        <code>
          &lt;artifact kind=&quot;worksheet&quot; id=&quot;…&quot; /&gt;
        </code>{" "}
        chip. Clicking the chip navigates to{" "}
        <code>/activities/&lt;id&gt;</code>, a dedicated read-only
        viewer that renders the worksheet via the same{" "}
        <code>ActivityWorksheet</code> component the activity threads
        use. Optional pedagogy_critic gate-check after generation
        when the supervisor (or user) wants quality scrutiny — the
        critic is dispatched at most once per target per user turn,
        and any writer revision in response is committed without a
        second critique.
      </p>

      <h2>Capability C — Critique an artefact</h2>
      <p>
        Triggered when the user explicitly asks for a review or when
        the supervisor wants to gate-check its own output. The
        supervisor mirrors the target to the VFS if needed (e.g.{" "}
        <code>/lessons/&lt;id&gt;.md</code>), dispatches{" "}
        <code>task(pedagogy_critic, …)</code> with the audience
        profile, and reads the resulting critique file from{" "}
        <code>/critiques/&lt;target&gt;.md</code>. Findings are
        reported back as conversational text, grouped by severity:
      </p>
      <ul>
        <li>
          <strong>block</strong> — pedagogically wrong / harmful.
          Must be revised before shipping. Examples: hallucinated
          facts, wrong worked-example math, an MCQ with two correct
          options.
        </li>
        <li>
          <strong>revise</strong> — substantive but not wrong.
          Vague LO, weak distractor, missing key term.
        </li>
        <li>
          <strong>polish</strong> — wording / formatting.
        </li>
      </ul>
      <p>
        Critiques do <em>not</em> emit an artifact card — they're
        conversational feedback. The user's existing syllabus or
        worksheet card from a prior turn already points at the row
        that was reviewed.
      </p>

      <h2>Capability D — Just answer</h2>
      <p>
        Pedagogical questions, advice, exploration. No subagent
        dispatch, no card. The supervisor closes by inviting a
        concrete next step the user can opt into ("Want me to draft a
        syllabus along those lines?") so capability A/B/C is one
        short reply away.
      </p>

      <h2>VFS conventions</h2>
      <p>
        Every agent (supervisor + four subagents) shares the
        deepagents virtual filesystem. The path layout is part of the
        contract — switching paths breaks the writer's ability to
        find the chapter spec, the supervisor's ability to verify,
        and the critic's ability to read what's being reviewed.
      </p>
      <ul>
        <li>
          <code>/user_profile.md</code> — supervisor writes after
          intake. Read by pedagogy_planner.
        </li>
        <li>
          <code>/pedagogy_plan.md</code> — pedagogy_planner writes
          (one file, one shot). Read by supervisor and writer.
        </li>
        <li>
          <code>/lessons/&lt;lesson_id&gt;.md</code> — writer mirrors
          each persisted lesson here. Read by supervisor and the
          critic.
        </li>
        <li>
          <code>/activities/&lt;activity_id&gt;.json</code> —
          activity_maker mirrors each persisted worksheet here. Read
          by supervisor and the critic.
        </li>
        <li>
          <code>/critiques/&lt;target&gt;.md</code> — pedagogy_critic
          writes one critique per dispatch. Read by supervisor.{" "}
          <code>&lt;target&gt;</code> is a stable identifier:{" "}
          <code>pedagogy_plan</code>, <code>lesson_&lt;id&gt;</code>,
          {" "}<code>activity_&lt;id&gt;</code>,{" "}
          <code>chapter_&lt;id&gt;</code>.
        </li>
      </ul>

      <h2>Tool inventory</h2>

      <h3>MCP Supabase (database)</h3>
      <p>
        All database access is mediated by the{" "}
        <code>mpfe-mcp-supabase</code> server (FastMCP, Python). The
        deep-agent runner connects over streamable-http in production
        and over stdio (spawning the server as a child process)
        locally. Tools are loaded once at API boot and distributed by
        a registry in <code>packages/deep-agent/src/runner.ts</code>:
      </p>
      <ul>
        <li>
          <strong>Supervisor</strong>: <code>create_syllabus</code>,{" "}
          <code>get_syllabus</code>, <code>list_syllabuses</code>,{" "}
          <code>list_chapters</code>, <code>list_lessons</code>,{" "}
          <code>list_lessons_for_thread</code>,{" "}
          <code>get_lesson</code>.
        </li>
        <li>
          <strong>writer</strong>: <code>list_chapters</code>,{" "}
          <code>list_lessons</code>, <code>get_lesson</code>,{" "}
          <code>get_syllabus</code>, <code>create_chapter</code>,{" "}
          <code>create_lesson</code>.
        </li>
        <li>
          <strong>activity_maker</strong>: <code>get_lesson</code>,{" "}
          <code>list_lessons_for_thread</code>,{" "}
          <code>list_chapters</code>, <code>list_lessons</code>,{" "}
          <code>get_syllabus</code>, <code>create_activity</code>.
        </li>
        <li>
          <strong>pedagogy_critic</strong>: <code>get_lesson</code>,{" "}
          <code>get_syllabus</code>, <code>list_chapters</code>,{" "}
          <code>list_lessons</code> — read-only by design.
        </li>
        <li>
          <strong>pedagogy_planner</strong>: none — the planner is
          intentionally read-only on the database side.
        </li>
      </ul>

      <h3>Web search (pedagogy_planner only)</h3>
      <ul>
        <li>
          <code>web_search(query, num?)</code> — Serper.dev top
          organic results.
        </li>
        <li>
          <code>web_fetch(url)</code> — best-effort HTML → readable
          text extraction (truncated to ~8k chars).
        </li>
      </ul>
      <p>
        Both are gated on <code>SERPER_API_KEY</code> being set. With
        no key, the planner runs LLM-only and the prompt is
        automatically adjusted.
      </p>

      <h3>Built-ins (every agent)</h3>
      <p>
        deepagents@1.9 auto-injects these on every supervisor and
        subagent: <code>read_file</code>, <code>write_file</code>,{" "}
        <code>edit_file</code>, <code>ls</code>, <code>write_todos</code>.
        The supervisor additionally gets the <code>task</code> tool
        for subagent dispatch.
      </p>

      <h2>Idempotency &amp; verification</h2>
      <p>
        The writer is structured around{" "}
        <em>list-before-create</em>: every <code>create_chapter</code>{" "}
        is preceded by <code>list_chapters(syllabus_id)</code>, and
        every <code>create_lesson</code> by{" "}
        <code>list_lessons(chapter_id)</code>. If a row with the same{" "}
        <code>order_index</code> already exists (e.g. from a
        previously-completed dispatch the supervisor is retrying),
        the writer skips the insert and reuses the existing id. This
        is what makes the supervisor's verify-then-redispatch loop
        safe — re-dispatching a writer that already finished a
        chapter results in zero duplicate rows.
      </p>
      <p>
        The supervisor verifies <em>via the database</em>, not via
        the writer's claimed summary. After every writer return the
        supervisor calls <code>list_lessons(chapter_id)</code> and
        compares against the plan; mismatches re-dispatch.
      </p>

      <h2>The canvas (Files + Subagents panel)</h2>
      <p>
        The deep-agent thread view is two-pane: chat on the left, a
        live canvas on the right. The canvas surfaces what the
        supervisor and subagents are doing under the hood — files
        they're producing and the per-task dispatches the chat
        intentionally hides.
      </p>
      <ul>
        <li>
          <strong>Files tab</strong> — a tree view of the deepagents
          virtual filesystem with a click-to-preview reader. Markdown
          files render through the chat markdown renderer; non-md
          files render as plain text. Updates land live as the
          subagents <code>write_file</code>; on reload, the API
          hydrates the snapshot from the LangGraph checkpointer
          (Postgres) so the panel is never empty for a thread that
          previously produced output.
        </li>
        <li>
          <strong>Subagents tab</strong> — one row per{" "}
          <code>task()</code> dispatch, ordered by start time. Each
          row shows the subagent name, the supervisor's full task
          description (not the 80-char chip preview the chat
          shows), a status badge (running / ok / error), the wall-
          clock duration, and — when the run is in flight — a live
          "thinking…" preview of the subagent's per-token output as
          it streams. Once the run finishes, the live preview is
          replaced by the synthesised final output rendered as
          markdown (visible when the row is expanded). On reload,
          the API replays the row history from the durable event
          log so the panel survives tab close — past the live
          window, each completed row shows its final output
          directly.
        </li>
      </ul>
      <p>
        Wire shape: the runner emits three typed slices —{" "}
        <code>vfs_update</code> (path → content delta, optionally
        attributed to the in-flight subagent),{" "}
        <code>subagent_run</code> (per-call_id snapshot:{" "}
        <code>running</code> → <code>ok</code> / <code>error</code>),
        and <code>subagent_text_delta</code> (per-token thinking
        keyed by call_id). The first two persist through the full
        Redis Streams + Postgres event log path so reload+resume
        rehydrate identically; <code>subagent_text_delta</code>{" "}
        persists to Redis only (post-disconnect resume on the live
        run) but skips the durable event log — the canvas hydrates
        each row's final answer from the <code>subagent_run</code>{" "}
        snapshot on reload, so persisting per-token deltas would be
        pure write amplification. All three flow through the same
        Vercel AI SDK v5 UIMessageStream as every other slice, and
        follower tabs see the canvas update in real-time even when
        they didn't drive the run.
      </p>
      <p>
        Routing discipline: <code>subagent_text_delta</code> never
        feeds <code>useChat.messages[]</code>. The supervisor's chat
        bubble is supervisor-only — subagent thinking lives on the
        canvas, never in the user-facing chat history.
      </p>

      <h2>Deferred</h2>
      <ul>
        <li>
          <strong>HITL / interrupts</strong> — no <code>ask_user</code>{" "}
          tool yet. The supervisor asks intake / disambiguation
          questions as plain chat turns; mid-run pauses (e.g. for a
          teacher to approve the plan before writing) are deferred.
        </li>
        <li>
          <strong>Parallel <code>task()</code> dispatches</strong> —
          the runner only correlates sequential delegations today.
          Building eight chapters in parallel is a latency
          optimisation deferred to a follow-up.
        </li>
        <li>
          <strong>VFS editing</strong> — the canvas is read-only.
          File diffs, version history, and HITL "approve before
          writing to DB" gates are deferred.
        </li>
        <li>
          <strong>Per-subagent nested tool chips</strong> — when a
          subagent calls a tool (e.g. <code>create_lesson</code>),
          the chip is currently dropped server-side. The Subagents
          row shows the live token stream and the final output, but
          not the discrete tool calls in between. Surfacing them as
          a per-row sub-timeline is deferred.
        </li>
      </ul>

      <h2>How to test</h2>
      <p>
        Open the threads index, click <em>New thread</em>, choose{" "}
        <em>Deep Agent</em>, then send one of:
      </p>
      <ul>
        <li>
          <code>
            Build me an undergraduate, French-language, 12-hour
            course on graph theory.
          </code>{" "}
          — exercises Capability A end-to-end. You should see a{" "}
          <code>
            task(subagent_type=&quot;pedagogy_planner&quot;)
          </code>{" "}
          chip, then writer dispatches per chapter, then a clickable
          syllabus card.
        </li>
        <li>
          <code>Make me 5 MCQs on photosynthesis for 9th graders.</code>{" "}
          — exercises Capability B (standalone). One{" "}
          <code>activity_maker</code> dispatch, then a worksheet
          card.
        </li>
        <li>
          <code>
            Now make a worksheet for chapter 2 lesson 1 of the
            course you just built.
          </code>{" "}
          — exercises Capability B (lesson-grounded) in the same
          chat as a prior Capability A run.
        </li>
        <li>
          <code>Review the BFS lesson — anything off?</code> —
          exercises Capability C. One{" "}
          <code>pedagogy_critic</code> dispatch, then a prose summary
          of findings.
        </li>
      </ul>
    </DocShell>
  );
}

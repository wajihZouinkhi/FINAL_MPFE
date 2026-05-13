import Link from "next/link";
import { DocShell } from "../../../../components/docs/DocShell";
import { Callout } from "../../../../components/docs/Callout";
import { MermaidDiagram } from "../../../../components/docs/MermaidDiagram";

export const metadata = {
  title: "Activity Generator (with tools) — FINAL_MPFE",
  description:
    "Worksheet generator that reads chapters and lessons through an MCP server bound to Supabase, producing structured Worksheets grounded in actual course material.",
};

const GRAPH = `
flowchart LR
    user([User prompt]) --> START
    START --> generate
    subgraph gen [generate node]
      direction TB
      pick[LLM tool-call loop<br/>list_lessons_for_thread<br/>get_lesson] --> ground[Final pass<br/>response_format = json_object<br/>+ lesson markdown]
      ground --> validate[Worksheet zod parse<br/>+ coercion fallback]
    end
    generate --> commit[(Supabase<br/>activities row)]
    commit --> manifest[[activity_manifest<br/>data part → SSE]]
    manifest --> END
    classDef ext fill:#0e1f33,stroke:#3aa0ff,color:#cce6ff;
    classDef llm fill:#231a2c,stroke:#a78bfa,color:#e9d5ff;
    classDef store fill:#1f2a1f,stroke:#86efac,color:#bbf7d0;
    class pick,ground llm
    class commit,manifest store
`.trim();

const MCP = `
sequenceDiagram
    autonumber
    participant API as API (Nest)
    participant Cli as MultiServerMCPClient
    participant MCP as Python MCP server (fastmcp)
    participant Supa as Supabase REST
    API->>Cli: getTools() (lazy)
    Cli->>MCP: spawn (uv run mpfe-mcp-supabase)
    Cli-->>API: [list_lessons_for_thread, get_lesson, …]
    API->>Cli: tool.invoke(list_lessons_for_thread, thread_id)
    Cli->>MCP: JSON-RPC tools/call
    MCP->>Supa: select chapters → lessons
    Supa-->>MCP: rows
    MCP-->>Cli: result
    Cli-->>API: ToolMessage(content)
    note over API: LLM emits get_lesson(lesson_id)
    API->>Cli: tool.invoke(get_lesson, lesson_id)
    Cli->>MCP: JSON-RPC tools/call
    MCP->>Supa: select lesson by id
    Supa-->>MCP: row (markdown body)
    MCP-->>Cli: result
    Cli-->>API: ToolMessage(content)
    note right of API: Phase 2: structured-output<br/>final pass with lesson body
`.trim();

export default function ActivityGeneratorTooledDoc() {
  return (
    <DocShell
      eyebrow="docs / agents"
      title="Activity Generator (with tools)"
      subtitle="Worksheet generator that reads your existing course material through an MCP server, then asks the LLM for a structured Worksheet JSON grounded in the actual lesson body."
      updatedAt="2026-04"
    >
      <Callout variant="note">
        This agent is intentionally a tiny graph (one node) wrapping a
        non-trivial tool-calling loop. The complexity lives in
        <code> ActivityAgentService.runTurn(state, &quot;tooled&quot;)</code>
        rather than in graph topology, so the FE&apos;s SSE wire shape stays
        boring (one <code>on_chain_end</code> per turn) while the agent
        gets full freedom to call tools any number of times.
      </Callout>

      <h2>What it produces</h2>
      <p>
        A single <em>Worksheet</em> per turn, validated by the same Zod
        schema as the toolless agent: a title, a one-line intro, 3–5
        multiple-choice questions (each with exactly four options and a
        correct index + explanation), 1–2 short-answer prompts with
        model answers, and one worked example with stepwise solution.
        Persisted to <code>activities</code> in Supabase as one row;
        streamed to the FE via the <code>activity_manifest</code> data
        part for live status (<code>drafting → ready</code>).
      </p>

      <h2>Graph topology</h2>
      <MermaidDiagram chart={GRAPH} caption="Activity-tooled graph: one generate node, two LLM phases inside it." />

      <h2>Why MCP instead of in-process tools?</h2>
      <p>
        Tools are exposed by a separate Python service
        (<code>apps/mcp-supabase/</code>) using fastmcp + supabase-py,
        spawned as a stdio child of the API the first time it&apos;s
        needed. Three reasons we picked this over wiring tools directly
        into the LangGraph node:
      </p>
      <ul>
        <li>
          The MCP boundary makes the tool surface portable. Any other
          agent (now or in future repos) can talk to the same server
          without copying TypeScript bindings; LangChain&apos;s
          <code> @langchain/mcp-adapters</code> turns tools/list into
          first-class LangChain tools automatically.
        </li>
        <li>
          Supabase&apos;s Python client is what we already use for the
          ETL side of this project, so reading chapters and lessons
          stays one-language-fits-everything on the data path.
        </li>
        <li>
          stdio is the simplest transport. No extra HTTP port to
          firewall, no TLS, no auth — the API and the MCP server share
          a process tree and the service-role Supabase key is passed in
          via <code>env</code>.
        </li>
      </ul>

      <h3>Tools exposed</h3>
      <ul>
        <li><code>list_syllabuses(thread_id)</code> — syllabuses bound to a thread.</li>
        <li><code>list_chapters(syllabus_id)</code> — ordered chapters of a syllabus.</li>
        <li><code>list_lessons(chapter_id)</code> — ordered lessons in a chapter, no body.</li>
        <li><code>list_lessons_for_thread(thread_id)</code> — denormalised flat menu of all lessons across all chapters in the bound syllabus.</li>
        <li><code>get_lesson(lesson_id)</code> — a single lesson row, including the markdown <code>content</code> body.</li>
      </ul>

      <h2>End-to-end sequence</h2>
      <MermaidDiagram chart={MCP} caption="API ↔ MCP server ↔ Supabase. The LLM drives the tool-call loop." />

      <h2>Two-phase generation inside the node</h2>
      <p>
        We deliberately split the node into a tool-calling phase and a
        structured-output phase rather than asking one model call to
        do both. This is because models bound to <code>tools</code>
        often refuse to also emit clean <code>response_format = json_object</code>
        in the same call — they treat the request as ambiguous and
        produce either a tool call OR JSON, not both. Splitting the
        phases keeps each call&apos;s expectations sharp:
      </p>
      <ol>
        <li>
          <strong>Plan phase.</strong> LLM with tools bound runs up to
          six turns (
          <code>list_lessons_for_thread</code>,
          <code> get_lesson</code>) until it stops issuing tool calls.
          We capture the chosen lesson&apos;s id, title and markdown
          body from the <code>ToolMessage</code> contents directly,
          rather than re-fetching afterwards.
        </li>
        <li>
          <strong>Final pass.</strong> Fresh prompt with the lesson body
          + <code>response_format: json_object</code>. The
          tool-calling history is dropped on purpose — keeping it makes
          some models try to keep calling tools instead of producing
          JSON.
        </li>
      </ol>

      <h2>Validation + coercion</h2>
      <p>
        The output is parsed with the same <em>Worksheet</em> Zod schema
        the toolless agent uses, and on schema-validation failure we run
        a small coercion pass (truncate to four MCQ options, fill
        missing fields with sensible defaults) and re-parse. If
        coercion still fails we throw — the manifest item flips to{" "}
        <code>failed</code> with the Zod error reasons so the teacher
        sees something actionable in the FE rather than silence.
      </p>

      <h2>Failure modes the agent surfaces, not silently swallows</h2>
      <ul>
        <li>
          <strong>NO_SYLLABUS.</strong> If the bound thread has no
          committed lessons yet, the LLM is asked to respond
          <code> NO_SYLLABUS</code> instead of calling more tools, and
          the node throws with a teacher-friendly message
          (&quot;generate the syllabus first&quot;).
        </li>
        <li>
          <strong>Tool budget exhausted.</strong> Six turn cap on the
          tool-calling loop. If we hit it without ever fetching a lesson
          body, the node throws with{" "}
          <code>Agent did not retrieve a lesson via MCP within the tool-call budget.</code>
        </li>
        <li>
          <strong>Schema drift.</strong> Zod issues are joined into a
          short error string and bubbled up through the manifest item.
        </li>
      </ul>

      <h2>Comparison with the toolless agent</h2>
      <p>
        This agent and{" "}
        <Link href="/docs/agents/activity-generator-toolless">
          activity-generator-toolless
        </Link>{" "}
        produce the same wire shape on purpose. Run the same prompt
        against both and the differences come out immediately: the
        tooled agent grounds questions and distractors in concepts that
        actually appear in the lesson body, picks the worked example
        from the lesson&apos;s assessment seed, and aligns the audience
        level with the syllabus&apos; <code>audience</code> field. The
        toolless one invents lesson titles and treats every concept as
        already-known. That contrast is the whole point of giving an
        LLM tools.
      </p>
    </DocShell>
  );
}

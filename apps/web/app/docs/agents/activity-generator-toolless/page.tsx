import Link from "next/link";
import { DocShell } from "../../../../components/docs/DocShell";
import { Callout } from "../../../../components/docs/Callout";
import { MermaidDiagram } from "../../../../components/docs/MermaidDiagram";

export const metadata = {
  title: "Activity Generator (no tools) — FINAL_MPFE",
  description:
    "Worksheet generator with no access to syllabus, no MCP tools. Useful as a side-by-side baseline against the tooled version.",
};

const GRAPH = `
flowchart LR
    user([User prompt]) --> START
    START --> generate
    generate --> commit[(Supabase<br/>activities row)]
    commit --> manifest[[activity_manifest<br/>data part → SSE]]
    manifest --> END
    classDef llm fill:#231a2c,stroke:#a78bfa,color:#e9d5ff;
    classDef store fill:#1f2a1f,stroke:#86efac,color:#bbf7d0;
    class generate llm
    class commit,manifest store
`.trim();

export default function ActivityGeneratorToollessDoc() {
  return (
    <DocShell
      eyebrow="docs / agents"
      title="Activity Generator (no tools)"
      subtitle="Worksheet generator with no access to course material. Same Zod output schema as the tooled version, so the contrast between grounded and ungrounded generation is unambiguous."
      updatedAt="2026-04"
    >
      <Callout variant="warn">
        This agent is the demo baseline, not the recommended path for
        teachers. It exists so we can run the same prompt against both
        agents and watch what happens when the LLM has no way to read
        the syllabus.
      </Callout>

      <h2>What it produces</h2>
      <p>
        A single <em>Worksheet</em> per turn — a title, a one-line
        intro, 3–5 multiple-choice questions, 1–2 short-answer prompts,
        and one worked example. Persisted to <code>activities</code>{" "}
        and streamed via the <code>activity_manifest</code> data part.
        Same schema, same wire format as the tooled agent.
      </p>

      <h2>Graph topology</h2>
      <MermaidDiagram chart={GRAPH} caption="Toolless graph: one node, no tools, no syllabus binding." />

      <h2>How it&apos;s wired</h2>
      <p>
        The node makes a single LLM call with{" "}
        <code>response_format = json_object</code>, no tools bound. The
        system prompt tells the model it has no access to course
        material and asks it to produce a self-contained worksheet from
        the user prompt alone. We pass the same coerce-then-parse
        Worksheet validator the tooled version uses, so a model that
        forgets to emit four options or omits the explanation field is
        coerced into shape rather than failing the whole turn.
      </p>

      <h2>Why we ship it on purpose</h2>
      <p>
        Without the toolless variant it would be too easy for a teacher
        evaluating the platform to assume that &quot;LLMs can already
        write worksheets&quot; and miss what the tooled agent is
        actually doing. With both visible side-by-side, the differences
        are immediate — and they tell the right story:
      </p>
      <ul>
        <li>
          <strong>Lesson alignment.</strong> The toolless agent has no
          way to know what is or isn&apos;t in the lesson; mcq
          distractors and short-answer prompts often drift to topics
          your course never covered.
        </li>
        <li>
          <strong>Audience drift.</strong> Without the syllabus&apos;
          <code> audience</code>, <code>scope</code>, and{" "}
          <code>pedagogy</code> fields, the toolless agent defaults to a
          generic &quot;intro&quot; level regardless of the bound
          chapter&apos;s difficulty.
        </li>
        <li>
          <strong>Confabulation.</strong> Toolless can — and does —
          invent lesson titles like &quot;Section 3.2: Linear-time
          Selection&quot; that don&apos;t exist anywhere in your
          syllabus, because nothing forces it to ground a claim in real
          data.
        </li>
      </ul>

      <h2>Comparison with the tooled agent</h2>
      <p>
        Run the same prompt against{" "}
        <Link href="/docs/agents/activity-generator-tooled">
          activity-generator-tooled
        </Link>{" "}
        on a bound syllabus thread and at the same agent on a fresh
        toolless thread. The output shape is identical (same Zod
        schema), but the tooled output cites concepts that actually
        appear in your lesson body, picks distractors from prior
        chapters, and reuses the lesson&apos; assessment seed for the
        worked example. The toolless output looks plausible but
        isn&apos;t aligned with anything in particular. That gap is the
        whole pedagogical point of giving an LLM tools.
      </p>
    </DocShell>
  );
}

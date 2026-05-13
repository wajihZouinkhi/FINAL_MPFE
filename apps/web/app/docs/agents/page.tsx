import Link from "next/link";

/**
 * Per-agent doc registry. Each entry corresponds to a static page at
 * `/docs/agents/<slug>`. Add new agents by appending here AND creating
 * the matching `app/docs/agents/<slug>/page.tsx`.
 */
const AGENT_DOCS: Array<{
  slug: string;
  title: string;
  summary: string;
  status: "live" | "planned";
}> = [
  {
    slug: "syllabus-generator",
    title: "Syllabus Generator",
    summary:
      "Supervisor-routed multi-agent system that researches a topic, drafts a chapter plan, and writes pedagogically-grounded lessons one at a time under a critic loop.",
    status: "live",
  },
  {
    slug: "activity-generator-tooled",
    title: "Activity Generator (with tools)",
    summary:
      "Worksheet generator bound to a syllabus thread. Uses an external Python MCP server (fastmcp + supabase-py) over stdio to read chapters and lesson markdown, then produces a structured Worksheet JSON grounded in actual course material.",
    status: "live",
  },
  {
    slug: "activity-generator-toolless",
    title: "Activity Generator (no tools)",
    summary:
      "Same wire shape as the tooled version but with no access to course material. Useful as a side-by-side baseline showing why grounding via MCP matters for reliable downstream artefacts.",
    status: "live",
  },
  {
    slug: "deepagent",
    title: "Deep Agent",
    summary:
      "Generalist supervisor + four specialist subagents (pedagogy_planner, writer, activity_maker, pedagogy_critic) on deepagents@1.9. The supervisor decides at runtime whether each user request needs a syllabus build, a worksheet, a critique, or just an answer — composing capabilities in the same chat over a shared VFS.",
    status: "live",
  },
];

export const metadata = {
  title: "Agents — FINAL_MPFE",
  description: "Architecture documentation for each agent in the platform.",
};

export default function AgentsIndexPage() {
  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <div className="mx-auto max-w-3xl px-6 py-10 sm:py-14">
        <Link
          href="/threads"
          className="mb-8 inline-block rounded-full border border-[var(--border)] px-3 py-1 text-xs text-[var(--muted-foreground)] transition hover:border-[var(--primary)] hover:text-[var(--foreground)]"
        >
          ← back to app
        </Link>

        <header className="mb-10">
          <p className="mb-2 font-mono text-xs uppercase tracking-widest text-[var(--secondary)]">
            FINAL_MPFE / docs
          </p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Agents
          </h1>
          <p className="mt-3 text-base leading-relaxed text-[var(--muted-foreground)]">
            One doc page per agent. Each page covers the agent&apos;s graph
            topology, why we picked the supervisor pattern over a naive
            ReAct loop, and the optimisations layered on top (critic gating,
            context rehydration, patch-based revisions, off-state heavy
            data).
          </p>
        </header>

        <ul className="grid gap-4">
          {AGENT_DOCS.map((agent) => (
            <li key={agent.slug}>
              {agent.status === "live" ? (
                <Link
                  href={`/docs/agents/${agent.slug}`}
                  className="group block rounded-lg border border-[var(--border)] bg-[var(--card)] p-5 transition hover:border-[var(--primary)]"
                >
                  <div className="mb-1 flex items-center justify-between">
                    <h2 className="text-lg font-semibold text-[var(--foreground)] group-hover:text-[var(--primary)]">
                      {agent.title}
                    </h2>
                    <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--success)]">
                      live
                    </span>
                  </div>
                  <p className="text-sm leading-relaxed text-[var(--muted-foreground)]">
                    {agent.summary}
                  </p>
                </Link>
              ) : (
                <div className="block rounded-lg border border-dashed border-[var(--border)] bg-[var(--card)]/40 p-5 opacity-60">
                  <div className="mb-1 flex items-center justify-between">
                    <h2 className="text-lg font-semibold">{agent.title}</h2>
                    <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--muted-foreground)]">
                      planned
                    </span>
                  </div>
                  <p className="text-sm leading-relaxed text-[var(--muted-foreground)]">
                    {agent.summary}
                  </p>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

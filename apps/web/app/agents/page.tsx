"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  ExternalLink,
  FlaskConical,
  GraduationCap,
  Plug,
  Sparkles,
} from "lucide-react";
import type { AgentKind } from "@mpfe/shared";
import { NewThreadModal } from "../../components/threads/new-thread-modal";

interface AgentCard {
  kind: AgentKind;
  title: string;
  blurb: string;
  bullets: string[];
  badge: string;
  badgeTone: string;
  icon: React.ReactNode;
  docHref: string;
}

const AGENTS: AgentCard[] = [
  {
    kind: "syllabus-generator",
    title: "Syllabus generator",
    blurb:
      "The flagship agent. Researches a topic, plans chapters and lessons under a TodoCard contract, then writes graded markdown lessons through a writer/critic loop.",
    bullets: [
      "Supervisor router → search → command(write)",
      "Critic v2 with severity-aware gating",
      "Search/replace patches on revision",
      "Streams typed slices over SSE + Redis",
    ],
    badge: "Course author",
    badgeTone:
      "border-sky-400/35 bg-sky-400/15 text-sky-300",
    icon: <GraduationCap className="h-4 w-4" />,
    docHref: "/docs/agents/syllabus-generator",
  },
  {
    kind: "activity-generator-tooled",
    title: "Activity generator (with tools)",
    blurb:
      "Builds worksheets grounded in your existing course material. Calls a Python MCP server (fastmcp + supabase-py) to read chapters and lessons, then asks the LLM to produce a JSON worksheet from the actual lesson body.",
    bullets: [
      "Bound to one syllabus thread per activity thread",
      "Tools: list_lessons_for_thread / get_lesson",
      "Two-phase generation: pick lesson → produce JSON",
      "Grounded mcqs, model answers, worked examples",
    ],
    badge: "MCP / grounded",
    badgeTone:
      "border-emerald-400/35 bg-emerald-400/15 text-emerald-300",
    icon: <Plug className="h-4 w-4" />,
    docHref: "/docs/agents/activity-generator-tooled",
  },
  {
    kind: "activity-generator-toolless",
    title: "Activity generator (no tools)",
    blurb:
      "Same wire shape as the tooled version, but no access to your syllabus. Useful as a side-by-side baseline to show what 'an LLM that can't read your course' looks like.",
    bullets: [
      "Same Worksheet zod schema",
      "No tools, no MCP, no syllabus binding",
      "Demonstrates ungrounded hallucination by design",
      "Run the same prompt against both for comparison",
    ],
    badge: "Demo baseline",
    badgeTone:
      "border-amber-400/35 bg-amber-400/15 text-amber-300",
    icon: <FlaskConical className="h-4 w-4" />,
    docHref: "/docs/agents/activity-generator-toolless",
  },
];

/**
 * Working-side overview of available agents. The doc pages under
 * /docs/agents go deep on architecture; this one is for picking
 * which agent to use right now and starting a thread.
 */
export default function AgentsOverviewPage() {
  const [modalOpen, setModalOpen] = useState(false);
  const [defaultAgent, setDefaultAgent] = useState<AgentKind>(
    "syllabus-generator",
  );
  return (
    <main className="relative min-h-screen overflow-hidden p-6 md:p-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(900px 480px at 30% 25%, rgba(246,110,96,0.08), transparent 60%), radial-gradient(700px 420px at 75% 75%, rgba(252,175,65,0.06), transparent 60%)",
        }}
      />
      <div className="relative mx-auto w-full max-w-4xl">
        <header className="mb-8 flex items-start gap-3">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--primary)]/15 ring-1 ring-[var(--primary)]/30">
            <Sparkles className="h-4 w-4 text-[var(--primary)]" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-[1.5rem] font-semibold tracking-tight">
              Agents
            </h1>
            <p className="mt-1 max-w-xl text-[12.5px] leading-snug text-[var(--muted-foreground)]">
              Each thread runs against one agent. The platform routes
              every turn to the matching compiled LangGraph in the
              registry — same checkpointer, same SSE stream, different
              topology.{" "}
              <Link
                href="/threads"
                className="text-[var(--primary)] underline-offset-2 hover:underline"
              >
                Existing threads →
              </Link>
            </p>
          </div>
        </header>

        <ul className="grid gap-4 md:grid-cols-2">
          {AGENTS.map((a) => (
            <li
              key={a.kind}
              className="flex flex-col rounded-2xl border border-[var(--border)] bg-[var(--card)]/85 p-5 backdrop-blur"
            >
              <div className="flex items-start gap-3">
                <span
                  className={
                    "mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md ring-1 " +
                    a.badgeTone
                  }
                >
                  {a.icon}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-[14px] font-semibold tracking-tight">
                      {a.title}
                    </h2>
                    <span
                      className={
                        "rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider " +
                        a.badgeTone
                      }
                    >
                      {a.badge}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[12.5px] leading-snug text-[var(--muted-foreground)]">
                    {a.blurb}
                  </p>
                </div>
              </div>
              <ul className="mt-4 space-y-1 border-t border-[var(--border)] pt-3 text-[11.5px] leading-snug text-[var(--muted-foreground)]">
                {a.bullets.map((b, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--primary)]/55" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex flex-wrap gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setDefaultAgent(a.kind);
                    setModalOpen(true);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[var(--primary)] px-3 py-1.5 text-[12px] font-semibold text-[var(--primary-foreground)] shadow-[0_8px_24px_-12px_rgba(246,110,96,0.7)] transition hover:opacity-95"
                >
                  Start a thread
                  <ArrowRight className="h-3 w-3" />
                </button>
                <Link
                  href={a.docHref}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-1.5 text-[12px] font-medium text-[var(--muted-foreground)] hover:border-[var(--primary)]/30 hover:text-[var(--foreground)]"
                >
                  Architecture doc
                  <ExternalLink className="h-3 w-3" />
                </Link>
              </div>
            </li>
          ))}
        </ul>

        <section className="mt-10 rounded-xl border border-[var(--border)] bg-[var(--card)]/60 p-5">
          <h3 className="text-[13px] font-semibold tracking-tight">
            Why two activity agents?
          </h3>
          <p className="mt-1.5 text-[12px] leading-snug text-[var(--muted-foreground)]">
            The tooled activity agent and the toolless one are built
            with the same output schema on purpose. Run the same
            prompt against both and the differences are immediate:
            the tooled version cites concepts that actually appear in
            your lesson, picks reasonable distractors based on prior
            chapters, and respects the audience level you set on the
            syllabus. The toolless version invents lesson titles,
            treats every concept as already-known, and produces
            generic distractors. That contrast is the whole pedagogical
            point of giving an LLM tools.
          </p>
        </section>
      </div>
      <NewThreadModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        defaultAgent={defaultAgent}
      />
    </main>
  );
}

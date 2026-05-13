"use client";

import { useState } from "react";

type Step = {
  id: string;
  label: string;
  badge: "redis" | "llm" | "gate" | "state";
  detail: string;
  redis?: { op: "GET" | "SET"; key: string; value?: string };
  state?: Record<string, string>;
  log?: string;
};

const STEPS: Step[] = [
  {
    id: "rehydrate",
    label: "Rehydrate from Redis",
    badge: "redis",
    detail:
      "At the start of every per-lesson cycle the writer reads two keys keyed by the lesson UUID. If either is present we set revision_mode=true and start attempt 0 with the prior context — instead of regenerating from scratch.",
    redis: {
      op: "GET",
      key: "draft:t-9af2:l-graph-intro",
      value: "// 1882 chars of prior draft markdown",
    },
    state: {
      "revision_mode": "true",
      "attempt": "0",
      "draft.length": "1882",
      "lastIssues.length": "3",
    },
    log: 'lesson "Intro to property graphs" rehydrated prior draft (1882 chars) from cache — entering revision mode on attempt 0',
  },
  {
    id: "writer",
    label: "Writer LLM call",
    badge: "llm",
    detail:
      "In revision mode the writer is prompted with the prior draft + a sorted list of the critic's issues, and asked to emit Aider-style SEARCH/REPLACE blocks instead of a full rewrite.",
    state: {
      "model": "google/gemma-4-31b-it",
      "system_prompt": "sysWriterPatch (revision mode)",
      "max_tokens": "4096",
    },
    log: "writer.invoke([sysWriterPatch, userMsg]) — emitted 2 SEARCH/REPLACE blocks",
  },
  {
    id: "apply",
    label: "Parse + apply patch",
    badge: "state",
    detail:
      "parseSearchReplaceBlocks() extracts the blocks; applySearchReplaceBlocks() applies them sequentially with a fuzzy whitespace-tolerant matcher. Ambiguous SEARCH = refusal, not a guess.",
    state: {
      "blocks.length": "2",
      "apply.ok": "true",
      "apply.applied": "2",
      "draft.length": "6155",
    },
    log: 'lesson "Intro to property graphs" attempt 1: applied 2 patch block(s)',
  },
  {
    id: "critic",
    label: "Critic LLM call",
    badge: "llm",
    detail:
      "The critic returns a structured response: a `pass` boolean and a list of issues, each tagged with severity (block / warn / nit).",
    state: {
      "issues[0].severity": '"warn"',
      "issues[1].severity": '"nit"',
      "blockCount": "0",
      "pass (raw from critic)": "true",
    },
    log: "critic returned 2 issues (0 block, 1 warn, 1 nit)",
  },
  {
    id: "gate",
    label: "Orchestrator gate",
    badge: "gate",
    detail:
      "Source-of-truth check: pass iff (critic.pass && blockCount === 0). Warns and nits never fail a lesson, on any attempt.",
    state: {
      "expression": "true && (0 === 0)",
      "value": "true",
      "accepted": "true",
    },
    log: 'lesson "Intro to property graphs" passed critic on attempt 1 (2 non-block issues)',
  },
  {
    id: "cache",
    label: "Persist to Redis",
    badge: "redis",
    detail:
      "After every cycle (pass or fail) we write both the latest draft and the latest critic issue list back to Redis with a 30-minute TTL. A follow-up turn for the same lesson UUID will pick up exactly here.",
    redis: {
      op: "SET",
      key: "draft:t-9af2:l-graph-intro",
      value: "// 6155 chars · TTL 1800s",
    },
    state: {
      "draft TTL": "1799s",
      "critic_issues TTL": "1799s",
    },
  },
  {
    id: "commit",
    label: "Commit to Supabase",
    badge: "state",
    detail:
      "Only on accept. Promotes the lesson row from status='pending' to status='accepted' and emits a manifest update onto the run's Redis Stream so the FE flips the card to green.",
    state: {
      "lessons.id": "l-graph-intro",
      "lessons.status": '"accepted"',
      "manifest event": '"manifest"',
    },
  },
];

const BADGE_META: Record<Step["badge"], { label: string; color: string }> = {
  redis: { label: "redis", color: "text-[var(--secondary)]" },
  llm: { label: "llm", color: "text-[var(--primary)]" },
  gate: { label: "gate", color: "text-[var(--success)]" },
  state: { label: "state", color: "text-[var(--foreground)]" },
};

/**
 * Click-through walkthrough of one accepted lesson cycle. Built to be
 * shown live in a presentation — at every step the relevant Redis ops,
 * state diff, and log line that the API would emit are all visible.
 */
export function LessonTraceStepper() {
  const [idx, setIdx] = useState(0);
  const step = STEPS[idx];
  const badge = BADGE_META[step.badge];

  return (
    <div className="my-8 rounded-lg border border-[var(--border)] bg-[var(--card)]">
      <header className="border-b border-[var(--border)] px-4 py-3">
        <p className="font-mono text-[10px] uppercase tracking-widest text-[var(--secondary)]">
          interactive — lesson trace stepper
        </p>
        <p className="mt-1 text-sm text-[var(--muted-foreground)]">
          One full per-lesson cycle, end to end. Use the arrows or click any step.
        </p>
      </header>

      <ol className="flex flex-wrap gap-2 border-b border-[var(--border)] px-4 py-3">
        {STEPS.map((s, i) => {
          const isActive = i === idx;
          const isDone = i < idx;
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setIdx(i)}
                className={`flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-widest transition ${
                  isActive
                    ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
                    : isDone
                      ? "border-[var(--success)]/40 text-[var(--success)]/80"
                      : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--primary)]/40 hover:text-[var(--foreground)]"
                }`}
              >
                <span className="opacity-60">{i + 1}</span>
                {s.label}
              </button>
            </li>
          );
        })}
      </ol>

      <div className="grid gap-px bg-[var(--border)] md:grid-cols-[1fr_1fr]">
        <div className="bg-[var(--card)] p-4">
          <div className="mb-2 flex items-center gap-2">
            <span
              className={`inline-flex w-14 items-center justify-center rounded-full bg-[var(--muted)]/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${badge.color}`}
            >
              {badge.label}
            </span>
            <h4 className="m-0 text-base font-semibold text-[var(--foreground)]">
              {step.label}
            </h4>
          </div>
          <p className="text-sm leading-relaxed text-[var(--foreground)]/85">
            {step.detail}
          </p>
        </div>

        <div className="bg-[var(--card)] p-4">
          {step.redis ? (
            <Block label="redis op">
              <code className="block whitespace-pre-wrap font-mono text-xs leading-relaxed text-[var(--secondary)]">
                {step.redis.op} {step.redis.key}
                {step.redis.value ? `\n${step.redis.value}` : null}
              </code>
            </Block>
          ) : null}
          {step.state ? (
            <Block label="state diff">
              <ul className="m-0 list-none p-0">
                {Object.entries(step.state).map(([k, v]) => (
                  <li
                    key={k}
                    className="my-0.5 font-mono text-xs leading-relaxed"
                  >
                    <span className="text-[var(--muted-foreground)]">{k}</span>
                    <span className="text-[var(--muted-foreground)]/40">
                      {" = "}
                    </span>
                    <span className="text-[var(--foreground)]">{v}</span>
                  </li>
                ))}
              </ul>
            </Block>
          ) : null}
          {step.log ? (
            <Block label="api log">
              <code className="block break-words font-mono text-[11px] leading-relaxed text-[var(--success)]/90">
                {step.log}
              </code>
            </Block>
          ) : null}
        </div>
      </div>

      <footer className="flex items-center justify-between border-t border-[var(--border)] px-4 py-3">
        <button
          type="button"
          onClick={() => setIdx((i) => Math.max(0, i - 1))}
          disabled={idx === 0}
          className="rounded-full border border-[var(--border)] px-3 py-1 font-mono text-[10px] uppercase tracking-widest transition hover:border-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          ← prev
        </button>
        <p className="font-mono text-[10px] uppercase tracking-widest text-[var(--muted-foreground)]">
          step {idx + 1} / {STEPS.length}
        </p>
        <button
          type="button"
          onClick={() => setIdx((i) => Math.min(STEPS.length - 1, i + 1))}
          disabled={idx === STEPS.length - 1}
          className="rounded-full border border-[var(--border)] px-3 py-1 font-mono text-[10px] uppercase tracking-widest transition hover:border-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          next →
        </button>
      </footer>
    </div>
  );
}

function Block({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3 last:mb-0">
      <p className="mb-1 font-mono text-[10px] uppercase tracking-widest text-[var(--muted-foreground)]">
        {label}
      </p>
      {children}
    </div>
  );
}

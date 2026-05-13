"use client";

import { useMemo, useState } from "react";

type Severity = "block" | "warn" | "nit";

type Issue = {
  id: string;
  text: string;
  severity: Severity;
};

const SEED_ISSUES: Issue[] = [
  {
    id: "i1",
    text: "Lesson claims property graphs offer O(1) traversal — unsupported by the cited source.",
    severity: "block",
  },
  {
    id: "i2",
    text: "Citation style mixes APA and MLA across the bibliography.",
    severity: "nit",
  },
  {
    id: "i3",
    text: "Worked example uses 4-space indentation; rest of the lesson uses 2.",
    severity: "nit",
  },
  {
    id: "i4",
    text: "Wrap-up paragraph repeats the introduction nearly verbatim.",
    severity: "warn",
  },
  {
    id: "i5",
    text: "Assessment idea doesn't actually probe the learning objective.",
    severity: "warn",
  },
];

const SEVERITY_META: Record<
  Severity,
  { label: string; color: string; ring: string; bg: string }
> = {
  block: {
    label: "block",
    color: "text-[var(--destructive)]",
    ring: "ring-[var(--destructive)]",
    bg: "bg-[var(--destructive)]/10",
  },
  warn: {
    label: "warn",
    color: "text-[var(--secondary)]",
    ring: "ring-[var(--secondary)]",
    bg: "bg-[var(--secondary)]/10",
  },
  nit: {
    label: "nit",
    color: "text-[var(--muted-foreground)]",
    ring: "ring-[var(--muted-foreground)]",
    bg: "bg-[var(--muted)]/40",
  },
};

const ALL_SEVERITIES: Severity[] = ["block", "warn", "nit"];

/**
 * Interactive critic-gate playground. Toggle the severity of each mock
 * critic issue and watch the verdict from the OLD gate ("any issue ⇒
 * fail") and the NEW gate ("only block-severity ⇒ fail") update live.
 *
 * Pure client state — no API calls. Drives the same logic the
 * orchestrator uses: pass = critic.pass && blockCount === 0.
 */
export function CriticGateSimulator() {
  const [issues, setIssues] = useState<Issue[]>(SEED_ISSUES);

  const counts = useMemo(() => {
    const c = { block: 0, warn: 0, nit: 0, total: issues.length };
    for (const i of issues) c[i.severity] += 1;
    return c;
  }, [issues]);

  const oldGatePasses = counts.total === 0;
  const newGatePasses = counts.block === 0;

  const cycleSeverity = (id: string) => {
    setIssues((prev) =>
      prev.map((i) => {
        if (i.id !== id) return i;
        const next =
          ALL_SEVERITIES[
            (ALL_SEVERITIES.indexOf(i.severity) + 1) % ALL_SEVERITIES.length
          ];
        return { ...i, severity: next };
      }),
    );
  };

  return (
    <div className="my-8 rounded-lg border border-[var(--border)] bg-[var(--card)]">
      <header className="border-b border-[var(--border)] px-4 py-3">
        <p className="font-mono text-[10px] uppercase tracking-widest text-[var(--secondary)]">
          interactive — critic gate simulator
        </p>
        <p className="mt-1 text-sm text-[var(--muted-foreground)]">
          Click a severity badge to cycle <code className="rounded bg-[var(--muted)] px-1 font-mono text-[var(--secondary)]">block → warn → nit</code>.
          Watch the two verdicts diverge.
        </p>
      </header>

      <div className="grid gap-0 md:grid-cols-[1fr_auto_1fr]">
        <ul className="divide-y divide-[var(--border)]">
          {issues.map((issue) => {
            const meta = SEVERITY_META[issue.severity];
            return (
              <li key={issue.id} className="flex items-start gap-3 px-4 py-3">
                <button
                  type="button"
                  onClick={() => cycleSeverity(issue.id)}
                  className={`mt-0.5 inline-flex w-16 shrink-0 items-center justify-center rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ring-1 ring-inset transition ${meta.color} ${meta.ring} ${meta.bg} hover:brightness-125`}
                  aria-label={`severity is ${meta.label}, click to cycle`}
                >
                  {meta.label}
                </button>
                <p className="text-sm leading-relaxed text-[var(--foreground)]/90">
                  {issue.text}
                </p>
              </li>
            );
          })}
        </ul>

        <div className="hidden w-px bg-[var(--border)] md:block" />

        <div className="grid grid-rows-2 divide-y divide-[var(--border)] border-t border-[var(--border)] md:border-t-0">
          <GateVerdict
            label="old gate"
            sub="any issue ⇒ fail (on first two attempts)"
            passes={oldGatePasses}
            counts={counts}
          />
          <GateVerdict
            label="new gate"
            sub="only block-severity ⇒ fail"
            passes={newGatePasses}
            counts={counts}
            highlight
          />
        </div>
      </div>

      <footer className="border-t border-[var(--border)] px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-[var(--muted-foreground)]">
        block: {counts.block} &nbsp;·&nbsp; warn: {counts.warn} &nbsp;·&nbsp; nit: {counts.nit} &nbsp;·&nbsp; total: {counts.total}
      </footer>
    </div>
  );
}

function GateVerdict({
  label,
  sub,
  passes,
  counts,
  highlight = false,
}: {
  label: string;
  sub: string;
  passes: boolean;
  counts: { block: number; warn: number; nit: number; total: number };
  highlight?: boolean;
}) {
  const colour = passes
    ? "border-[var(--success)]/50 bg-[var(--success)]/5 text-[var(--success)]"
    : "border-[var(--destructive)]/50 bg-[var(--destructive)]/5 text-[var(--destructive)]";
  const ringIfHighlight = highlight ? "ring-1 ring-[var(--primary)]/30" : "";
  return (
    <div className={`flex flex-col gap-2 px-4 py-4 ${ringIfHighlight}`}>
      <p className="font-mono text-[10px] uppercase tracking-widest text-[var(--muted-foreground)]">
        {label}
      </p>
      <p className="text-xs text-[var(--muted-foreground)]">{sub}</p>
      <div
        className={`mt-1 inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1 font-mono text-xs uppercase tracking-widest ${colour}`}
      >
        <span className={passes ? "text-[var(--success)]" : "text-[var(--destructive)]"}>
          {passes ? "passes" : "fails"}
        </span>
        <span className="text-[var(--muted-foreground)]">
          ({passes ? "lesson commits" : "rewrite required"})
        </span>
      </div>
      <code className="mt-1 block whitespace-pre-wrap font-mono text-[10px] leading-tight text-[var(--muted-foreground)]">
        {label === "old gate"
          ? `pass = (issues.length === 0)\n     = (${counts.total} === 0)\n     = ${passes}`
          : `pass = critic.pass && blockCount === 0\n     = true && (${counts.block} === 0)\n     = ${passes}`}
      </code>
    </div>
  );
}

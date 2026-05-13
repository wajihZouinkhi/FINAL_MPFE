"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Compass,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Globe,
  ListChecks,
  Download,
  Sparkles,
  ExternalLink,
} from "lucide-react";
import type {
  ResearchPickedSource,
  ResearchPlan,
  ResearchSourceType,
  ResearchStep,
} from "@mpfe/shared";

/**
 * Best-effort hostname extraction for `source.url` so we can render a
 * favicon + a short label. We deliberately swallow `URL` parser
 * failures: bad / relative URLs slip through Serper occasionally and
 * the card should degrade to a text-only row rather than crash the
 * whole turn.
 */
function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Pretty short-form labels for the picker's coarse source categories.
 * Audit §3.1 calls them out as a glanceable signal in the research
 * card — a `[curriculum]` chip on a kept source tells the reader the
 * pick was prioritised by the diversity rule, not just lucky.
 */
const SOURCE_TYPE_LABEL: Record<ResearchSourceType, string> = {
  curriculum: "curriculum",
  textbook: "textbook",
  paper: "paper",
  course: "course",
  official_docs: "docs",
  reference: "reference",
  other: "other",
};

/**
 * Inline research card (Perplexity-style). Renders the goal, the list of
 * topics, and a progressive status per topic. Subscribes to the live
 * research_plan slice; updates in place as new snapshots arrive.
 */
export function ResearchCard({ plan }: { plan: ResearchPlan }) {
  const [open, setOpen] = useState(true);
  const total = plan.steps.length;
  const done = plan.steps.filter((s) => s.status === "done").length;
  const failed = plan.steps.filter((s) => s.status === "failed").length;
  const running = total > 0 && done + failed < total;

  return (
    <section className="animate-fade-in overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)]/80 text-[13px] shadow-[0_4px_24px_-12px_rgba(0,0,0,0.5)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-[var(--accent)]/40"
      >
        <Compass className="h-3.5 w-3.5 text-[var(--secondary)]" />
        <span className="font-semibold">Research plan</span>
        <span className="text-[11px] text-[var(--muted-foreground)]">
          {done}/{total}
          {failed > 0 ? (
            <span className="ml-1 text-[var(--destructive)]">· {failed} failed</span>
          ) : null}
        </span>
        <span className="ml-auto flex items-center gap-2 text-[var(--muted-foreground)]">
          {running ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </span>
      </button>
      {open ? (
        <div className="border-t border-[var(--border)] px-3 py-2">
          {plan.goal ? (
            <p className="mb-2 text-[11.5px] italic text-[var(--muted-foreground)]">
              Goal: {plan.goal}
            </p>
          ) : null}
          <ul className="space-y-1.5">
            {plan.steps.map((s) => (
              <Step key={s.id} step={s} />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function Step({ step }: { step: ResearchStep }) {
  // Picked sources only render once the picker has run — until then
  // we show queries only. Once present they stay visible through the
  // scrape + done stages so the user can see *which* URLs got picked
  // even mid-scrape (audit §3.1).
  const sources = step.picked ?? [];
  return (
    <li className="flex flex-col gap-0.5 rounded border border-[var(--border)]/70 bg-[var(--background)]/60 px-2 py-1.5 transition hover:border-[var(--secondary)]/40">
      <div className="flex items-center gap-1.5">
        <StepIcon status={step.status} />
        <span className="font-mono text-[10px] text-[var(--muted-foreground)]">
          {step.id}
        </span>
        <span className="flex-1 truncate text-[12px] font-medium">
          {step.title}
        </span>
        <span className="text-[10px] capitalize text-[var(--muted-foreground)]">
          {labelFor(step)}
        </span>
      </div>
      {step.queries.length > 0 && sources.length === 0 ? (
        <ul className="ml-5 space-y-0.5 text-[10.5px] text-[var(--muted-foreground)]">
          {step.queries.slice(0, 3).map((q, i) => (
            <li key={i} className="truncate">
              › {q}
            </li>
          ))}
        </ul>
      ) : null}
      {sources.length > 0 ? (
        <ul className="mt-1 ml-5 space-y-1 text-[10.5px]">
          {sources.map((src, i) => (
            <SourceRow key={`${step.id}-${i}-${src.url}`} source={src} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function SourceRow({ source }: { source: ResearchPickedSource }) {
  const host = hostnameOf(source.url);
  const faviconUrl = host
    ? `https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(host)}`
    : null;
  return (
    <li className="flex items-start gap-1.5">
      {faviconUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={faviconUrl}
          alt=""
          width={14}
          height={14}
          className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-sm bg-[var(--background)]"
          // Hide on load failure so we don't show a broken-image glyph
          // for hosts whose favicon Google's mirror can't resolve.
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : (
        <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <a
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          className="group flex items-baseline gap-1 truncate font-medium text-[var(--foreground)] hover:text-[var(--secondary)] hover:underline"
          title={source.url}
        >
          <span className="truncate">{source.title || source.url}</span>
          <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-0 transition group-hover:opacity-70" />
        </a>
        <div className="flex items-center gap-1.5 text-[10px] text-[var(--muted-foreground)]">
          <span className="rounded bg-[var(--accent)]/40 px-1 py-px font-mono uppercase tracking-tight">
            {SOURCE_TYPE_LABEL[source.source_type] ?? source.source_type}
          </span>
          {host ? <span className="truncate">{host}</span> : null}
        </div>
        {source.snippet ? (
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-[var(--muted-foreground)]">
            {source.snippet}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function StepIcon({ status }: { status: ResearchStep["status"] }) {
  switch (status) {
    case "done":
      return <CheckCircle2 className="h-3 w-3 text-[var(--success)]" />;
    case "failed":
      return <AlertCircle className="h-3 w-3 text-[var(--destructive)]" />;
    case "searching_urls":
      return <Globe className="h-3 w-3 animate-pulse text-[var(--secondary)]" />;
    case "picking_candidates":
      return <ListChecks className="h-3 w-3 animate-pulse text-[var(--secondary)]" />;
    case "scraping":
      return <Download className="h-3 w-3 animate-pulse text-[var(--primary)]" />;
    case "summarizing":
      return <Sparkles className="h-3 w-3 animate-pulse text-[var(--secondary)]" />;
    default:
      return <Loader2 className="h-3 w-3 text-[var(--muted-foreground)]" />;
  }
}

function labelFor(step: ResearchStep): string {
  switch (step.status) {
    case "pending":
      return "queued";
    case "searching_urls":
      return "searching";
    case "picking_candidates":
      return "picking";
    case "scraping":
      return `scraping ${step.scraped_count}/${step.picked_count}`;
    case "summarizing":
      return "summarizing";
    case "done":
      return `${step.scraped_count}/${step.picked_count} sources`;
    case "failed":
      return "failed";
  }
}

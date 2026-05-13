import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Shared chrome for `/docs/...` routes. Renders a slim back-link, a
 * tag/title header, and a constrained reading column. Each agent doc
 * page composes this shell with its own body content (mermaid +
 * prose). Keep this purely presentational — no fetching, no state.
 */
export function DocShell({
  eyebrow,
  title,
  subtitle,
  updatedAt,
  children,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  updatedAt?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <div className="mx-auto max-w-3xl px-6 py-10 sm:py-14">
        <div className="mb-8 flex items-center justify-between text-xs text-[var(--muted-foreground)]">
          <Link
            href="/docs/agents"
            className="rounded-full border border-[var(--border)] px-3 py-1 transition hover:border-[var(--primary)] hover:text-[var(--foreground)]"
          >
            ← all agents
          </Link>
          <Link
            href="/threads"
            className="rounded-full border border-[var(--border)] px-3 py-1 transition hover:border-[var(--primary)] hover:text-[var(--foreground)]"
          >
            open the app →
          </Link>
        </div>

        <header className="mb-10 border-b border-[var(--border)] pb-8">
          <p className="mb-2 font-mono text-xs uppercase tracking-widest text-[var(--secondary)]">
            {eyebrow}
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-[var(--foreground)] sm:text-4xl">
            {title}
          </h1>
          {subtitle ? (
            <p className="mt-3 text-base leading-relaxed text-[var(--muted-foreground)]">
              {subtitle}
            </p>
          ) : null}
          {updatedAt ? (
            <p className="mt-4 font-mono text-[10px] uppercase tracking-widest text-[var(--muted-foreground)]">
              last updated {updatedAt}
            </p>
          ) : null}
        </header>

        <article className="prose prose-invert max-w-none text-[var(--foreground)] [&_a]:text-[var(--primary)] [&_a]:underline-offset-4 [&_a]:decoration-[var(--primary)]/40 hover:[&_a]:decoration-[var(--primary)] [&_code]:rounded [&_code]:bg-[var(--muted)] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_code]:text-[var(--secondary)] [&_h2]:mt-12 [&_h2]:scroll-mt-20 [&_h2]:border-b [&_h2]:border-[var(--border)] [&_h2]:pb-2 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:text-[var(--foreground)] [&_h3]:mt-8 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:text-[var(--secondary)] [&_li]:my-1 [&_p]:my-4 [&_p]:leading-relaxed [&_strong]:text-[var(--foreground)] [&_ul]:my-4 [&_ul]:list-disc [&_ul]:pl-6">
          {children}
        </article>

        <footer className="mt-16 border-t border-[var(--border)] pt-6 text-xs text-[var(--muted-foreground)]">
          Each future agent gets its own page under{" "}
          <code className="rounded bg-[var(--muted)] px-1.5 py-0.5 font-mono text-[var(--secondary)]">
            /docs/agents/&lt;slug&gt;
          </code>
          .
        </footer>
      </div>
    </div>
  );
}

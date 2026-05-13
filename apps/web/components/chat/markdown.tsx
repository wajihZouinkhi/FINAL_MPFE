"use client";

import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Compact markdown renderer used inside chat bubbles. Inline code, links,
 * lists, and tables are styled via the shared `.prose-custom` rules in
 * globals.css. Block-level headings/lists are rendered through a small
 * components map so we don't pull in @tailwindcss/typography just for chat.
 *
 * NOTE: this component intentionally does NOT use `useDeferredValue`.
 * During token-by-token streaming the supervisor produces 30–80 deltas
 * over 2–6 seconds; with `useDeferredValue` React's concurrent scheduler
 * would coalesce the rapid `source` updates into a single deferred render
 * once the stream finishes, so the bubble appeared empty the whole time
 * and the entire message landed at the end — defeating the purpose of
 * streaming. Chat bubble markdown is short (≤ a few hundred chars) so
 * re-parsing on every delta is cheap; the parent `memo()` wrapper below
 * keeps unrelated re-renders out.
 */

const components: Components = {
  p: ({ children }) => (
    <p className="mb-2 leading-relaxed last:mb-0">{children}</p>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-[var(--primary)] underline underline-offset-2 hover:text-[var(--secondary)]"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }) => (
    <h1 className="mb-1 mt-3 text-lg font-semibold text-[var(--primary)]">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-1 mt-3 text-base font-semibold text-[var(--secondary)]">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1 mt-2 text-sm font-semibold">{children}</h3>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-[var(--primary)] bg-[rgba(246,110,96,0.07)] py-1 pl-3 italic text-[#f0d9b9]">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-[var(--border)]" />,
};

function MarkdownImpl({ source }: { source: string }) {
  return (
    <div className="prose-custom break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(
  MarkdownImpl,
  (a, b) => a.source === b.source,
);
Markdown.displayName = "Markdown";

import type { ReactNode } from "react";

/**
 * Inline note/warn/win callout used inside agent doc pages.
 *
 * Three flavours:
 *  - `note` — neutral aside, e.g. terminology clarification.
 *  - `warn` — pre-fix behaviour or known limitation.
 *  - `win`  — outcome of an optimisation, e.g. "this is what fixed X".
 */
export function Callout({
  variant = "note",
  title,
  children,
}: {
  variant?: "note" | "warn" | "win";
  title?: string;
  children: ReactNode;
}) {
  const palette = {
    note: {
      border: "border-[var(--secondary)]/40",
      bg: "bg-[var(--secondary)]/5",
      tag: "text-[var(--secondary)]",
      label: "note",
    },
    warn: {
      border: "border-[var(--destructive)]/40",
      bg: "bg-[var(--destructive)]/5",
      tag: "text-[var(--destructive)]",
      label: "before",
    },
    win: {
      border: "border-[var(--success)]/40",
      bg: "bg-[var(--success)]/5",
      tag: "text-[var(--success)]",
      label: "after",
    },
  }[variant];

  return (
    <aside
      className={`my-6 rounded-lg border ${palette.border} ${palette.bg} px-4 py-3`}
    >
      <p
        className={`mb-1 font-mono text-[10px] uppercase tracking-widest ${palette.tag}`}
      >
        {palette.label}
        {title ? ` — ${title}` : null}
      </p>
      <div className="text-sm leading-relaxed text-[var(--foreground)]/90">
        {children}
      </div>
    </aside>
  );
}

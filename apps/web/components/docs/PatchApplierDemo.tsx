"use client";

import { useMemo, useState } from "react";
import {
  applySearchReplaceBlocks,
  parseSearchReplaceBlocks,
} from "@/lib/patch";

const SEED_DRAFT = `# What is a property graph?

A property graph is a data model where nodes and relationships both
carry typed properties. You can describe entities and connections
without forcing them into rows and columns.

## Worked example

Imagine a small social network with three users and a "FOLLOWS"
relationship between them. The corresponding Cypher query is:

    MATCH (a:User)-[:FOLLOWS]->(b:User) RETURN a.name, b.name

## Wrap-up

You can now describe the property graph model, draw a small graph by
hand, and write a single MATCH query.
`;

const SEED_BLOCKS = `<<<<<<< SEARCH
You can now describe the property graph model, draw a small graph by
hand, and write a single MATCH query.
=======
By the end of this lesson, you can describe the property graph model
and write a single MATCH query against a Neo4j database.
>>>>>>> REPLACE

<<<<<<< SEARCH
A property graph is a data model where nodes and relationships both
carry typed properties.
=======
A **property graph** is a data model where both nodes and the
relationships between them carry typed key/value properties.
>>>>>>> REPLACE`;

/**
 * Live demo of the writer's revision-mode patch flow. The teacher can
 * edit the prior draft, edit the SEARCH/REPLACE blocks, hit Apply, and
 * see the same parser/applier the agent uses produce a result.
 *
 * The patch module is shared with the API at apps/web/lib/patch.ts —
 * it is a byte-for-byte copy of apps/api/src/graph/command/patch.ts so
 * what's demoed here is exactly what runs in production.
 */
export function PatchApplierDemo() {
  const [draft, setDraft] = useState(SEED_DRAFT);
  const [raw, setRaw] = useState(SEED_BLOCKS);
  const [version, setVersion] = useState(0);

  const result = useMemo(() => {
    const blocks = parseSearchReplaceBlocks(raw);
    const apply = applySearchReplaceBlocks(draft, blocks);
    return { blocks, apply };
  }, [draft, raw, version]);

  const reset = () => {
    setDraft(SEED_DRAFT);
    setRaw(SEED_BLOCKS);
    setVersion((v) => v + 1);
  };

  const breakIt = () => {
    // Inject an ambiguous SEARCH (will match in 0 or >1 places after the
    // first apply) so the teacher can see graceful failure handling.
    setRaw(
      `<<<<<<< SEARCH
property graph
=======
labelled property graph (LPG)
>>>>>>> REPLACE`,
    );
    setVersion((v) => v + 1);
  };

  return (
    <div className="my-8 rounded-lg border border-[var(--border)] bg-[var(--card)]">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-[var(--secondary)]">
            interactive — patch applier demo
          </p>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">
            Edit either box. The same parser/applier the agent uses runs on every keystroke.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={breakIt}
            className="rounded-full border border-[var(--border)] px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-[var(--muted-foreground)] transition hover:border-[var(--destructive)] hover:text-[var(--destructive)]"
          >
            try an ambiguous match
          </button>
          <button
            type="button"
            onClick={reset}
            className="rounded-full border border-[var(--border)] px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-[var(--muted-foreground)] transition hover:border-[var(--primary)] hover:text-[var(--primary)]"
          >
            reset
          </button>
        </div>
      </header>

      <div className="grid gap-px bg-[var(--border)] md:grid-cols-2">
        <PaneTextarea
          label="prior draft (from redis: draft:thread:lesson)"
          value={draft}
          onChange={setDraft}
        />
        <PaneTextarea
          label="writer output — raw SEARCH/REPLACE blocks"
          value={raw}
          onChange={setRaw}
        />
      </div>

      <div className="grid gap-px bg-[var(--border)] md:grid-cols-2">
        <ParseStatus blocks={result.blocks} />
        <ApplyStatus apply={result.apply} blocks={result.blocks} />
      </div>

      <Output draft={draft} apply={result.apply} blocks={result.blocks} />
    </div>
  );
}

function PaneTextarea({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="bg-[var(--card)] p-3">
      <p className="mb-1 font-mono text-[10px] uppercase tracking-widest text-[var(--muted-foreground)]">
        {label}
      </p>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="block h-44 w-full resize-y rounded border border-[var(--border)] bg-[var(--background)] p-2 font-mono text-xs leading-relaxed text-[var(--foreground)] focus:border-[var(--primary)] focus:outline-none"
      />
    </div>
  );
}

function ParseStatus({
  blocks,
}: {
  blocks: ReturnType<typeof parseSearchReplaceBlocks>;
}) {
  const ok = blocks.length > 0;
  return (
    <div className="bg-[var(--card)] p-3">
      <p className="mb-1 font-mono text-[10px] uppercase tracking-widest text-[var(--muted-foreground)]">
        parser
      </p>
      <p
        className={`text-sm ${
          ok ? "text-[var(--success)]" : "text-[var(--destructive)]"
        }`}
      >
        parsed {blocks.length} block{blocks.length === 1 ? "" : "s"}
      </p>
    </div>
  );
}

function ApplyStatus({
  apply,
  blocks,
}: {
  apply: ReturnType<typeof applySearchReplaceBlocks>;
  blocks: ReturnType<typeof parseSearchReplaceBlocks>;
}) {
  if (blocks.length === 0) {
    return (
      <div className="bg-[var(--card)] p-3">
        <p className="mb-1 font-mono text-[10px] uppercase tracking-widest text-[var(--muted-foreground)]">
          applier
        </p>
        <p className="text-sm text-[var(--muted-foreground)]">
          waiting for parsed blocks…
        </p>
      </div>
    );
  }
  if (apply.ok) {
    return (
      <div className="bg-[var(--card)] p-3">
        <p className="mb-1 font-mono text-[10px] uppercase tracking-widest text-[var(--muted-foreground)]">
          applier
        </p>
        <p className="text-sm text-[var(--success)]">
          applied {apply.applied} block{apply.applied === 1 ? "" : "s"} cleanly
          → patch path used
        </p>
      </div>
    );
  }
  const reasonCopy: Record<string, string> = {
    no_match:
      "no match — SEARCH text is not present in the draft. Falling back to full rewrite.",
    ambiguous_match:
      "ambiguous match — SEARCH text appears more than once. Refused to guess; falling back to full rewrite.",
    no_blocks: "no parseable blocks — falling back to full rewrite.",
  };
  return (
    <div className="bg-[var(--card)] p-3">
      <p className="mb-1 font-mono text-[10px] uppercase tracking-widest text-[var(--muted-foreground)]">
        applier
      </p>
      <p className="text-sm text-[var(--destructive)]">
        block #{(apply.failedAt ?? 0) + 1} failed —{" "}
        {reasonCopy[apply.reason ?? ""] ?? apply.reason}
      </p>
    </div>
  );
}

function Output({
  draft,
  apply,
  blocks,
}: {
  draft: string;
  apply: ReturnType<typeof applySearchReplaceBlocks>;
  blocks: ReturnType<typeof parseSearchReplaceBlocks>;
}) {
  if (!apply.ok) {
    return (
      <div className="border-t border-[var(--border)] p-3">
        <p className="mb-1 font-mono text-[10px] uppercase tracking-widest text-[var(--muted-foreground)]">
          patched draft
        </p>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--destructive)]/30 bg-[var(--background)] p-3 font-mono text-xs leading-relaxed text-[var(--muted-foreground)]">
{`// patch failed — falling back to full-rewrite path
// (the writer would now be re-prompted with the original revision
//  system message and asked to regenerate the entire lesson)`}
        </pre>
      </div>
    );
  }
  return (
    <div className="border-t border-[var(--border)] p-3">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-mono text-[10px] uppercase tracking-widest text-[var(--muted-foreground)]">
          patched draft
        </p>
        <p className="font-mono text-[10px] uppercase tracking-widest text-[var(--muted-foreground)]">
          {draft.length} → {apply.text.length} chars · {apply.applied}/{blocks.length} blocks applied
        </p>
      </div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--success)]/40 bg-[var(--background)] p-3 font-mono text-xs leading-relaxed text-[var(--foreground)]">
        {renderHighlighted(draft, apply.text, blocks)}
      </pre>
    </div>
  );
}

/**
 * Highlight only the REPLACE text from each successfully-applied block.
 * Keeps the rest of the draft as-is so the eye can land on what changed.
 * Walks the result text and finds each block's replace string in order.
 */
function renderHighlighted(
  draft: string,
  patched: string,
  blocks: ReturnType<typeof parseSearchReplaceBlocks>,
) {
  const segments: Array<{ text: string; isNew: boolean }> = [];
  let cursor = 0;
  for (const block of blocks) {
    if (!block.replace.trim()) continue;
    const idx = patched.indexOf(block.replace, cursor);
    if (idx === -1) continue;
    if (idx > cursor) {
      segments.push({ text: patched.slice(cursor, idx), isNew: false });
    }
    segments.push({ text: block.replace, isNew: true });
    cursor = idx + block.replace.length;
  }
  if (cursor < patched.length) {
    segments.push({ text: patched.slice(cursor), isNew: false });
  }
  if (segments.length === 0) return patched;
  return segments.map((seg, i) =>
    seg.isNew ? (
      <mark
        key={i}
        className="rounded bg-[var(--success)]/15 px-0.5 text-[var(--success)]"
      >
        {seg.text}
      </mark>
    ) : (
      <span key={i}>{seg.text}</span>
    ),
  );
}

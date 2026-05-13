"use client";

/**
 * Manual workspace index — lists prior name-first syllabuses and
 * provides the create-syllabus form. Distinct from `/threads` (which
 * is the chat-driven flow): here a teacher types names manually for
 * each level (syllabus → unity → activity) and clicks Generate per
 * level. No supervisor-led research, no web search, no Serper.
 *
 * Driven by the new REST surface in `apps/api/src/threads/`:
 *   - GET  /api/syllabuses        — list (added with this PR)
 *   - POST /api/syllabuses        — create with title
 *   - GET  /api/syllabuses/:id/tree — post-merge tree (read on detail page)
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Hammer,
  Loader2,
  Plus,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface SyllabusSummary {
  id: string;
  title: string;
  description: string;
  thread_id: string | null;
  created_at: string;
}

export default function ManualIndexPage() {
  const router = useRouter();
  const [items, setItems] = useState<SyllabusSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const reload = useCallback(() => {
    setLoading(true);
    fetch(`${API}/api/syllabuses`, { cache: "no-store" })
      .then((r) => r.json())
      .then((body: SyllabusSummary[]) => setItems(body))
      .catch((e: unknown) =>
        toast.error("Couldn't load syllabuses", {
          description: e instanceof Error ? e.message : String(e),
        }),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const create = async () => {
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }
    setCreating(true);
    try {
      const r = await fetch(`${API}/api/syllabuses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const created = (await r.json()) as { id: string };
      toast.success("Syllabus created");
      router.push(`/manual/${created.id}`);
    } catch (e: unknown) {
      toast.error("Create failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <main className="relative flex min-h-dvh flex-col p-4 sm:p-6 md:p-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(900px 480px at 30% 25%, rgba(246,110,96,0.08), transparent 60%), radial-gradient(700px 420px at 75% 75%, rgba(252,175,65,0.06), transparent 60%)",
        }}
      />
      <div className="relative mx-auto w-full max-w-3xl">
        <header className="mb-4 flex items-center gap-3">
          <Link
            href="/threads"
            aria-label="Back to threads"
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)] transition hover:text-[var(--primary)]"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--primary)]/15 ring-1 ring-[var(--primary)]/30">
            <Hammer className="h-4 w-4 text-[var(--primary)]" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-[1.4rem] font-semibold tracking-tight">
              Manual workspace
            </h1>
            <p className="mt-0.5 text-[12.5px] text-[var(--muted-foreground)]">
              Type each unity and activity name yourself, then click
              Generate. No supervisor planning, no web research — pure
              LLM + indexing (each generate looks up{" "}
              <code className="rounded bg-[var(--muted)] px-1">
                find_related_activities
              </code>{" "}
              first so new content stays complementary to what's already
              in the same syllabus).
            </p>
          </div>
        </header>

        {/* Create form */}
        <section className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--card)]/85 p-4 backdrop-blur">
          <h2 className="mb-3 flex items-center gap-2 text-[13px] font-semibold">
            <Plus className="h-3.5 w-3.5 text-[var(--primary)]" />
            New syllabus
          </h2>
          <div className="grid gap-2">
            <input
              type="text"
              placeholder="Title (e.g. 'Intro to C++ for grade 10')"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={creating}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[13px] outline-none transition focus:border-[var(--primary)]"
            />
            <textarea
              placeholder="Description / audience / scope (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={creating}
              rows={2}
              className="w-full resize-none rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[12.5px] outline-none transition focus:border-[var(--primary)]"
            />
            <div className="flex justify-end">
              <button
                onClick={create}
                disabled={creating || !title.trim()}
                className="inline-flex items-center gap-2 rounded-lg bg-[var(--primary)] px-3.5 py-2 text-[13px] font-semibold text-[var(--primary-foreground)] shadow-[0_8px_24px_-12px_rgba(246,110,96,0.7)] transition hover:translate-y-[-1px] hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {creating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                Create syllabus
              </button>
            </div>
          </div>
        </section>

        {/* List */}
        <section className="rounded-xl border border-[var(--border)] bg-[var(--card)]/85 backdrop-blur">
          <header className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3 text-[12px] font-medium text-[var(--muted-foreground)]">
            <span>Existing syllabuses</span>
            <span>{items.length}</span>
          </header>
          {loading ? (
            <div className="flex items-center justify-center px-4 py-8 text-[12px] text-[var(--muted-foreground)]">
              <Loader2 className="mr-2 h-3 w-3 animate-spin" />
              Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="px-4 py-8 text-center text-[12.5px] text-[var(--muted-foreground)]">
              No syllabuses yet. Create one above to get started.
            </div>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {items.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/manual/${s.id}`}
                    className="flex items-start justify-between gap-3 px-4 py-3 transition hover:bg-[var(--muted)]/10"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">
                        {s.title}
                      </p>
                      {s.description ? (
                        <p className="mt-0.5 line-clamp-2 text-[11.5px] text-[var(--muted-foreground)]">
                          {s.description}
                        </p>
                      ) : null}
                      <p className="mt-1 font-mono text-[10.5px] text-[var(--muted-foreground)]/70">
                        {new Date(s.created_at).toLocaleString()} ·{" "}
                        {s.id.slice(0, 8)}
                      </p>
                    </div>
                    <ArrowRight className="mt-1 h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

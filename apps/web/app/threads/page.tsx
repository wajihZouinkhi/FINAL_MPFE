"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  CircleDashed,
  FlaskConical,
  GraduationCap,
  Hammer,
  ListFilter,
  Loader2,
  PauseCircle,
  Plug,
  Plus,
  Search,
  Sparkles,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import type {
  AgentKind,
  ThreadListCounts,
  ThreadListEntry,
  ThreadListEntryStatus,
  ThreadListResponse,
} from "@mpfe/shared";
import { NewThreadModal } from "../../components/threads/new-thread-modal";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

type TabKind = AgentKind | "all";

const AGENT_LABEL: Record<
  AgentKind,
  { label: string; tone: string; icon: React.ReactNode }
> = {
  "syllabus-generator": {
    label: "Syllabus",
    tone: "border-sky-400/35 bg-sky-400/15 text-sky-300",
    icon: <GraduationCap className="h-2.5 w-2.5" />,
  },
  "activity-generator-tooled": {
    label: "Activity · MCP",
    tone: "border-emerald-400/35 bg-emerald-400/15 text-emerald-300",
    icon: <Plug className="h-2.5 w-2.5" />,
  },
  "activity-generator-toolless": {
    label: "Activity · no tools",
    tone: "border-amber-400/35 bg-amber-400/15 text-amber-300",
    icon: <FlaskConical className="h-2.5 w-2.5" />,
  },
  deepagent: {
    label: "Deep Agent",
    tone: "border-violet-400/35 bg-violet-400/15 text-violet-300",
    icon: <Sparkles className="h-2.5 w-2.5" />,
  },
};

const TAB_ORDER: TabKind[] = [
  "all",
  "syllabus-generator",
  "activity-generator-tooled",
  "activity-generator-toolless",
  "deepagent",
];

const TAB_LABEL: Record<TabKind, string> = {
  all: "All",
  "syllabus-generator": "Syllabus",
  "activity-generator-tooled": "Activity · MCP",
  "activity-generator-toolless": "Activity · no tools",
  deepagent: "Deep Agent",
};

const STATUS_FILTERS: Array<{
  value: ThreadListEntryStatus | "all";
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "interrupted", label: "Asking" },
  { value: "completed", label: "Done" },
  { value: "failed", label: "Failed" },
  { value: "idle", label: "Idle" },
];

const PAGE_SIZE = 30;
const POLL_INTERVAL_MS = 8000;

interface PageState {
  items: ThreadListEntry[];
  next_cursor: string | null;
  loading: boolean;
  error: string | null;
  loadingMore: boolean;
  /**
   * Last ETag we received for this tab's first page. Sent as
   * `If-None-Match` on the next silent poll so the server can short-
   * circuit with a 304 when nothing on the visible page has changed
   * (audit §3.2). Cleared whenever the filter / search inputs change
   * so stale ETags don't suppress a legitimate refresh after the
   * filter narrowed the result set.
   */
  etag: string | null;
}

const EMPTY_PAGE: PageState = {
  items: [],
  next_cursor: null,
  loading: false,
  error: null,
  loadingMore: false,
  etag: null,
};

/**
 * Threads index. Tabs per agent, cursor-paginated, search + status filter.
 * Only the visible tab's first page is fetched by default; switching tabs
 * loads the corresponding page on demand. Polling only hits the visible
 * tab's first page so we don't thrash a user with 500 syllabus builds.
 */
export default function ThreadsIndexPage() {
  const [tab, setTab] = useState<TabKind>("all");
  const [status, setStatus] = useState<ThreadListEntryStatus | "all">("all");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [counts, setCounts] = useState<ThreadListCounts | null>(null);
  const [pages, setPages] = useState<Record<TabKind, PageState>>({
    all: { ...EMPTY_PAGE },
    "syllabus-generator": { ...EMPTY_PAGE },
    "activity-generator-tooled": { ...EMPTY_PAGE },
    "activity-generator-toolless": { ...EMPTY_PAGE },
    deepagent: { ...EMPTY_PAGE },
  });
  const [modalOpen, setModalOpen] = useState(false);

  /**
   * Single AbortController for all in-flight thread fetches. Reset on
   * every filter / tab / search change so stale `fetchNextPage`
   * responses can't race a fresh `fetchFirstPage` and corrupt the
   * list (e.g. appending old-filter rows onto the fresh page or
   * pinning a stale next_cursor). Request-level cancellation also
   * frees up the browser's socket pool faster.
   */
  const fetchController = useRef<AbortController | null>(null);

  /**
   * Build the query string for a given tab + filter combination. Only
   * the `agent`, `status`, `q` (and `cursor` / `limit`) params are ever
   * sent — the server handles pagination semantics.
   */
  const buildUrl = useCallback(
    (opts: { forTab: TabKind; cursor?: string | null }) => {
      const params = new URLSearchParams();
      if (opts.forTab !== "all") params.set("agent", opts.forTab);
      if (status !== "all") params.set("status", status);
      const trimmed = deferredSearch.trim();
      if (trimmed) params.set("q", trimmed);
      if (opts.cursor) params.set("cursor", opts.cursor);
      params.set("limit", String(PAGE_SIZE));
      const qs = params.toString();
      return `${API}/api/threads${qs ? `?${qs}` : ""}`;
    },
    [status, deferredSearch],
  );

  /**
   * Fetch the first page of the given tab. Also refreshes counts — the
   * server returns them on every call.
   */
  const fetchFirstPage = useCallback(
    async (forTab: TabKind, opts: { silent?: boolean } = {}) => {
      // Read the previous ETag synchronously so silent polls can echo
      // it back as `If-None-Match`. A non-silent fetch (initial load,
      // explicit retry) skips the conditional so we always re-render
      // when the user explicitly invokes it.
      let previousEtag: string | null = null;
      setPages((prev) => {
        previousEtag = prev[forTab].etag;
        return {
          ...prev,
          [forTab]: {
            ...prev[forTab],
            loading: !opts.silent,
            error: null,
          },
        };
      });
      const signal = fetchController.current?.signal;
      try {
        const headers: HeadersInit = {};
        if (opts.silent && previousEtag) {
          headers["If-None-Match"] = previousEtag;
        }
        const res = await fetch(buildUrl({ forTab }), {
          cache: "no-store",
          headers,
          signal,
        });
        if (signal?.aborted) return;
        // Audit §3.2 — 304 means the visible first page hasn't
        // changed since the previous poll. Drop straight back to
        // idle (clear the loading flag) without re-rendering or
        // re-setting items / counts.
        if (res.status === 304) {
          setPages((prev) => ({
            ...prev,
            [forTab]: { ...prev[forTab], loading: false, error: null },
          }));
          return;
        }
        if (!res.ok) throw new Error(await res.text());
        const body = (await res.json()) as ThreadListResponse;
        if (signal?.aborted) return;
        const nextEtag = res.headers.get("ETag");
        setPages((prev) => ({
          ...prev,
          [forTab]: {
            items: body.items,
            next_cursor: body.next_cursor,
            loading: false,
            error: null,
            loadingMore: false,
            etag: nextEtag,
          },
        }));
        setCounts(body.counts);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        const message = (err as Error).message ?? "unknown error";
        setPages((prev) => ({
          ...prev,
          [forTab]: { ...prev[forTab], loading: false, error: message },
        }));
        if (!opts.silent) {
          toast.error("Couldn't load threads", { description: message });
        }
      }
    },
    [buildUrl],
  );

  /**
   * Hit the API with `limit=1` just to refresh the per-agent count
   * badges. Used by the silent poll while the user has scrolled past
   * page 1 — we keep the tab counts live without overwriting their
   * accumulated items. Counts are returned on every call so the one
   * row we request is just overhead.
   */
  const refreshCountsOnly = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/threads?limit=1`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const body = (await res.json()) as ThreadListResponse;
      setCounts(body.counts);
    } catch {
      // Silent refresh — failure is not user-visible.
    }
  }, []);

  const fetchNextPage = useCallback(
    async (forTab: TabKind) => {
      const page = pages[forTab];
      if (!page.next_cursor || page.loadingMore) return;
      setPages((prev) => ({
        ...prev,
        [forTab]: { ...prev[forTab], loadingMore: true },
      }));
      const signal = fetchController.current?.signal;
      try {
        const res = await fetch(
          buildUrl({ forTab, cursor: page.next_cursor }),
          { cache: "no-store", signal },
        );
        if (!res.ok) throw new Error(await res.text());
        const body = (await res.json()) as ThreadListResponse;
        if (signal?.aborted) return;
        setPages((prev) => ({
          ...prev,
          [forTab]: {
            items: [...prev[forTab].items, ...body.items],
            next_cursor: body.next_cursor,
            loading: false,
            error: null,
            loadingMore: false,
            // Preserve the first-page ETag — `fetchNextPage` doesn't
            // refresh page 1, so the validator from the last
            // `fetchFirstPage` is still valid for the next silent
            // poll. Spreading `prev[forTab]` would also work, but
            // listing fields explicitly keeps the typed shape
            // self-documenting.
            etag: prev[forTab].etag,
          },
        }));
        setCounts(body.counts);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setPages((prev) => ({
          ...prev,
          [forTab]: { ...prev[forTab], loadingMore: false },
        }));
        toast.error("Couldn't load more", {
          description: (err as Error).message,
        });
      }
    },
    [pages, buildUrl],
  );

  // Reset + fetch whenever filter inputs change. Abort any in-flight
  // request from the previous filter first so its response doesn't
  // race this one and corrupt the list (e.g. stale fetchNextPage
  // append or stale next_cursor).
  useEffect(() => {
    fetchController.current?.abort();
    fetchController.current = new AbortController();
    setPages({
      all: { ...EMPTY_PAGE },
      "syllabus-generator": { ...EMPTY_PAGE },
      "activity-generator-tooled": { ...EMPTY_PAGE },
      "activity-generator-toolless": { ...EMPTY_PAGE },
      deepagent: { ...EMPTY_PAGE },
    });
    fetchFirstPage(tab);
    // Clean up when the component unmounts mid-request.
    return () => {
      fetchController.current?.abort();
    };
  }, [tab, status, deferredSearch, fetchFirstPage]);

  // Silent refresh every POLL_INTERVAL_MS. Refreshes only the active tab
  // and only while the user is still looking at the first page —
  // calling fetchFirstPage here after the user has scrolled further
  // would overwrite the accumulated items from fetchNextPage and the
  // list would visibly shrink mid-scroll. Once the user scrolls past
  // page 1 we stop polling entirely until they hard-refresh. We still
  // refresh the per-agent counts so the tab badges stay live.
  useEffect(() => {
    const id = setInterval(() => {
      const page = pages[tab];
      if (page.loadingMore || page.items.length > PAGE_SIZE) {
        // User has scrolled past the first page; don't overwrite.
        refreshCountsOnly();
        return;
      }
      fetchFirstPage(tab, { silent: true });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [tab, fetchFirstPage, pages, refreshCountsOnly]);

  // Infinite-scroll sentinel. Root is the list scroll container (the
  // <section>) so the observer fires when the sentinel approaches the
  // bottom of the inner scroll viewport, not the document viewport.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const listScrollRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          fetchNextPage(tab);
        }
      },
      { root: listScrollRef.current, rootMargin: "240px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [tab, fetchNextPage, pages]);

  const activePage = pages[tab];
  const showSkeleton = activePage.loading && activePage.items.length === 0;
  const filterActive = status !== "all" || deferredSearch.trim().length > 0;
  const emptyMessage = filterActive
    ? "No threads match the current filters."
    : "No threads yet.";

  return (
    <main className="relative flex h-dvh flex-col overflow-hidden p-4 sm:p-6 md:p-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(900px 480px at 30% 25%, rgba(246,110,96,0.08), transparent 60%), radial-gradient(700px 420px at 75% 75%, rgba(252,175,65,0.06), transparent 60%)",
        }}
      />
      <div className="relative mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
        <header className="mb-4 flex shrink-0 items-center gap-3">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--primary)]/15 ring-1 ring-[var(--primary)]/30">
            <BookOpen className="h-4 w-4 text-[var(--primary)]" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-[1.4rem] font-semibold tracking-tight">
              Your threads
            </h1>
            <p className="mt-0.5 text-[12.5px] text-[var(--muted-foreground)]">
              Pick which agent to run, see live status, and switch between
              syllabus builds and activity worksheets.{" "}
              <Link
                href="/agents"
                className="text-[var(--primary)] underline-offset-2 hover:underline"
              >
                Agent overview →
              </Link>
            </p>
          </div>
          <Link
            href="/manual"
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-[12.5px] font-medium text-[var(--foreground)] transition hover:border-[var(--primary)] hover:text-[var(--primary)]"
            title="Type each unity / activity name yourself, then generate one at a time. Uses indexing for anti-duplication."
          >
            <Hammer className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Manual workspace</span>
          </Link>
          <button
            onClick={() => setModalOpen(true)}
            className="group inline-flex items-center gap-2 rounded-lg bg-[var(--primary)] px-3.5 py-2 text-[13px] font-semibold text-[var(--primary-foreground)] shadow-[0_8px_24px_-12px_rgba(246,110,96,0.7)] transition hover:translate-y-[-1px] hover:opacity-95 sm:px-3.5"
          >
            <Plus className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">New thread</span>
          </button>
        </header>

        <Tabs tab={tab} counts={counts} onChange={setTab} />

        <FilterBar
          status={status}
          onStatusChange={setStatus}
          search={search}
          onSearchChange={setSearch}
        />

        <section
          ref={listScrollRef}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--card)]/85 backdrop-blur"
        >
          {showSkeleton ? (
            <SkeletonList />
          ) : activePage.error ? (
            <ErrorState message={activePage.error} onRetry={() => fetchFirstPage(tab)} />
          ) : activePage.items.length === 0 ? (
            filterActive ? (
              <FilterEmptyState message={emptyMessage} onReset={() => { setStatus("all"); setSearch(""); }} />
            ) : (
              <EmptyState onCreate={() => setModalOpen(true)} />
            )
          ) : (
            <>
              <ul className="divide-y divide-[var(--border)]">
                {activePage.items.map((t) => (
                  <ThreadRow key={t.id} entry={t} showAgent={tab === "all"} />
                ))}
              </ul>
              <div ref={sentinelRef} className="h-px w-full" />
              {activePage.loadingMore ? (
                <div className="flex items-center justify-center px-6 py-4 text-[11.5px] text-[var(--muted-foreground)]">
                  <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                  Loading more…
                </div>
              ) : activePage.next_cursor ? (
                <button
                  onClick={() => fetchNextPage(tab)}
                  className="flex w-full items-center justify-center gap-2 border-t border-[var(--border)] bg-[var(--muted)]/10 px-4 py-2 text-[11.5px] font-medium text-[var(--muted-foreground)] transition hover:bg-[var(--muted)]/30 hover:text-[var(--foreground)]"
                >
                  Load more
                </button>
              ) : activePage.items.length > PAGE_SIZE ? (
                <div className="px-4 py-3 text-center text-[11px] text-[var(--muted-foreground)]">
                  End of list.
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>
      <NewThreadModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </main>
  );
}

function Tabs({
  tab,
  counts,
  onChange,
}: {
  tab: TabKind;
  counts: ThreadListCounts | null;
  onChange: (t: TabKind) => void;
}) {
  const totalAll = useMemo(() => {
    if (!counts) return null;
    return Object.values(counts).reduce((a, b) => a + b, 0);
  }, [counts]);
  return (
    <div
      className="mb-3 flex gap-1 overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--card)]/60 p-1 backdrop-blur"
      role="tablist"
    >
      {TAB_ORDER.map((t) => {
        const active = tab === t;
        const count =
          t === "all"
            ? totalAll
            : counts
              ? counts[t]
              : null;
        return (
          <button
            key={t}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t)}
            className={
              "flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition " +
              (active
                ? "bg-[var(--primary)]/15 text-[var(--primary)] ring-1 ring-[var(--primary)]/30"
                : "text-[var(--muted-foreground)] hover:bg-[var(--muted)]/30 hover:text-[var(--foreground)]")
            }
          >
            {t !== "all" ? <AgentMiniBadge kind={t} /> : null}
            <span>{TAB_LABEL[t]}</span>
            <span
              className={
                "font-mono text-[10.5px] " +
                (active ? "text-[var(--primary)]" : "text-[var(--muted-foreground)]")
              }
            >
              {count ?? "…"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function FilterBar({
  status,
  onStatusChange,
  search,
  onSearchChange,
}: {
  status: ThreadListEntryStatus | "all";
  onStatusChange: (s: ThreadListEntryStatus | "all") => void;
  search: string;
  onSearchChange: (s: string) => void;
}) {
  return (
    <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
      <div className="relative flex-1">
        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted-foreground)]" />
        <input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search titles or prompts…"
          aria-label="Search threads"
          className="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--card)]/80 pl-8 pr-3 text-[12.5px] text-[var(--foreground)] outline-none backdrop-blur transition placeholder:text-[var(--muted-foreground)]/60 focus:border-[var(--primary)]/50 focus:ring-2 focus:ring-[var(--primary)]/20"
        />
      </div>
      <div className="flex items-center gap-2">
        <ListFilter className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
        <div
          className="flex gap-1 overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--card)]/60 p-0.5 backdrop-blur"
          role="radiogroup"
          aria-label="Status filter"
        >
          {STATUS_FILTERS.map((f) => {
            const active = status === f.value;
            return (
              <button
                key={f.value}
                role="radio"
                aria-checked={active}
                onClick={() => onStatusChange(f.value)}
                className={
                  "shrink-0 rounded-md px-2 py-1 text-[11.5px] font-medium transition " +
                  (active
                    ? "bg-[var(--primary)]/15 text-[var(--primary)]"
                    : "text-[var(--muted-foreground)] hover:bg-[var(--muted)]/30 hover:text-[var(--foreground)]")
                }
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ThreadRow({
  entry,
  showAgent,
}: {
  entry: ThreadListEntry;
  showAgent: boolean;
}) {
  const title =
    entry.title?.trim() ||
    entry.last_user_message?.slice(0, 80) ||
    `Untitled thread`;
  const subtitle = entry.last_run_at
    ? formatRelative(new Date(entry.last_run_at))
    : `Created ${formatRelative(new Date(entry.created_at))}`;
  return (
    <li>
      <Link
        href={`/threads/${entry.id}`}
        prefetch={false}
        className="group flex items-center gap-3 px-4 py-3 transition hover:bg-[var(--muted)]/30 focus:bg-[var(--muted)]/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--primary)]/40"
      >
        <StatusBadge status={entry.status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="truncate text-[13.5px] font-medium text-[var(--foreground)]">
              {title}
            </div>
            {showAgent ? (
              <AgentMiniBadge kind={entry.agent} />
            ) : null}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-[var(--muted-foreground)]">
            <span className="font-mono">{entry.id.slice(0, 8)}</span>
            <span aria-hidden>•</span>
            <span>{subtitle}</span>
            {entry.bound_syllabus_thread_id ? (
              <>
                <span aria-hidden>•</span>
                <span className="font-mono">
                  bound → {entry.bound_syllabus_thread_id.slice(0, 8)}
                </span>
              </>
            ) : null}
            {entry.last_run_error ? (
              <>
                <span aria-hidden>•</span>
                <span
                  className="max-w-[260px] truncate text-[var(--destructive)]"
                  title={entry.last_run_error}
                >
                  {entry.last_run_error}
                </span>
              </>
            ) : null}
          </div>
        </div>
        <ArrowRight className="hidden h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)] transition group-hover:translate-x-0.5 group-hover:text-[var(--primary)] sm:block" />
      </Link>
    </li>
  );
}

function AgentMiniBadge({ kind }: { kind: AgentKind }) {
  const cfg = AGENT_LABEL[kind];
  return (
    <span
      className={
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider " +
        cfg.tone
      }
    >
      {cfg.icon}
      {cfg.label}
    </span>
  );
}

function StatusBadge({ status }: { status: ThreadListEntryStatus }) {
  const cfg: Record<
    ThreadListEntryStatus,
    { label: string; icon: React.ReactNode; cls: string }
  > = {
    running: {
      label: "Running",
      icon: <Loader2 className="h-3 w-3 animate-spin" />,
      cls: "border-sky-400/40 bg-sky-400/15 text-sky-300",
    },
    interrupted: {
      label: "Asking",
      icon: <PauseCircle className="h-3 w-3" />,
      cls: "border-[var(--secondary)]/45 bg-[var(--secondary)]/15 text-[var(--secondary)]",
    },
    completed: {
      label: "Done",
      icon: <CheckCircle2 className="h-3 w-3" />,
      cls: "border-emerald-400/40 bg-emerald-400/15 text-emerald-300",
    },
    failed: {
      label: "Failed",
      icon: <XCircle className="h-3 w-3" />,
      cls: "border-[var(--destructive)]/50 bg-[var(--destructive)]/15 text-[var(--destructive)]",
    },
    idle: {
      label: "Idle",
      icon: <CircleDashed className="h-3 w-3" />,
      cls: "border-[var(--border)] bg-[var(--muted)]/40 text-[var(--muted-foreground)]",
    },
  };
  const c = cfg[status];
  return (
    <span
      className={
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider " +
        c.cls
      }
    >
      {c.icon}
      {c.label}
    </span>
  );
}

function SkeletonList() {
  return (
    <ul className="divide-y divide-[var(--border)]">
      {Array.from({ length: 5 }).map((_, i) => (
        <li key={i} className="flex items-center gap-3 px-4 py-3">
          <div className="h-4 w-14 animate-pulse rounded-full bg-[var(--muted)]/30" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-2/3 animate-pulse rounded bg-[var(--muted)]/30" />
            <div className="h-2.5 w-1/3 animate-pulse rounded bg-[var(--muted)]/20" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="px-6 py-12 text-center">
      <div className="mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-[var(--secondary)]/15 ring-1 ring-[var(--secondary)]/30">
        <Sparkles className="h-4 w-4 text-[var(--secondary)]" />
      </div>
      <p className="text-[13.5px] font-medium">No threads yet.</p>
      <p className="mx-auto mt-1 max-w-md text-[12px] text-[var(--muted-foreground)]">
        Start a syllabus, or jump straight into an activity generator. The
        agent picker walks you through the choice.
      </p>
      <button
        onClick={onCreate}
        className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[var(--primary)] px-3.5 py-2 text-[13px] font-semibold text-[var(--primary-foreground)] shadow-[0_8px_24px_-12px_rgba(246,110,96,0.7)] transition hover:opacity-95"
      >
        <Plus className="h-3.5 w-3.5" />
        Start your first thread
      </button>
    </div>
  );
}

function FilterEmptyState({
  message,
  onReset,
}: {
  message: string;
  onReset: () => void;
}) {
  return (
    <div className="px-6 py-10 text-center">
      <p className="text-[13px] font-medium">{message}</p>
      <button
        onClick={onReset}
        className="mt-3 inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--muted)]/20 px-2.5 py-1 text-[11.5px] font-medium text-[var(--foreground)] transition hover:bg-[var(--muted)]/40"
      >
        Clear filters
      </button>
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="px-6 py-10 text-center">
      <p className="text-[13px] font-medium text-[var(--destructive)]">
        Couldn't load threads
      </p>
      <p className="mx-auto mt-1 max-w-md truncate text-[11.5px] text-[var(--muted-foreground)]" title={message}>
        {message}
      </p>
      <button
        onClick={onRetry}
        className="mt-3 inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--muted)]/20 px-2.5 py-1 text-[11.5px] font-medium text-[var(--foreground)] transition hover:bg-[var(--muted)]/40"
      >
        Retry
      </button>
    </div>
  );
}

/** Relative-time formatter sized for "just now / 5m / 2h / 3d" rendering. */
function formatRelative(d: Date): string {
  const ms = Date.now() - d.getTime();
  if (ms < 0) return d.toLocaleString();
  const sec = Math.floor(ms / 1000);
  if (sec < 30) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `${day}d ago`;
  return d.toLocaleDateString();
}

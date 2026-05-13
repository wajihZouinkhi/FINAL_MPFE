"use client";

import { useEffect, useRef, useState } from "react";
import {
  createClient,
  RealtimeChannel,
  type SupabaseClient,
} from "@supabase/supabase-js";
import type {
  ChapterRow,
  LessonRow,
  SyllabusRow,
  SyllabusSnapshot,
} from "@mpfe/shared";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

/**
 * Singleton Supabase client. Creating one per useEffect leaks websocket
 * resources whenever the user navigates between threads — re-using the
 * same client and just swapping channels is the supported pattern.
 */
let _client: SupabaseClient | null = null;
export function getSupabaseClient(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_ANON) return null;
  if (!_client) _client = createClient(SUPABASE_URL, SUPABASE_ANON);
  return _client;
}
// Local alias kept so the existing call sites below don't churn.
const getClient = getSupabaseClient;

/**
 * Subscribes to syllabus / chapter / lesson changes for ONE thread.
 * Filters are applied server-side so the client only receives rows that
 * matter; the client never sees other threads' artifacts at all.
 *
 * The committer's UPSERTs trigger Postgres changes; supabase Realtime
 * pushes them here, and we mutate local snapshot state in-place — no
 * extra HTTP fetches needed.
 *
 * DELETE handling depends on `REPLICA IDENTITY FULL` on syllabuses /
 * chapters / lessons (migration `0002_replica_identity_full.sql`) so the
 * full row is sent in `payload.old`, including FK columns.
 */
export function useSyllabusRealtime(
  threadId: string,
  initial: SyllabusSnapshot | null,
): SyllabusSnapshot | null {
  const [snap, setSnap] = useState<SyllabusSnapshot | null>(initial);
  const snapRef = useRef(snap);
  snapRef.current = snap;

  useEffect(() => {
    setSnap(initial);
  }, [initial]);

  useEffect(() => {
    const client = getClient();
    if (!client) return;

    // Lessons need to filter by chapter_id, but we don't know the chapter
    // ids until syllabus + chapters arrive. Subscribe in two phases:
    //  - phase A (always-on): syllabus + chapters for this thread
    //  - phase B (rebuilt when chapter ids change): lessons for those chapter ids
    const phaseA: RealtimeChannel = client
      .channel(`thread:${threadId}:scaffold`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "syllabuses",
          filter: `thread_id=eq.${threadId}`,
        },
        (payload) => {
          const row = (
            payload.eventType === "DELETE" ? payload.old : payload.new
          ) as SyllabusRow | undefined;
          if (!row) return;
          setSnap((prev) =>
            applySyllabus(prev, threadId, payload.eventType, row),
          );
        },
      )
      .subscribe();

    return () => {
      client.removeChannel(phaseA);
    };
  }, [threadId]);

  // Phase B+C: chapter + lesson channels keyed off the current syllabus_id.
  //
  // The committer upserts syllabus → chapters → lessons in quick succession.
  // Because `syllabusId` only becomes truthy AFTER the syllabus Realtime
  // event has hit React state, the chapter / lesson channels may subscribe
  // *after* their Realtime events were already published — those events
  // would then be silently dropped. To avoid the race we subscribe FIRST,
  // then immediately backfill via REST (chapters → then lessons, so the
  // lesson reducer always finds its parent chapter in snap). Any duplicate
  // events delivered through both paths are de-duped by the upsert
  // semantics of `applyChapter` / `applyLesson`.
  const syllabusId = snap?.syllabus?.id ?? null;
  useEffect(() => {
    const client = getClient();
    if (!client || !syllabusId) return;
    let cancelled = false;

    const chanCh: RealtimeChannel = client
      .channel(`thread:${threadId}:chapters:${syllabusId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "chapters",
          filter: `syllabus_id=eq.${syllabusId}`,
        },
        (payload) => {
          const row = (
            payload.eventType === "DELETE" ? payload.old : payload.new
          ) as ChapterRow | undefined;
          if (!row) return;
          setSnap((prev) => applyChapter(prev, payload.eventType, row));
        },
      )
      .subscribe();

    // Lessons can't be pre-filtered by `chapter_id IN (...)` server-side
    // (Realtime supports only single-equality filters), so we subscribe to
    // every lesson change for this Realtime client and discard rows whose
    // chapter isn't known locally.
    const chanLe: RealtimeChannel = client
      .channel(`thread:${threadId}:lessons:${syllabusId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lessons" },
        (payload) => {
          const row = (
            payload.eventType === "DELETE" ? payload.old : payload.new
          ) as LessonRow | undefined;
          if (!row) return;
          const cur = snapRef.current;
          if (!cur?.chapters.some((c) => c.id === row.chapter_id)) return;
          setSnap((prev) => applyLesson(prev, payload.eventType, row));
        },
      )
      .subscribe();

    // Sequential backfill: chapters first, then lessons under those
    // chapters. Order matters because applyLesson skips rows whose parent
    // chapter isn't in snap.
    void (async () => {
      const { data: chapters, error: chErr } = await client
        .from("chapters")
        .select("*")
        .eq("syllabus_id", syllabusId);
      if (cancelled || chErr || !Array.isArray(chapters)) return;
      if (chapters.length > 0) {
        setSnap((prev) => {
          let next = prev;
          for (const row of chapters as ChapterRow[]) {
            next = applyChapter(next, "INSERT", row);
          }
          return next;
        });
      }
      const chapterIds = (chapters as ChapterRow[]).map((c) => c.id);
      if (chapterIds.length === 0) return;
      const { data: lessons, error: leErr } = await client
        .from("lessons")
        .select("*")
        .in("chapter_id", chapterIds);
      if (cancelled || leErr || !Array.isArray(lessons)) return;
      if (lessons.length > 0) {
        setSnap((prev) => {
          let next = prev;
          for (const row of lessons as LessonRow[]) {
            next = applyLesson(next, "INSERT", row);
          }
          return next;
        });
      }
    })();

    return () => {
      cancelled = true;
      client.removeChannel(chanCh);
      client.removeChannel(chanLe);
    };
  }, [threadId, syllabusId]);

  return snap;
}

function applySyllabus(
  prev: SyllabusSnapshot | null,
  threadId: string,
  ev: string,
  row: SyllabusRow | undefined,
): SyllabusSnapshot | null {
  if (!row) return prev;
  if (ev === "DELETE") {
    return prev ? { ...prev, syllabus: null, chapters: [] } : prev;
  }
  return {
    thread_id: threadId,
    syllabus: row,
    chapters: prev?.chapters ?? [],
  };
}

function applyChapter(
  prev: SyllabusSnapshot | null,
  ev: string,
  row: ChapterRow | undefined,
): SyllabusSnapshot | null {
  if (!prev || !row) return prev;
  if (prev.syllabus && row.syllabus_id !== prev.syllabus.id) return prev;
  if (ev === "DELETE") {
    return {
      ...prev,
      chapters: prev.chapters.filter((c) => c.id !== row.id),
    };
  }
  const idx = prev.chapters.findIndex((c) => c.id === row.id);
  const merged =
    idx >= 0
      ? prev.chapters.map((c) =>
          c.id === row.id ? { ...c, ...row, lessons: c.lessons } : c,
        )
      : [...prev.chapters, { ...row, lessons: [] }];
  merged.sort((a, b) => a.order_index - b.order_index);
  return { ...prev, chapters: merged };
}

function applyLesson(
  prev: SyllabusSnapshot | null,
  ev: string,
  row: LessonRow | undefined,
): SyllabusSnapshot | null {
  if (!prev || !row) return prev;
  return {
    ...prev,
    chapters: prev.chapters.map((c) => {
      if (c.id !== row.chapter_id) return c;
      if (ev === "DELETE") {
        return { ...c, lessons: c.lessons.filter((l) => l.id !== row.id) };
      }
      const idx = c.lessons.findIndex((l) => l.id === row.id);
      const lessons =
        idx >= 0
          ? c.lessons.map((l) => (l.id === row.id ? { ...l, ...row } : l))
          : [...c.lessons, row];
      lessons.sort((a, b) => a.order_index - b.order_index);
      return { ...c, lessons };
    }),
  };
}

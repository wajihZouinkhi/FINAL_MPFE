-- ============================================================
-- 0012_lesson_depends_on.sql — Structured lesson-to-lesson dependencies.
--
-- Adds a `depends_on` column to `lessons` carrying the UUIDs of earlier
-- lessons whose accepted bodies the row builds on. This is the
-- machine-readable companion to the free-text `prerequisites` array
-- (which still drives the lesson body's "Prerequisites" section); the
-- new column is what the writer reads at write time to splice the
-- referenced lessons' bodies into its prompt, what the critic reads
-- when checking dependency coherence, and what the FE Viewer reads
-- to render "Depends on …" chips that link back to the dep lessons.
--
-- The supervisor produces deps as 1-indexed (chapter, lesson) refs
-- in its decision payload; `SupervisorNode.buildPlan` resolves them
-- to UUIDs once chapter/lesson IDs are allocated, dropping any refs
-- that don't resolve OR that point at the current/later lesson in
-- reading order. The earlier-only rule keeps the resulting graph
-- acyclic by construction so a dependent lesson's writer can always
-- read its prereqs' committed bodies before it runs.
--
-- Default empty array — pre-PR rows that pre-date the feature read
-- back as []. The shared `LessonRow` schema treats `depends_on` as
-- optional + defaulted, so older clients that haven't picked up the
-- new field also keep working.
--
-- Idempotent: safe to re-run.
-- ============================================================

alter table lessons
  add column if not exists depends_on jsonb not null default '[]'::jsonb;

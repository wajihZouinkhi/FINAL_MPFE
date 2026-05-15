-- ============================================================
-- 0014_extend_activities_for_unities.sql — Merge cours + worksheet into one row.
--
-- Part of the Syllabus -> Unity -> Activity refactor.
--
-- Target entity model:
--
--   Syllabus -> Unity -> Activity  (cours markdown + worksheet jsonb)
--
-- This migration extends the existing `activities` table so a single
-- row carries everything for one teachable unit (the previous shape
-- had `lessons` for the cours and `activities` for the worksheet).
-- The legacy `lessons` table is intentionally **kept as-is** for one
-- release so the legacy /api/chat flow keeps working; a follow-up
-- migration will drop it once the new shape is verified end-to-end.
--
-- New columns on `activities`:
--   unity_id              uuid references unities(id) on delete cascade
--   title                 text
--   order_index           int  default 0
--   body                  text default ''  -- markdown cours body
--   worksheet             jsonb default '{}'::jsonb
--                              (mirrors the old `content` column shape;
--                               write paths populate both during the
--                               transition window)
--   learning_objectives   jsonb default '[]'::jsonb
--   prerequisites         jsonb default '[]'::jsonb
--   key_terms             jsonb default '[]'::jsonb
--   worked_example_seed   text
--   assessment_idea       text
--   duration_min          int
--   bloom_level           text
--   review_required       boolean default false
--   block_issues          jsonb default '[]'::jsonb
--   critic_issues         jsonb default '[]'::jsonb
--   depends_on            jsonb default '[]'::jsonb
--   review_cleared_at     timestamptz
--
-- We deliberately add `body` rather than renaming the existing
-- `content` column (which is jsonb holding the legacy worksheet
-- shape). The new write path populates `worksheet` AND keeps `content`
-- in sync for the transition window so legacy readers don't break.
-- A follow-up migration will drop `content` and `lesson_id` after the
-- new shape is fully cut over.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ─── unity_id + new metadata columns ───────────────────────
alter table public.activities
  add column if not exists unity_id            uuid references public.unities(id) on delete cascade,
  add column if not exists title               text,
  add column if not exists order_index         int  default 0,
  add column if not exists body                text default '',
  add column if not exists worksheet           jsonb default '{}'::jsonb,
  add column if not exists learning_objectives jsonb default '[]'::jsonb,
  add column if not exists prerequisites       jsonb default '[]'::jsonb,
  add column if not exists key_terms           jsonb default '[]'::jsonb,
  add column if not exists worked_example_seed text,
  add column if not exists assessment_idea     text,
  add column if not exists duration_min        int,
  add column if not exists bloom_level         text,
  add column if not exists review_required     boolean not null default false,
  add column if not exists block_issues        jsonb default '[]'::jsonb,
  add column if not exists critic_issues       jsonb default '[]'::jsonb,
  add column if not exists depends_on          jsonb not null default '[]'::jsonb,
  add column if not exists review_cleared_at   timestamptz;

-- ─── indexes ───────────────────────────────────────────────
create index if not exists activities_unity_id_order_idx
  on public.activities(unity_id, order_index);

create index if not exists activities_review_required_idx
  on public.activities(unity_id)
  where review_required = true;

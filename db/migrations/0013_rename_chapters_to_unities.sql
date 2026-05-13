-- ============================================================
-- 0013_rename_chapters_to_unities.sql — Rename chapters -> unities.
--
-- Part of the Syllabus -> Unity -> Activity refactor.
--
-- Renames the `chapters` table (and its updated_at trigger / indexes)
-- to `unities`. The plain ALTER TABLE ... RENAME operation transfers
-- all foreign keys (lessons.chapter_id, etc.) automatically because
-- Postgres FKs reference the target by OID, not by name. The legacy
-- `lessons.chapter_id` column name is **intentionally preserved** so
-- the legacy /api/chat code path keeps working against the renamed
-- table without further changes; only callers that hit the table by
-- name (`.from("chapters")`) need to switch to `unities`.
--
-- Realtime publication: `supabase_realtime` tracks tables by OID, so
-- after the rename the publication automatically publishes the
-- renamed `unities` table. We also defensively ensure membership.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ─── rename table ──────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'chapters')
     and not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'unities') then
    alter table public.chapters rename to unities;
  end if;
end$$;

-- ─── rename indexes ────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'chapters_syllabus_id_order_idx')
     and not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'unities_syllabus_id_order_idx') then
    alter index public.chapters_syllabus_id_order_idx rename to unities_syllabus_id_order_idx;
  end if;
end$$;

-- ─── rename updated_at trigger ─────────────────────────────
do $$
begin
  if exists (
    select 1 from pg_trigger
    where tgname = 'trg_chapters_updated_at'
      and tgrelid = 'public.unities'::regclass
  ) then
    alter trigger trg_chapters_updated_at on public.unities rename to trg_unities_updated_at;
  end if;
end$$;

-- ─── realtime publication membership ───────────────────────
-- The publication tracks tables by OID so the rename is transparent.
-- We defensively re-add `unities` in case the original publication was
-- created before the rename on a fresh setup.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'unities'
  ) then
    alter publication supabase_realtime add table public.unities;
  end if;
exception
  when undefined_object then
    -- supabase_realtime publication not present (non-Supabase env).
    null;
end$$;

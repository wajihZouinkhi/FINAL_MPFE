-- ============================================================
-- 0016_legacy_chapters_view.sql — Back-compat `chapters` view.
--
-- Part of the Syllabus -> Unity -> Activity refactor.
--
-- Migration 0013 renamed `public.chapters` to `public.unities`. The
-- legacy api code path (`apps/api/src/threads/threads.service.ts`
-- and similar) reads the table by name via PostgREST
-- (`.from("chapters").select(...)`), so after the rename those reads
-- 404 with PGRST205. This migration creates a read-only view
-- `public.chapters` that aliases `public.unities` so the legacy
-- /api/chat + /threads/:id/snapshot flow keeps working through the
-- transition window. A follow-up migration will drop this view once
-- all callers have been moved to query `unities` directly.
--
-- Writes against the view (INSERT / UPDATE / DELETE) would require
-- an INSTEAD OF trigger — we deliberately do NOT install one because
-- the only writers to the legacy table are the MCP tools, which have
-- already been switched to `unities` in 0013's companion code refactor.
-- The view is therefore read-only by design.
--
-- Idempotent: safe to re-run.
-- ============================================================

do $$
begin
  -- Only create the view if `unities` exists AND a real `chapters`
  -- table does NOT exist (so we don't clobber a fresh install that
  -- hasn't run 0013 yet).
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'unities')
     and not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'chapters') then
    create or replace view public.chapters as
      select id, syllabus_id, title, order_index, outcomes, prerequisites,
             created_at, updated_at
      from public.unities;
  end if;
end$$;

-- Grant the same access as the underlying table so PostgREST's
-- anonymous + authenticated roles can SELECT through the view.
do $$
begin
  if exists (select 1 from pg_views where schemaname = 'public' and viewname = 'chapters') then
    grant select on public.chapters to anon, authenticated, service_role;
  end if;
exception
  when undefined_object then
    -- Supabase default roles aren't present (non-Supabase env).
    null;
end$$;

-- ============================================================
-- 0009_lesson_critic_issues.sql — structured critic output on lessons.
--
-- Adds a single jsonb column to `lessons` carrying the full critic v2
-- output from the final cycle of the writer/critic loop (severity +
-- category + detail per issue). This is parallel to the existing
-- `block_issues` text array — that one was added in 0005 and only
-- holds formatted block-severity strings, which means warn/nit
-- observations the critic surfaced while still passing the draft
-- were dropped on the floor. Audit §2.7 calls this out: a force-passed
-- lesson "ships with known critic objections" but the FE has no way
-- to render the structured findings.
--
-- Column shape:
--   critic_issues jsonb default '[]'
--     Array of { severity: 'block'|'warn'|'nit',
--                category: 'lo_alignment'|'grounding'|'language'|
--                          'pedagogy'|'structure'|'duplication'|
--                          'wording'|'leakage'|'other',
--                detail:   text }
--
-- Realtime publication (audit §5.4): the `lessons` table is already
-- in the `supabase_realtime` publication (added in 0004), so any
-- UPDATE that touches `critic_issues` is broadcast to subscribers
-- automatically. No publication change needed — we re-add the table
-- defensively so this migration is self-contained on a fresh install.
--
-- Idempotent: safe to re-run.
-- ============================================================

alter table lessons
  add column if not exists critic_issues jsonb default '[]'::jsonb;

-- Defensive — same as 0004; skipped silently if already published.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'lessons'
  ) then
    alter publication supabase_realtime add table public.lessons;
  end if;
exception
  when undefined_object then
    -- supabase_realtime publication not created yet (e.g. on a non-
    -- Supabase environment); nothing to add to. Skip.
    null;
end$$;

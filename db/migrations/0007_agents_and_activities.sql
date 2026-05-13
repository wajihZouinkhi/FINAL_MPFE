-- ============================================================
-- 0007_agents_and_activities.sql — Multi-agent threads + activities.
--
-- Adds the columns and tables needed for the second + third agents in
-- the project: activity-generator-tooled (binds to an existing syllabus
-- thread; calls a Python MCP server for lesson context) and
-- activity-generator-toolless (no syllabus, no tools, just a topic).
--
-- This is the smallest schema change that lets a single thread carry
-- exactly one agent's history end-to-end without touching the existing
-- syllabus-generator data path.
--
--   threads:
--     agent  text  not null  default 'syllabus-generator'
--       -- Which LangGraph the API runs for this thread. The
--       -- application-layer registry maps this string to a compiled
--       -- graph; the FE uses it to pick the right thread renderer.
--       -- Existing rows backfill to 'syllabus-generator', which is the
--       -- only agent that existed before this migration.
--     bound_syllabus_thread_id  uuid  references threads(id) on delete set null
--       -- For activity-generator-tooled threads ONLY: the syllabus
--       -- thread whose chapters/lessons the activity agent operates
--       -- against. on delete set null because deleting the source
--       -- syllabus thread shouldn't cascade-nuke the activity history;
--       -- the activity rows already carry their own (denormalized)
--       -- lesson_title fallback.
--
--   activities  (already exists from 0001_init.sql, currently unused):
--     thread_id     uuid  references threads(id) on delete cascade
--       -- The activity-generator thread this card belongs to. Required
--       -- for new rows; nullable for the (currently zero) historical rows.
--     kind          text  not null default 'worksheet'
--       -- Discriminator for content shape. v1 emits 'worksheet' only;
--       -- future kinds (quiz, flashcards) drop in without a migration.
--     prompt        text  not null default ''
--       -- The user's request that produced this activity (for display).
--     lesson_title  text  not null default ''
--       -- Denormalized title of the lesson the activity targets, so
--       -- the FE can render a card label even after the source lesson
--       -- is deleted from the syllabus thread.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ─── threads.agent + bound_syllabus_thread_id ───────────────
alter table threads
  add column if not exists agent text not null default 'syllabus-generator',
  add column if not exists bound_syllabus_thread_id uuid
    references threads(id) on delete set null;

create index if not exists threads_agent_idx on threads(agent);
create index if not exists threads_bound_syllabus_thread_id_idx
  on threads(bound_syllabus_thread_id);

-- Application-layer guard: enforce that bound_syllabus_thread_id is only
-- set on activity-generator-tooled threads. This prevents accidentally
-- binding a syllabus-generator thread to another syllabus, which would
-- have no semantics.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'threads_bound_syllabus_only_for_tooled_chk'
  ) then
    alter table threads
      add constraint threads_bound_syllabus_only_for_tooled_chk
      check (
        bound_syllabus_thread_id is null
        or agent = 'activity-generator-tooled'
      );
  end if;
end$$;

-- ─── activities.thread_id + kind + prompt + lesson_title ────
alter table activities
  add column if not exists thread_id uuid
    references threads(id) on delete cascade,
  add column if not exists kind text not null default 'worksheet',
  add column if not exists prompt text not null default '',
  add column if not exists lesson_title text not null default '';

create index if not exists activities_thread_id_created_at_idx
  on activities(thread_id, created_at desc);

-- ─── Realtime publication ───────────────────────────────────
-- Surface activity inserts to the FE the same way committed lessons
-- already are. Idempotent — supabase_realtime is created in 0001.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'activities'
  ) then
    alter publication supabase_realtime add table activities;
  end if;
end$$;

alter table activities replica identity full;

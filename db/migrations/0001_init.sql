-- ============================================================
-- 0001_init.sql — Initial schema for FINAL_MPFE.
-- Idempotent: safe to re-run.
-- Scope (MVP): no auth / no user_id / no version history.
-- One thread = one syllabus enforced at the application layer,
-- but the schema allows many syllabuses per thread to keep
-- options open without schema changes later.
-- ============================================================

create extension if not exists "uuid-ossp";

-- ─── threads ────────────────────────────────────────────────
create table if not exists threads (
  id          uuid primary key default uuid_generate_v4(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ─── syllabuses ─────────────────────────────────────────────
create table if not exists syllabuses (
  id          uuid primary key default uuid_generate_v4(),
  thread_id   uuid not null references threads(id) on delete cascade,
  title       text not null default '',
  description text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists syllabuses_thread_id_idx on syllabuses(thread_id);

-- ─── chapters ───────────────────────────────────────────────
create table if not exists chapters (
  id           uuid primary key default uuid_generate_v4(),
  syllabus_id  uuid not null references syllabuses(id) on delete cascade,
  title        text not null,
  order_index  integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists chapters_syllabus_id_order_idx
  on chapters(syllabus_id, order_index);

-- ─── lessons ────────────────────────────────────────────────
create table if not exists lessons (
  id           uuid primary key default uuid_generate_v4(),
  chapter_id   uuid not null references chapters(id) on delete cascade,
  title        text not null,
  content      text not null default '',
  order_index  integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists lessons_chapter_id_order_idx
  on lessons(chapter_id, order_index);

-- ─── activities ─────────────────────────────────────────────
-- Out of scope for v1 but the table is created so the schema is
-- stable. No code writes to it yet.
create table if not exists activities (
  id          uuid primary key default uuid_generate_v4(),
  lesson_id   uuid references lessons(id) on delete cascade,
  content     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists activities_lesson_id_idx on activities(lesson_id);

-- ─── updated_at trigger ─────────────────────────────────────
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

do $$
declare
  t text;
begin
  for t in select unnest(array['threads','syllabuses','chapters','lessons','activities'])
  loop
    execute format(
      'drop trigger if exists trg_%I_updated_at on %I;
       create trigger trg_%I_updated_at
       before update on %I
       for each row execute function set_updated_at();',
      t, t, t, t
    );
  end loop;
end$$;

-- ─── Realtime publication ───────────────────────────────────
-- Push committed syllabus-tree changes to the frontend.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end$$;

-- ADD TABLE is not idempotent on its own (Postgres raises if the table is
-- already a member). Guard each one against pg_publication_tables so the
-- migration is safe to re-run.
do $$
declare
  t text;
begin
  for t in select unnest(array['syllabuses','chapters','lessons'])
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
end$$;

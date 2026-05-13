-- ============================================================
-- 0003_agent_runs_events.sql — Resumable streams Phase 0.
--
-- Adds the durable backbone for resumable agent streams (see
-- design-pr13-resumable-streams.md):
--
--   agent_runs   = one row per "go" of the supervisor (queued →
--                  running → completed/failed/paused). Lets the
--                  worker recover crashed runs and the FE list a
--                  thread's history.
--   agent_events = monotonic event log. Every typed slice change
--                  the supervisor emits gets a row here. The
--                  primary-key id is the *global cursor* clients
--                  use to replay-from-cursor on reconnect.
--
-- Phase 0 wires the existing in-request streamer to mirror its
-- emits into agent_events (shadow mode). Phase 1 will flip the
-- FE to read from the log; Phase 2 will move execution out of
-- the HTTP request entirely. Schema is forward-compatible with
-- both.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ─── agent_runs ─────────────────────────────────────────────
create table if not exists agent_runs (
  id              uuid primary key default uuid_generate_v4(),
  thread_id       uuid not null references threads(id) on delete cascade,
  status          text not null
                    check (status in ('queued','running','paused','completed','failed')),
  user_message    text not null,
  started_at      timestamptz,
  finished_at     timestamptz,
  last_heartbeat  timestamptz,
  error           text,
  created_at      timestamptz not null default now()
);

create index if not exists agent_runs_thread_id_started_idx
  on agent_runs(thread_id, started_at desc);

-- Used by the stale-run reaper in RunWorker.
create index if not exists agent_runs_running_heartbeat_idx
  on agent_runs(status, last_heartbeat)
  where status = 'running';

-- ─── agent_events ───────────────────────────────────────────
-- `id` is BIGSERIAL — the monotonic global cursor. Clients
-- persist it in localStorage and send it back as ?cursor= on
-- reconnect to replay any gap.
--
-- `seq` is per-run; lets PR #14's consumer detect intra-run
-- gaps even if `id` skips because of concurrent inserts on
-- other threads (BIGSERIAL is monotonic but not gapless).
--
-- `payload` is nullable: a SQL-NULL means the slice value was JSON-null
-- (e.g. `interrupt` cleared after the user answers, or `research_plan`
-- before the search subgraph runs). We can't store JSON-null directly via
-- supabase-js, so SQL-NULL stands in. Replay treats both identically:
-- the FE sees `value: null`.
create table if not exists agent_events (
  id          bigserial primary key,
  thread_id   uuid not null,
  run_id      uuid not null references agent_runs(id) on delete cascade,
  seq         int  not null,
  kind        text not null,
  payload     jsonb,
  created_at  timestamptz not null default now()
);

create unique index if not exists agent_events_run_seq_uidx
  on agent_events(run_id, seq);

create index if not exists agent_events_thread_id_id_idx
  on agent_events(thread_id, id);

-- Re-runs of this migration where the table existed with NOT NULL must
-- relax the constraint. Ignored if the column is already nullable.
do $$
begin
  alter table agent_events alter column payload drop not null;
exception when others then
  null;
end$$;

-- ─── pg_notify trigger ──────────────────────────────────────
-- Fires on every event insert. Payload is the row id only —
-- the consumer SELECTs the row by id to fetch payload (avoids
-- the 8 KB pg_notify payload limit).
--
-- Channel name is `agent_events_<thread_uuid_with_underscores>`
-- because Postgres LISTEN identifiers can't contain dashes.
create or replace function notify_agent_event()
returns trigger as $$
begin
  perform pg_notify(
    'agent_events_' || replace(new.thread_id::text, '-', '_'),
    new.id::text
  );
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_agent_events_notify on agent_events;
create trigger trg_agent_events_notify
after insert on agent_events
for each row execute function notify_agent_event();

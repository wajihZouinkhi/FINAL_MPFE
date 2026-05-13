-- ============================================================
-- 0004_agent_runs_realtime.sql
--
-- Add `agent_runs` and `agent_events` to the supabase_realtime
-- publication so the FE can react to lifecycle changes (run
-- created / completed / failed / paused) and replay typed
-- agent slices (phase, research_plan, todo_plan, manifest,
-- interrupt, interrupt_history) live, without the user being
-- the one driving the SSE stream.
--
-- Without this, a thread that fails after the user closed the
-- tab silently stays "researching" in the FE's view on reload,
-- because the only way the FE learns about phase transitions
-- today is the in-request SSE stream.
--
-- Also bumps `agent_runs` to REPLICA IDENTITY FULL so UPDATE
-- payloads include the full row (incl. thread_id, status,
-- error) — the FE filters on thread_id and reads status/error
-- in the change handler. Default REPLICA IDENTITY would only
-- send the primary key for UPDATE/DELETE, dropping every event
-- on the floor at the FE filter.
--
-- agent_events is INSERT-only, so default REPLICA IDENTITY is
-- fine for it (full row is always emitted on INSERT).
--
-- Idempotent: safe to re-run.
-- ============================================================

alter table agent_runs replica identity full;

do $$
declare
  t text;
begin
  for t in select unnest(array['agent_runs','agent_events'])
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
end$$;

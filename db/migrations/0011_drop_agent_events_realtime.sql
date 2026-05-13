-- ============================================================
-- 0011_drop_agent_events_realtime.sql
--
-- Drop `agent_events` from the `supabase_realtime` publication
-- (added in 0004) and revert its replica identity to default.
-- Nothing on the FE has subscribed to `agent_events` realtime
-- since the live channel migrated to the Redis-backed SSE replay
-- endpoint (see `apps/web/lib/agent-run-realtime.ts` —
-- "single SSE connection instead of two channels"). Keeping
-- the table in the publication just costs us logical decoding
-- traffic for no consumer.
--
-- `agent_runs` STAYS in the publication: the threads / run-list
-- pages still react to lifecycle status changes via realtime,
-- and `REPLICA IDENTITY FULL` on a one-row-per-run table is
-- cheap.
--
-- Idempotent: safe to re-run. Both the publication-drop and
-- the replica-identity reset are guarded by existence checks.
-- ============================================================

do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'agent_events'
  ) then
    execute 'alter publication supabase_realtime drop table agent_events';
  end if;
end$$;

-- agent_events was never bumped to REPLICA IDENTITY FULL by 0004
-- (only agent_runs was), so we don't need to reset it. Left as a
-- comment for future readers to confirm.
-- alter table agent_events replica identity default;

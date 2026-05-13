-- ============================================================
-- 0002_replica_identity_full.sql
-- Make Supabase Realtime DELETE payloads contain the full row.
--
-- By default a Postgres table's REPLICA IDENTITY is DEFAULT,
-- which means logical replication only includes primary-key
-- columns in the OLD tuple of UPDATE/DELETE WAL records.
-- Supabase Realtime then forwards `payload.old = { id }`, so any
-- frontend filter that reads non-PK columns (e.g. thread_id,
-- syllabus_id, chapter_id) drops the event silently.
--
-- Setting REPLICA IDENTITY FULL emits the full pre-image, which
-- is what the realtime handlers in apps/web/lib/realtime.ts
-- depend on.
--
-- ALTER TABLE ... REPLICA IDENTITY is itself idempotent (re-runs
-- are no-ops if the setting is already FULL), so this migration
-- is safe to re-run.
-- ============================================================

alter table syllabuses replica identity full;
alter table chapters   replica identity full;
alter table lessons    replica identity full;

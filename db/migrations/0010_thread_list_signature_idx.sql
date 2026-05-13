-- ============================================================
-- 0010_thread_list_signature_idx.sql — supporting indexes for
-- the threads-list ETag signature (audit §3.2 follow-up).
--
-- `ThreadsService.listSignature` runs a handful of
-- `MAX(...)` + `COUNT(*)` probes on every silent poll of
-- `/api/threads`. To keep the signature comfortably under the
-- "<10ms" budget we promised in the JSDoc — even on growing
-- production tables — each MAX/ORDER BY needs an index whose
-- ordering matches.
--
--   threads_updated_at_desc_idx
--     `MAX(updated_at)` over the threads table.  No descending
--     index existed on `threads.updated_at` previously (0001
--     created the table without one and 0007 only indexed
--     `agent` / `bound_syllabus_thread_id`), so the probe was
--     falling back to a heap scan + sort.
--
--   syllabuses_updated_at_desc_idx
--     `MAX(updated_at)` over syllabuses.  The 0001 index keys
--     on `thread_id`, which is wrong for this probe.
--
--   agent_runs_finished_at_desc_idx
--     `MAX(finished_at)` over agent_runs.  Partial index — the
--     column is null for rows still in `running`/`queued`, and
--     the signature only cares about terminal transitions
--     (running → completed/paused/failed in
--     run-recorder.service.ts).
--
--   agent_runs_created_at_desc_idx
--     `MAX(created_at)` + `COUNT(*)` over agent_runs.  Captures
--     new-run inserts from `RunRecorder.create()`.
--
-- Idempotent: safe to re-run.
-- ============================================================

create index if not exists threads_updated_at_desc_idx
  on threads (updated_at desc);

create index if not exists syllabuses_updated_at_desc_idx
  on syllabuses (updated_at desc);

create index if not exists agent_runs_finished_at_desc_idx
  on agent_runs (finished_at desc)
  where finished_at is not null;

create index if not exists agent_runs_created_at_desc_idx
  on agent_runs (created_at desc);

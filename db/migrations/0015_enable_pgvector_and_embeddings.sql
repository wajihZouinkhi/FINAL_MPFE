-- ============================================================
-- 0015_enable_pgvector_and_embeddings.sql — Per-syllabus retrieval.
--
-- Part of the Syllabus -> Unity -> Activity refactor.
--
-- Enables pgvector and creates two embedding tables (one per scope)
-- used for anti-duplication retrieval inside the writer subagent:
--
--   activity_embeddings   - one row per activity, scoped by syllabus_id
--   unity_embeddings      - one row per unity, scoped by syllabus_id
--
-- Embedding dimension is 384 to match `sentence-transformers/all-
-- MiniLM-L6-v2`, which is computed locally inside the mcp-supabase
-- container (no external embedding API call required).
--
-- Index choice: ivfflat with cosine ops. lists=100 is a sane default
-- for the row counts we expect (a few hundred activities per syllabus
-- at most). Switch to hnsw if the working set grows past ~50k rows.
--
-- Idempotent: safe to re-run.
-- ============================================================

create extension if not exists vector;

-- ─── activity_embeddings ───────────────────────────────────
create table if not exists public.activity_embeddings (
  activity_id   uuid primary key references public.activities(id) on delete cascade,
  syllabus_id   uuid not null,
  content_hash  text not null,
  embedding     vector(384) not null,
  updated_at    timestamptz not null default now()
);

create index if not exists activity_embeddings_syllabus_idx
  on public.activity_embeddings(syllabus_id);

create index if not exists activity_embeddings_ann_idx
  on public.activity_embeddings using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- ─── unity_embeddings ──────────────────────────────────────
create table if not exists public.unity_embeddings (
  unity_id      uuid primary key references public.unities(id) on delete cascade,
  syllabus_id   uuid not null,
  content_hash  text not null,
  embedding     vector(384) not null,
  updated_at    timestamptz not null default now()
);

create index if not exists unity_embeddings_syllabus_idx
  on public.unity_embeddings(syllabus_id);

create index if not exists unity_embeddings_ann_idx
  on public.unity_embeddings using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

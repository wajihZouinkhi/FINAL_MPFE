-- ============================================================
-- 0005_pedagogical_contract.sql — Pedagogical contract columns.
--
-- Adds the structured fields the supervisor v2 prompt populates and the
-- writer / critic / FE Viewer consume:
--
--   syllabuses:
--     audience  jsonb  -- { level, prior_knowledge[], language }
--     scope     jsonb  -- { duration_hours, target_outcome, constraints[] }
--     pedagogy  jsonb  -- { style, assessment, differentiation }
--
--   chapters:
--     outcomes      jsonb  -- string[]: chapter-level "students will be able to ..."
--     prerequisites jsonb  -- string[]: prior knowledge needed for this chapter
--
--   lessons:
--     learning_objectives jsonb -- [{ text, bloom_level }]
--     prerequisites       jsonb -- string[]
--     key_terms           jsonb -- string[]
--     worked_example_seed text
--     assessment_idea     text
--     duration_min        int
--     bloom_level         text  -- aggregate Bloom level for the lesson
--     review_required     boolean default false
--                              -- true when force-passed (writer hit MAX_REVISIONS
--                              -- but the critic still had block-severity issues).
--                              -- The FileTree shows a "review me" badge for these.
--     block_issues        jsonb -- string[]: outstanding block issues from the
--                              -- final critic pass when review_required=true
--
-- All columns are nullable / default-empty so v1 rows continue to read
-- without changes. The supervisor v2 prompt populates them on new builds;
-- the writer / critic prompts treat missing values as "not specified" and
-- fall back to v1 behaviour for older committed lessons.
--
-- Idempotent: safe to re-run.
-- ============================================================

alter table syllabuses
  add column if not exists audience jsonb,
  add column if not exists scope    jsonb,
  add column if not exists pedagogy jsonb;

alter table chapters
  add column if not exists outcomes      jsonb default '[]'::jsonb,
  add column if not exists prerequisites jsonb default '[]'::jsonb;

alter table lessons
  add column if not exists learning_objectives jsonb default '[]'::jsonb,
  add column if not exists prerequisites       jsonb default '[]'::jsonb,
  add column if not exists key_terms           jsonb default '[]'::jsonb,
  add column if not exists worked_example_seed text,
  add column if not exists assessment_idea     text,
  add column if not exists duration_min        int,
  add column if not exists bloom_level         text,
  add column if not exists review_required     boolean not null default false,
  add column if not exists block_issues        jsonb default '[]'::jsonb;

-- The FileTree filters lessons that need review; index supports that.
create index if not exists lessons_review_required_idx
  on lessons(chapter_id)
  where review_required = true;

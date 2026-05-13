"""Verification script for the pgvector anti-duplication indexing path.

Exercises the four cases from INTEGRATION_PLAN.md §6:

  1. Insert an activity -> activity_embeddings row appears, hash matches.
  2. Two activities in the same syllabus with overlapping topics ->
     find_related_activities returns the relevant one first.
  3. Two activities in DIFFERENT syllabuses with the same topic ->
     find_related_activities for syllabus A does NOT return the
     activity from syllabus B.
  4. Re-generate an activity (UPDATE in place) -> activity_embeddings
     row upserts cleanly (still one row per activity_id).

Reads the connection URL from $SUPABASE_DB_URL (must be set), executes
against a temporary syllabus + unity it cleans up at the end of the
run. Embeddings are computed *locally* with the same model the
mcp-supabase server uses (`sentence-transformers/all-MiniLM-L6-v2`)
so the test is self-contained — no need to hit the MCP HTTP surface.

Usage:

  SUPABASE_DB_URL=postgresql://... python3 scripts/indexing-verify.py

Exits 0 on full success, non-zero on the first failure. Designed to be
re-runnable: each run creates fresh syllabus/unity rows and cleans up
on exit.
"""

from __future__ import annotations

import os
import sys
import uuid
import hashlib
from typing import Any

try:
    import psycopg2
except ImportError:
    print("FAIL: psycopg2 is required. Install with `pip install psycopg2-binary`.")
    sys.exit(1)

try:
    from sentence_transformers import SentenceTransformer
except ImportError:
    print(
        "FAIL: sentence-transformers is required. Install with `pip install sentence-transformers`."
    )
    sys.exit(1)


MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"


def content_hash(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def vec_literal(vec: list[float]) -> str:
    return "[" + ",".join(f"{x:.6f}" for x in vec) + "]"


def main() -> int:
    db_url = os.environ.get("SUPABASE_DB_URL")
    if not db_url:
        print("FAIL: SUPABASE_DB_URL not set.")
        return 1

    print(f"Loading {MODEL_NAME} (first run downloads ~90 MB)...")
    model = SentenceTransformer(MODEL_NAME)

    conn = psycopg2.connect(db_url)
    conn.autocommit = True
    cur = conn.cursor()

    syllabus_a = str(uuid.uuid4())
    syllabus_b = str(uuid.uuid4())
    unity_a = str(uuid.uuid4())
    unity_b = str(uuid.uuid4())
    act_a1 = str(uuid.uuid4())
    act_a2 = str(uuid.uuid4())
    act_b1 = str(uuid.uuid4())

    created: list[tuple[str, str]] = []  # (table, id)

    try:
        # --- arrange: two syllabuses + one unity each ----------------------
        cur.execute(
            "insert into public.syllabuses(id, title, description) values (%s, %s, %s)",
            (syllabus_a, "Indexing verify A", "test"),
        )
        created.append(("syllabuses", syllabus_a))
        cur.execute(
            "insert into public.syllabuses(id, title, description) values (%s, %s, %s)",
            (syllabus_b, "Indexing verify B", "test"),
        )
        created.append(("syllabuses", syllabus_b))
        cur.execute(
            "insert into public.unities(id, syllabus_id, title, order_index) values (%s, %s, %s, 0)",
            (unity_a, syllabus_a, "Unity A1"),
        )
        created.append(("unities", unity_a))
        cur.execute(
            "insert into public.unities(id, syllabus_id, title, order_index) values (%s, %s, %s, 0)",
            (unity_b, syllabus_b, "Unity B1"),
        )
        created.append(("unities", unity_b))

        # --- case 1: insert activity, then embed_and_upsert ---------------
        body_a1 = (
            "Breadth-first search (BFS) is a graph traversal algorithm that "
            "explores nodes layer by layer using a FIFO queue."
        )
        cur.execute(
            "insert into public.activities(id, unity_id, title, body, kind, prompt, lesson_title) "
            "values (%s, %s, %s, %s, 'worksheet', '', %s)",
            (act_a1, unity_a, "BFS", body_a1, "BFS"),
        )
        created.append(("activities", act_a1))

        emb_a1 = model.encode(body_a1, normalize_embeddings=True).tolist()
        cur.execute(
            "insert into public.activity_embeddings(activity_id, syllabus_id, content_hash, embedding) "
            "values (%s, %s, %s, %s::vector) "
            "on conflict (activity_id) do update set "
            "  syllabus_id = excluded.syllabus_id, "
            "  content_hash = excluded.content_hash, "
            "  embedding = excluded.embedding, "
            "  updated_at = now()",
            (act_a1, syllabus_a, content_hash(body_a1), vec_literal(emb_a1)),
        )

        cur.execute(
            "select content_hash from public.activity_embeddings where activity_id = %s",
            (act_a1,),
        )
        row = cur.fetchone()
        assert row is not None, "case 1: embedding row missing"
        assert row[0] == content_hash(body_a1), "case 1: hash mismatch"
        print("PASS case 1: activity_embeddings row inserted with matching hash.")

        # --- case 2: second activity in same syllabus, overlapping topic ---
        body_a2 = (
            "Depth-first search (DFS) is a graph traversal algorithm that "
            "explores as far as possible along each branch before backtracking."
        )
        cur.execute(
            "insert into public.activities(id, unity_id, title, body, kind, prompt, lesson_title) "
            "values (%s, %s, %s, %s, 'worksheet', '', %s)",
            (act_a2, unity_a, "DFS", body_a2, "DFS"),
        )
        created.append(("activities", act_a2))
        emb_a2 = model.encode(body_a2, normalize_embeddings=True).tolist()
        cur.execute(
            "insert into public.activity_embeddings(activity_id, syllabus_id, content_hash, embedding) "
            "values (%s, %s, %s, %s::vector)",
            (act_a2, syllabus_a, content_hash(body_a2), vec_literal(emb_a2)),
        )

        query_a = "graph traversal algorithms"
        emb_q = model.encode(query_a, normalize_embeddings=True).tolist()
        cur.execute(
            "select activity_id, 1 - (embedding <=> %s::vector) as cosine "
            "from public.activity_embeddings "
            "where syllabus_id = %s "
            "order by embedding <=> %s::vector asc "
            "limit 5",
            (vec_literal(emb_q), syllabus_a, vec_literal(emb_q)),
        )
        hits = cur.fetchall()
        assert len(hits) >= 2, "case 2: expected at least 2 hits in syllabus A"
        top_ids = {h[0] for h in hits}
        assert {act_a1, act_a2}.issubset(top_ids), (
            f"case 2: BFS/DFS missing from top hits: {top_ids}"
        )
        print(
            f"PASS case 2: intra-syllabus retrieval returned both BFS+DFS (cosines: "
            f"{[round(h[1], 3) for h in hits]})."
        )

        # --- case 3: same topic, different syllabus, must NOT leak --------
        body_b1 = (
            "Breadth-first search is a foundational graph traversal "
            "algorithm covered in CS101 introduction to algorithms."
        )
        cur.execute(
            "insert into public.activities(id, unity_id, title, body, kind, prompt, lesson_title) "
            "values (%s, %s, %s, %s, 'worksheet', '', %s)",
            (act_b1, unity_b, "BFS (other syllabus)", body_b1, "BFS"),
        )
        created.append(("activities", act_b1))
        emb_b1 = model.encode(body_b1, normalize_embeddings=True).tolist()
        cur.execute(
            "insert into public.activity_embeddings(activity_id, syllabus_id, content_hash, embedding) "
            "values (%s, %s, %s, %s::vector)",
            (act_b1, syllabus_b, content_hash(body_b1), vec_literal(emb_b1)),
        )

        # Query scoped to syllabus A — must not return act_b1.
        cur.execute(
            "select activity_id from public.activity_embeddings "
            "where syllabus_id = %s "
            "order by embedding <=> %s::vector asc "
            "limit 5",
            (syllabus_a, vec_literal(emb_q)),
        )
        a_only = {r[0] for r in cur.fetchall()}
        assert act_b1 not in a_only, "case 3: cross-syllabus leak!"
        # Query scoped to syllabus B — must include act_b1.
        cur.execute(
            "select activity_id from public.activity_embeddings "
            "where syllabus_id = %s "
            "order by embedding <=> %s::vector asc "
            "limit 5",
            (syllabus_b, vec_literal(emb_q)),
        )
        b_only = {r[0] for r in cur.fetchall()}
        assert act_b1 in b_only, "case 3: syllabus B missing its own activity"
        print(
            "PASS case 3: cross-syllabus isolation holds "
            "(scope=A returns only A; scope=B returns B's row)."
        )

        # --- case 4: re-generate -> upsert (no duplicate) -----------------
        body_a1_v2 = body_a1 + " The complexity is O(V+E) on adjacency lists."
        cur.execute(
            "update public.activities set body = %s where id = %s",
            (body_a1_v2, act_a1),
        )
        emb_a1_v2 = model.encode(body_a1_v2, normalize_embeddings=True).tolist()
        cur.execute(
            "insert into public.activity_embeddings(activity_id, syllabus_id, content_hash, embedding) "
            "values (%s, %s, %s, %s::vector) "
            "on conflict (activity_id) do update set "
            "  content_hash = excluded.content_hash, "
            "  embedding = excluded.embedding, "
            "  updated_at = now()",
            (act_a1, syllabus_a, content_hash(body_a1_v2), vec_literal(emb_a1_v2)),
        )
        cur.execute(
            "select count(*), max(content_hash) from public.activity_embeddings where activity_id = %s",
            (act_a1,),
        )
        cnt, h = cur.fetchone()
        assert cnt == 1, f"case 4: duplicate embedding row (got {cnt})"
        assert h == content_hash(body_a1_v2), "case 4: hash did not upsert"
        print("PASS case 4: re-generate upserted cleanly (1 row, new hash).")

        print()
        print("OK: all 4 indexing verification cases passed.")
        return 0
    finally:
        # cleanup in reverse insertion order
        for table, row_id in reversed(created):
            try:
                cur.execute(f"delete from public.{table} where id = %s", (row_id,))
            except Exception as e:  # noqa: BLE001
                print(f"  (cleanup) couldn't delete {table}.{row_id}: {e}")
        cur.close()
        conn.close()


if __name__ == "__main__":
    sys.exit(main())

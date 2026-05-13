"""
FastMCP server exposing Supabase access for MPFE agents.

Tool catalog (Syllabus -> Unity -> Activity refactor):

Read tools — new shape::

    list_syllabuses(thread_id)
    get_syllabus(syllabus_id)
    list_unities(syllabus_id)
    list_activities_for_unity(unity_id)
    list_activities_for_thread(thread_id)
    get_activity(activity_id)

Write tools — new shape::

    create_syllabus(thread_id, title, ...)
    create_unity(syllabus_id, title, order_index, ...)
    create_activity(unity_id, title, content, order_index, ...,
                    worksheet?)
    update_activity_worksheet(activity_id, worksheet)

Retrieval tools (pgvector + local sentence-transformers)::

    embed_text(text) -> list[float]
    find_related_activities(syllabus_id, query_text, top_k=5)
    find_related_unities(syllabus_id, query_text, top_k=5)

Backward-compat aliases (kept so the legacy /api/chat code path
keeps functioning during the transition window — they delegate to
the new tools)::

    list_chapters(syllabus_id)      -> list_unities
    create_chapter(syllabus_id, ..) -> create_unity
    list_lessons(chapter_id)        -> list_activities_for_unity
    list_lessons_for_thread(...)    -> list_activities_for_thread
    get_lesson(lesson_id)           -> get_activity
    create_lesson(chapter_id, ...)  -> create_activity (cours only,
                                       no worksheet)

The legacy worksheet-shaped create_activity signature (lesson_id +
mcqs + short_answers + worked_example) is still accepted: the server
detects the legacy shape and writes the worksheet jsonb without
touching unity_id / body. This lets the activity-generator-tooled
legacy agent keep producing worksheets attached to lessons.

The server runs over stdio (one child process per long-lived API
session) OR over streamable-http (Railway). Auth: it uses the
SUPABASE_SERVICE_ROLE_KEY because the API process owns this child
and the API is already trusted with full DB access.
"""

from __future__ import annotations

import os
import sys
from typing import Any

from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from supabase import Client, create_client

from .embeddings import (
    EMBEDDING_DIM,
    content_hash,
    embed_text as _embed_text,
    vector_literal,
)


def _build_client() -> Client:
    """Build the Supabase client from environment variables.

    Loads `.env` from the repo root if present so a developer can
    `cd apps/mcp-supabase && uv run mpfe-mcp-supabase` without
    re-exporting credentials.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    for _ in range(6):
        candidate = os.path.join(here, ".env")
        if os.path.exists(candidate):
            load_dotenv(candidate)
            break
        here = os.path.dirname(here)

    url = os.environ.get("SUPABASE_URL")
    key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or os.environ.get("SUPABASE_ANON_KEY")
    )
    if not url or not key:
        print(
            "[mpfe-mcp-supabase] missing SUPABASE_URL or "
            "SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY",
            file=sys.stderr,
        )
        raise SystemExit(2)
    return create_client(url, key)


_TRANSPORT = os.environ.get("MCP_TRANSPORT", "stdio").strip().lower()
_HOST = os.environ.get("MCP_HOST", "0.0.0.0")
_PORT = int(os.environ.get("PORT", os.environ.get("MCP_PORT", "8000")))

if _TRANSPORT in {"streamable-http", "streamable_http", "http", "sse"}:
    mcp = FastMCP(
        "mpfe-mcp-supabase",
        host=_HOST,
        port=_PORT,
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=False,
            allowed_hosts=["*"],
            allowed_origins=["*"],
        ),
    )
else:
    mcp = FastMCP("mpfe-mcp-supabase")

_supabase: Client | None = None


def _supa() -> Client:
    """Lazy singleton so import-time costs are not paid until the
    first tool call."""
    global _supabase
    if _supabase is None:
        _supabase = _build_client()
    return _supabase


# ─── Activity / Unity selection columns ────────────────────────────

_UNITY_COLS = "id,syllabus_id,title,order_index,outcomes,prerequisites"
_ACTIVITY_LIST_COLS = (
    "id,unity_id,title,order_index,learning_objectives,duration_min,"
    "bloom_level"
)
_ACTIVITY_FULL_COLS = (
    "id,unity_id,title,order_index,body,content,worksheet,"
    "learning_objectives,prerequisites,key_terms,worked_example_seed,"
    "assessment_idea,duration_min,bloom_level,review_required,"
    "block_issues,critic_issues,depends_on,thread_id,lesson_id,kind,"
    "lesson_title,prompt"
)


# ─── Syllabus reads ────────────────────────────────────────────────


@mcp.tool()
def list_syllabuses(thread_id: str) -> list[dict[str, Any]]:
    """List the syllabuses bound to a thread."""
    res = (
        _supa()
        .table("syllabuses")
        .select("id,thread_id,title,description,audience,scope,pedagogy,created_at,updated_at")
        .eq("thread_id", thread_id)
        .order("created_at", desc=True)
        .execute()
    )
    return list(res.data or [])


@mcp.tool()
def get_syllabus(syllabus_id: str) -> dict[str, Any] | None:
    """Fetch a single syllabus row by id."""
    res = (
        _supa()
        .table("syllabuses")
        .select(
            "id,thread_id,title,description,audience,scope,pedagogy,"
            "created_at,updated_at"
        )
        .eq("id", syllabus_id)
        .maybe_single()
        .execute()
    )
    return res.data if res and res.data else None


# ─── Unity reads ────────────────────────────────────────────────────


@mcp.tool()
def list_unities(syllabus_id: str) -> list[dict[str, Any]]:
    """Ordered list of unities in a syllabus.

    Returns id + syllabus_id + title + order_index + outcomes +
    prerequisites. No activity content.
    """
    res = (
        _supa()
        .table("unities")
        .select(_UNITY_COLS)
        .eq("syllabus_id", syllabus_id)
        .order("order_index", desc=False)
        .execute()
    )
    return list(res.data or [])


# Backward-compat alias.
@mcp.tool()
def list_chapters(syllabus_id: str) -> list[dict[str, Any]]:
    """DEPRECATED alias for ``list_unities``. Returns the same rows."""
    return list_unities(syllabus_id)


# ─── Activity reads ─────────────────────────────────────────────────


@mcp.tool()
def list_activities_for_unity(unity_id: str) -> list[dict[str, Any]]:
    """Ordered list of activities under a unity.

    Returns id + title + order_index + learning_objectives +
    duration_min + bloom_level. Body / worksheet are intentionally
    NOT returned to keep the agent's menu cheap; call
    ``get_activity(activity_id)`` for the full row.
    """
    res = (
        _supa()
        .table("activities")
        .select(_ACTIVITY_LIST_COLS)
        .eq("unity_id", unity_id)
        .order("order_index", desc=False)
        .execute()
    )
    return list(res.data or [])


@mcp.tool()
def list_activities_for_thread(thread_id: str) -> list[dict[str, Any]]:
    """Flat menu of all activities under the thread's first syllabus.

    Joined with unity titles so the agent can present a coherent
    picker. Falls back to an empty list when no syllabus exists.
    """
    syllabuses = list_syllabuses(thread_id)
    if not syllabuses:
        return []
    syllabus_id = syllabuses[0]["id"]
    units = list_unities(syllabus_id)
    if not units:
        return []
    unit_titles = {u["id"]: u["title"] for u in units}
    unit_orders = {u["id"]: u["order_index"] for u in units}
    res = (
        _supa()
        .table("activities")
        .select(_ACTIVITY_LIST_COLS)
        .in_("unity_id", [u["id"] for u in units])
        .order("order_index", desc=False)
        .execute()
    )
    out: list[dict[str, Any]] = []
    for row in res.data or []:
        out.append(
            {
                **row,
                "unity_title": unit_titles.get(row["unity_id"], ""),
                "unity_order_index": unit_orders.get(row["unity_id"], 0),
            }
        )
    out.sort(key=lambda x: (x["unity_order_index"], x["order_index"]))
    return out


@mcp.tool()
def get_activity(activity_id: str) -> dict[str, Any] | None:
    """Fetch a single activity row including the full body + worksheet."""
    res = (
        _supa()
        .table("activities")
        .select(_ACTIVITY_FULL_COLS)
        .eq("id", activity_id)
        .maybe_single()
        .execute()
    )
    return res.data if res and res.data else None


# Backward-compat aliases for the legacy lesson/chapter naming.
@mcp.tool()
def list_lessons(chapter_id: str) -> list[dict[str, Any]]:
    """DEPRECATED alias for ``list_activities_for_unity``.

    Treats ``chapter_id`` as the unity id. Also returns rows from the
    legacy ``lessons`` table for any unity that still has lesson rows
    pre-merge (empty in fresh installs).
    """
    new_rows = list_activities_for_unity(chapter_id)
    legacy = (
        _supa()
        .table("lessons")
        .select(
            "id,chapter_id,title,order_index,learning_objectives,duration_min"
        )
        .eq("chapter_id", chapter_id)
        .order("order_index", desc=False)
        .execute()
    )
    legacy_rows = list(legacy.data or [])
    return [*new_rows, *legacy_rows]


@mcp.tool()
def list_lessons_for_thread(thread_id: str) -> list[dict[str, Any]]:
    """DEPRECATED alias for ``list_activities_for_thread``."""
    return list_activities_for_thread(thread_id)


@mcp.tool()
def get_lesson(lesson_id: str) -> dict[str, Any] | None:
    """DEPRECATED alias for ``get_activity``.

    Falls back to the legacy ``lessons`` table for ids that predate
    the activity merge.
    """
    hit = get_activity(lesson_id)
    if hit is not None:
        return hit
    res = (
        _supa()
        .table("lessons")
        .select(
            "id,chapter_id,title,content,order_index,"
            "learning_objectives,prerequisites,key_terms,"
            "worked_example_seed,assessment_idea,duration_min"
        )
        .eq("id", lesson_id)
        .maybe_single()
        .execute()
    )
    return res.data if res and res.data else None


# ─── Syllabus writes ───────────────────────────────────────────────


@mcp.tool()
def create_syllabus(
    thread_id: str,
    title: str,
    description: str = "",
    audience: dict[str, Any] | None = None,
    scope: dict[str, Any] | None = None,
    pedagogy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Create a syllabus row attached to a thread."""
    payload: dict[str, Any] = {
        "thread_id": thread_id,
        "title": title,
        "description": description,
    }
    if audience is not None:
        payload["audience"] = audience
    if scope is not None:
        payload["scope"] = scope
    if pedagogy is not None:
        payload["pedagogy"] = pedagogy
    res = _supa().table("syllabuses").insert(payload).execute()
    rows = list(res.data or [])
    if not rows:
        raise RuntimeError(
            "create_syllabus insert returned no row — "
            "check the thread exists and service-role can write to syllabuses."
        )
    return rows[0]


# ─── Unity writes ──────────────────────────────────────────────────


def _insert_unity(
    syllabus_id: str,
    title: str,
    order_index: int,
    outcomes: list[str] | None,
    prerequisites: list[str] | None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "syllabus_id": syllabus_id,
        "title": title,
        "order_index": order_index,
    }
    if outcomes is not None:
        payload["outcomes"] = outcomes
    if prerequisites is not None:
        payload["prerequisites"] = prerequisites
    res = _supa().table("unities").insert(payload).execute()
    rows = list(res.data or [])
    if not rows:
        raise RuntimeError(
            "create_unity insert returned no row — "
            "check the syllabus exists and service-role can write to unities."
        )
    row = rows[0]
    try:
        _upsert_unity_embedding(row, syllabus_id=syllabus_id)
    except Exception as exc:  # noqa: BLE001
        print(
            f"[mpfe-mcp-supabase] unity_embeddings upsert failed: {exc}",
            file=sys.stderr,
        )
    return row


@mcp.tool()
def create_unity(
    syllabus_id: str,
    title: str,
    order_index: int,
    outcomes: list[str] | None = None,
    prerequisites: list[str] | None = None,
) -> dict[str, Any]:
    """Create a unity row under a syllabus."""
    return _insert_unity(
        syllabus_id=syllabus_id,
        title=title,
        order_index=order_index,
        outcomes=outcomes,
        prerequisites=prerequisites,
    )


@mcp.tool()
def create_chapter(
    syllabus_id: str,
    title: str,
    order_index: int,
    outcomes: list[str] | None = None,
    prerequisites: list[str] | None = None,
) -> dict[str, Any]:
    """DEPRECATED alias for ``create_unity``."""
    return _insert_unity(
        syllabus_id=syllabus_id,
        title=title,
        order_index=order_index,
        outcomes=outcomes,
        prerequisites=prerequisites,
    )


# ─── Activity writes (new merged shape) ────────────────────────────


def _resolve_syllabus_id_for_unity(unity_id: str) -> str | None:
    res = (
        _supa()
        .table("unities")
        .select("syllabus_id")
        .eq("id", unity_id)
        .maybe_single()
        .execute()
    )
    if not res or not res.data:
        return None
    return res.data.get("syllabus_id")


def _embedding_source_for_activity(row: dict[str, Any]) -> str:
    parts = [
        row.get("title") or "",
        row.get("body") or "",
        ", ".join(
            str(lo.get("text", lo) if isinstance(lo, dict) else lo)
            for lo in (row.get("learning_objectives") or [])
        ),
        ", ".join(str(k) for k in (row.get("key_terms") or [])),
    ]
    return "\n".join(p for p in parts if p)


def _embedding_source_for_unity(row: dict[str, Any]) -> str:
    parts = [
        row.get("title") or "",
        ", ".join(str(o) for o in (row.get("outcomes") or [])),
        ", ".join(str(p) for p in (row.get("prerequisites") or [])),
    ]
    return "\n".join(p for p in parts if p)


def _upsert_activity_embedding(row: dict[str, Any], syllabus_id: str | None) -> None:
    if not row.get("id") or not syllabus_id:
        return
    source = _embedding_source_for_activity(row)
    h = content_hash(source)
    vec = _embed_text(source)
    payload = {
        "activity_id": row["id"],
        "syllabus_id": syllabus_id,
        "content_hash": h,
        "embedding": vector_literal(vec),
    }
    _supa().table("activity_embeddings").upsert(payload, on_conflict="activity_id").execute()


def _upsert_unity_embedding(row: dict[str, Any], syllabus_id: str | None) -> None:
    if not row.get("id") or not syllabus_id:
        return
    source = _embedding_source_for_unity(row)
    h = content_hash(source)
    vec = _embed_text(source)
    payload = {
        "unity_id": row["id"],
        "syllabus_id": syllabus_id,
        "content_hash": h,
        "embedding": vector_literal(vec),
    }
    _supa().table("unity_embeddings").upsert(payload, on_conflict="unity_id").execute()


@mcp.tool()
def create_activity(
    unity_id: str | None = None,
    title: str = "",
    content: str = "",
    order_index: int = 0,
    learning_objectives: list[dict[str, Any]] | None = None,
    prerequisites: list[str] | None = None,
    key_terms: list[str] | None = None,
    worked_example_seed: str = "",
    assessment_idea: str = "",
    duration_min: int = 0,
    bloom_level: str | None = None,
    worksheet: dict[str, Any] | None = None,
    # ─── legacy worksheet-only arguments ───
    thread_id: str | None = None,
    mcqs: list[dict[str, Any]] | None = None,
    short_answers: list[dict[str, Any]] | None = None,
    worked_example: dict[str, Any] | None = None,
    intro: str = "",
    lesson_id: str | None = None,
    lesson_title: str = "",
    prompt: str = "",
    kind: str = "worksheet",
) -> dict[str, Any]:
    """Create an activity row.

    Two flavours are accepted:

    1. **New merged shape** (preferred): pass ``unity_id`` + ``title``
       + ``content`` (markdown cours). ``worksheet`` is an optional
       dict matching the ``Worksheet`` schema; if omitted the worksheet
       can be filled in later via ``update_activity_worksheet``.

    2. **Legacy worksheet-only shape**: pass ``thread_id`` + ``mcqs``
       (plus optional ``short_answers`` / ``worked_example`` / etc.).
       This path bypasses ``unity_id`` and writes the worksheet into
       both the legacy ``content`` (jsonb) and the new ``worksheet``
       (jsonb) columns so downstream readers see consistent data.
    """
    legacy = unity_id is None and (mcqs is not None or thread_id is not None)

    if legacy:
        label = lesson_title or title
        we = worked_example or {"prompt": "", "steps": [], "final_answer": ""}
        worksheet_json = {
            "title": title or label,
            "intro": intro,
            "mcqs": mcqs or [],
            "short_answers": short_answers or [],
            "worked_example": {
                "prompt": str(we.get("prompt", "")),
                "steps": [str(s) for s in (we.get("steps") or [])],
                "final_answer": str(we.get("final_answer", "")),
            },
        }
        payload: dict[str, Any] = {
            "thread_id": thread_id,
            "kind": kind,
            "prompt": prompt or title or label,
            "lesson_title": label,
            "content": worksheet_json,
            "worksheet": worksheet_json,
            "title": title or label,
        }
        if lesson_id is not None:
            payload["lesson_id"] = lesson_id
        res = _supa().table("activities").insert(payload).execute()
        rows = list(res.data or [])
        if not rows:
            raise RuntimeError(
                "create_activity (legacy) insert returned no row — "
                "check thread + service-role permissions."
            )
        return rows[0]

    if not unity_id:
        raise RuntimeError(
            "create_activity: either unity_id (new shape) or "
            "thread_id+mcqs (legacy shape) is required."
        )

    payload: dict[str, Any] = {
        "unity_id": unity_id,
        "title": title,
        "order_index": order_index,
        "body": content,
        "worked_example_seed": worked_example_seed,
        "assessment_idea": assessment_idea,
        "duration_min": duration_min,
        "kind": "lesson",
    }
    if learning_objectives is not None:
        payload["learning_objectives"] = learning_objectives
    if prerequisites is not None:
        payload["prerequisites"] = prerequisites
    if key_terms is not None:
        payload["key_terms"] = key_terms
    if bloom_level is not None:
        payload["bloom_level"] = bloom_level
    if worksheet is not None:
        payload["worksheet"] = worksheet
    res = _supa().table("activities").insert(payload).execute()
    rows = list(res.data or [])
    if not rows:
        raise RuntimeError(
            "create_activity insert returned no row — "
            "check the unity exists and service-role can write to activities."
        )
    row = rows[0]
    try:
        sid = _resolve_syllabus_id_for_unity(unity_id)
        _upsert_activity_embedding(row, syllabus_id=sid)
    except Exception as exc:  # noqa: BLE001
        print(
            f"[mpfe-mcp-supabase] activity_embeddings upsert failed: {exc}",
            file=sys.stderr,
        )
    return row


@mcp.tool()
def update_activity_worksheet(
    activity_id: str,
    worksheet: dict[str, Any],
) -> dict[str, Any]:
    """Attach (or replace) the worksheet jsonb on an existing activity.

    Used by the activity_maker subagent after the writer has persisted
    the cours body via ``create_activity``.
    """
    res = (
        _supa()
        .table("activities")
        .update({"worksheet": worksheet})
        .eq("id", activity_id)
        .execute()
    )
    rows = list(res.data or [])
    if not rows:
        raise RuntimeError(
            f"update_activity_worksheet: no activity row with id {activity_id}."
        )
    return rows[0]


# Backward-compat alias for the legacy writer subagent that called
# `create_lesson(chapter_id, title, content, ...)`.
@mcp.tool()
def create_lesson(
    chapter_id: str,
    title: str,
    content: str,
    order_index: int,
    learning_objectives: list[dict[str, Any]] | None = None,
    prerequisites: list[str] | None = None,
    key_terms: list[str] | None = None,
    worked_example_seed: str = "",
    assessment_idea: str = "",
    duration_min: int = 0,
    bloom_level: str | None = None,
) -> dict[str, Any]:
    """DEPRECATED alias for ``create_activity`` in the cours-only shape.

    Treats ``chapter_id`` as the unity id. Writes the markdown cours
    body into ``activities.body`` (and leaves ``worksheet`` empty for
    activity_maker to fill in).
    """
    return create_activity(
        unity_id=chapter_id,
        title=title,
        content=content,
        order_index=order_index,
        learning_objectives=learning_objectives,
        prerequisites=prerequisites,
        key_terms=key_terms,
        worked_example_seed=worked_example_seed,
        assessment_idea=assessment_idea,
        duration_min=duration_min,
        bloom_level=bloom_level,
    )


# ─── Retrieval tools (pgvector + local sentence-transformers) ──────


@mcp.tool()
def embed_text(text: str) -> list[float]:
    """Return the 384-d embedding vector for a single text snippet.

    Wraps the local sentence-transformers model. Empty input returns a
    zero vector.
    """
    return _embed_text(text)


def _find_related(
    table: str,
    id_column: str,
    syllabus_id: str,
    query_text: str,
    top_k: int,
    join_table: str,
    join_select: str,
) -> list[dict[str, Any]]:
    vec = _embed_text(query_text)
    if all(v == 0.0 for v in vec):
        return []
    lit = vector_literal(vec)
    sql = (
        f"select e.{id_column} as ref_id, "
        f"       1 - (e.embedding <=> '{lit}'::vector) as similarity "
        f"from public.{table} e "
        f"where e.syllabus_id = %(syllabus_id)s "
        f"order by e.embedding <=> '{lit}'::vector asc "
        f"limit %(top_k)s"
    )
    try:
        rpc = _supa().rpc(
            "exec_select",
            {"sql": sql, "params": {"syllabus_id": syllabus_id, "top_k": top_k}},
        ).execute()
        hits = list(rpc.data or [])
    except Exception:
        # The `exec_select` RPC may not exist; fall back to the
        # PostgREST cosine-distance order filter using the embedding
        # column directly. We retrieve all rows for the syllabus and
        # order client-side.
        res = (
            _supa()
            .table(table)
            .select(f"{id_column},embedding")
            .eq("syllabus_id", syllabus_id)
            .execute()
        )
        rows = list(res.data or [])
        scored: list[tuple[float, str]] = []
        for r in rows:
            emb = r.get("embedding")
            if not emb:
                continue
            try:
                if isinstance(emb, str):
                    emb_list = [
                        float(x) for x in emb.strip("[]").split(",") if x
                    ]
                else:
                    emb_list = [float(x) for x in emb]
            except Exception:
                continue
            if len(emb_list) != EMBEDDING_DIM:
                continue
            dot = sum(a * b for a, b in zip(emb_list, vec, strict=True))
            scored.append((dot, r[id_column]))
        scored.sort(key=lambda t: t[0], reverse=True)
        hits = [{"ref_id": ref_id, "similarity": sim} for sim, ref_id in scored[:top_k]]
    if not hits:
        return []
    ids = [h["ref_id"] for h in hits]
    join = (
        _supa()
        .table(join_table)
        .select(join_select)
        .in_("id", ids)
        .execute()
    )
    rows_by_id = {r["id"]: r for r in (join.data or [])}
    out: list[dict[str, Any]] = []
    for h in hits:
        row = rows_by_id.get(h["ref_id"])
        if not row:
            continue
        out.append({**row, "similarity": float(h.get("similarity", 0.0))})
    return out


@mcp.tool()
def find_related_activities(
    syllabus_id: str,
    query_text: str,
    top_k: int = 5,
) -> list[dict[str, Any]]:
    """Return activities in the same syllabus most similar to query_text.

    Used by the writer subagent before generating a new activity to
    avoid duplicating concepts already covered.
    """
    return _find_related(
        table="activity_embeddings",
        id_column="activity_id",
        syllabus_id=syllabus_id,
        query_text=query_text,
        top_k=top_k,
        join_table="activities",
        join_select=(
            "id,unity_id,title,order_index,learning_objectives,"
            "key_terms,bloom_level,duration_min"
        ),
    )


@mcp.tool()
def find_related_unities(
    syllabus_id: str,
    query_text: str,
    top_k: int = 5,
) -> list[dict[str, Any]]:
    """Return unities in the same syllabus most similar to query_text.

    Used by the pedagogy_planner subagent to keep new unities
    complementary rather than overlapping.
    """
    return _find_related(
        table="unity_embeddings",
        id_column="unity_id",
        syllabus_id=syllabus_id,
        query_text=query_text,
        top_k=top_k,
        join_table="unities",
        join_select="id,syllabus_id,title,order_index,outcomes,prerequisites",
    )


def main() -> None:
    """Entry point. Runs the MCP server on the configured transport."""
    if _TRANSPORT in {"streamable-http", "streamable_http", "http"}:
        mcp.run(transport="streamable-http")
    elif _TRANSPORT == "sse":
        mcp.run(transport="sse")
    else:
        mcp.run()


if __name__ == "__main__":
    main()

"""
FastMCP server exposing Supabase access for MPFE agents.

Originally read-only (the activity-generator-tooled agent never wrote
back to Supabase). Extended in the deep-agent v1 cut to include the
write tools the supervisor + writer subagents need to persist a
syllabus end-to-end.

Read tools (keyed by the existing MPFE schema from db/migrations/0001_init.sql):

- list_syllabuses(thread_id) -> list of syllabus rows for a thread.
  In v1 there is exactly one syllabus per thread, but the tool returns a
  list so the agent's prompt doesn't have to special-case the singleton.

- get_syllabus(syllabus_id) -> single syllabus row, including the
  pedagogical contract columns (audience / scope / pedagogy) the
  deep-agent supervisor populates on create. Returns None when no row.

- list_chapters(syllabus_id) -> ordered chapter rows.

- list_lessons(chapter_id) -> ordered lesson rows for a chapter
  (titles + ids, NOT bodies). Cheap and bounded so the agent can survey
  what's available before deciding which lesson to fetch in full.

- list_lessons_for_thread(thread_id) -> flat list of all lessons
  across the thread's syllabus, joined with chapter titles for context.
  This is the tool the agent will reach for first 99% of the time —
  one call gives it the whole menu.

- get_lesson(lesson_id) -> single lesson row WITH the markdown body.
  Reserved for the second pass after the agent has chosen which lesson
  to ground its worksheet on.

Write tools (used by the deep-agent supervisor + writer subagents):

- create_syllabus(thread_id, title, ...) -> {id}. Inserts a new row
  bound to the supplied thread, returns the id. The supervisor calls
  this first thing in the syllabus build flow so every downstream
  call has a stable id to attach against.

- create_chapter(syllabus_id, title, order_index, ...) -> {id}.
  Inserts one chapter under a syllabus; the writer subagent calls
  this exactly once per chapter it processes (and runs
  list_chapters() first to avoid duplicating).

- create_lesson(chapter_id, title, content, order_index, ...) -> {id}.
  Inserts one lesson under a chapter, with the markdown body and
  the structured pedagogical metadata the FE viewers consume.

- create_activity(thread_id, title, mcqs, ...) -> {id}. Inserts a
  worksheet-shaped activity row (mcqs / short answers / worked
  example). Optionally bound to a `lesson_id` when the activity
  grounds in an existing lesson, otherwise standalone. Used by the
  deep-agent activity_maker subagent.

The server runs over stdio (one child process per long-lived API
session) OR over streamable-http (when MCP_TRANSPORT is set, used by
the Railway deploy). Auth: it uses the SUPABASE_SERVICE_ROLE_KEY
because the API process owns this child and the API is already
trusted with full DB access.
"""

from __future__ import annotations

import os
import sys
from typing import Any

from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from supabase import Client, create_client


def _build_client() -> Client:
    """Build the Supabase client from environment variables.

    Loads `.env` from the repo root if present so a developer can
    `cd apps/mcp-supabase && uv run mpfe-mcp-supabase` without
    re-exporting credentials.
    """
    # Walk up from this file to find a `.env` near the repo root.
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
        # Failing here surfaces in the API's MCP-adapter logs as
        # "MCP server exited at startup" — which is the right outcome,
        # we don't want a half-configured tool quietly returning empty
        # rows and making the agent hallucinate "lesson not found".
        print(
            "[mpfe-mcp-supabase] missing SUPABASE_URL or "
            "SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY",
            file=sys.stderr,
        )
        raise SystemExit(2)
    return create_client(url, key)


# Transport selection. Local dev (and the original API spawn path)
# uses stdio; Railway / any networked deploy uses `streamable-http`
# with `MCP_TRANSPORT=streamable-http` and `PORT` injected by the host.
#
# The streamable-http transport's default host is 127.0.0.1 with DNS
# rebinding protection limited to localhost — neither is useful inside
# a container, so we override both when running over HTTP. The MCP
# server is only ever reachable on Railway's private network (the
# service has no public domain), so wildcarding the allowed hosts is
# safe and avoids brittle hostname pinning.
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
    """Lazy singleton so import-time costs are not paid until the first
    tool call (FastMCP imports this module to discover @mcp.tool decorators).
    """
    global _supabase
    if _supabase is None:
        _supabase = _build_client()
    return _supabase


@mcp.tool()
def list_syllabuses(thread_id: str) -> list[dict[str, Any]]:
    """List the syllabuses bound to a thread.

    For activity-generator-tooled threads, `thread_id` is the
    `bound_syllabus_thread_id` of the activity thread — i.e. the
    *source* syllabus thread, not the activity thread itself. The
    caller is responsible for passing the correct id.
    """
    res = (
        _supa()
        .table("syllabuses")
        .select("id,thread_id,title,description,created_at,updated_at")
        .eq("thread_id", thread_id)
        .order("created_at", desc=True)
        .execute()
    )
    return list(res.data or [])


@mcp.tool()
def list_chapters(syllabus_id: str) -> list[dict[str, Any]]:
    """Ordered list of chapters in a syllabus.

    Returns id + title + order_index + outcomes. No lesson content.
    """
    res = (
        _supa()
        .table("chapters")
        .select("id,syllabus_id,title,order_index,outcomes")
        .eq("syllabus_id", syllabus_id)
        .order("order_index", desc=False)
        .execute()
    )
    return list(res.data or [])


@mcp.tool()
def list_lessons(chapter_id: str) -> list[dict[str, Any]]:
    """Ordered list of lessons in a chapter.

    Returns id + title + order_index + learning_objectives + duration_min.
    Intentionally does NOT return the full markdown body — call
    `get_lesson(lesson_id)` for that. Keeping the menu cheap means the
    agent can survey 30+ lessons in one tool call without inflating the
    LLM context.
    """
    res = (
        _supa()
        .table("lessons")
        .select(
            "id,chapter_id,title,order_index,learning_objectives,duration_min"
        )
        .eq("chapter_id", chapter_id)
        .order("order_index", desc=False)
        .execute()
    )
    return list(res.data or [])


@mcp.tool()
def list_lessons_for_thread(thread_id: str) -> list[dict[str, Any]]:
    """Flat menu of all lessons across all chapters in a thread's syllabus.

    Joined with chapter titles so the agent can present a coherent
    picker (e.g. "Chapter 2 / Lesson 3 — MATCH queries") without a
    second tool call. This is the *first* tool the agent should call
    when the user asks for an activity without specifying a lesson.
    """
    syllabuses = list_syllabuses(thread_id)
    if not syllabuses:
        return []
    syllabus_id = syllabuses[0]["id"]
    chapters_res = (
        _supa()
        .table("chapters")
        .select("id,title,order_index")
        .eq("syllabus_id", syllabus_id)
        .order("order_index", desc=False)
        .execute()
    )
    chapters = list(chapters_res.data or [])
    chapter_titles: dict[str, str] = {c["id"]: c["title"] for c in chapters}
    chapter_orders: dict[str, int] = {c["id"]: c["order_index"] for c in chapters}
    if not chapters:
        return []
    lessons_res = (
        _supa()
        .table("lessons")
        .select("id,chapter_id,title,order_index,learning_objectives,duration_min")
        .in_("chapter_id", [c["id"] for c in chapters])
        .order("order_index", desc=False)
        .execute()
    )
    out: list[dict[str, Any]] = []
    for lesson in lessons_res.data or []:
        out.append(
            {
                **lesson,
                "chapter_title": chapter_titles.get(lesson["chapter_id"], ""),
                "chapter_order_index": chapter_orders.get(lesson["chapter_id"], 0),
            }
        )
    # Group by chapter order, then by lesson order — same display order
    # the syllabus tree uses on the FE.
    out.sort(key=lambda x: (x["chapter_order_index"], x["order_index"]))
    return out


@mcp.tool()
def get_lesson(lesson_id: str) -> dict[str, Any] | None:
    """Fetch a single lesson row including the markdown `content` body.

    Returns None when no lesson with that id exists (e.g. the agent
    hallucinated a uuid). The agent prompt is told to treat None as a
    signal to fall back to a different lesson rather than fabricating
    content.
    """
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


# ─── Write tools (deep-agent supervisor + writer subagents) ─────────


@mcp.tool()
def get_syllabus(syllabus_id: str) -> dict[str, Any] | None:
    """Fetch a single syllabus row by id, including the pedagogical
    contract columns (audience / scope / pedagogy) the deep-agent
    supervisor populates on create.

    Returns None when no row exists. Used by the deep-agent supervisor
    after `create_syllabus` to verify the row landed (and by the
    writer subagent to read the audience profile back when the
    supervisor's task description didn't carry it inline).
    """
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


@mcp.tool()
def create_syllabus(
    thread_id: str,
    title: str,
    description: str = "",
    audience: dict[str, Any] | None = None,
    scope: dict[str, Any] | None = None,
    pedagogy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Create a syllabus row attached to a thread.

    Args:
        thread_id: UUID of the deep-agent thread the syllabus belongs to.
        title: Course title (required, non-empty).
        description: Short paragraph summarising the syllabus (optional).
        audience: Optional pedagogical-contract object with shape
            ``{level, prior_knowledge: list[str], language}`` —
            ``level`` is one of ``school|undergrad|grad|professional``.
        scope: Optional ``{duration_hours, target_outcome, constraints: list[str]}``.
        pedagogy: Optional ``{style, assessment, differentiation: bool}``.

    Returns the inserted row (``{id, thread_id, title, ...}``). The id
    is the value the deep-agent supervisor embeds in the artifact card
    tag at the end of the run.
    """
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
    res = (
        _supa()
        .table("syllabuses")
        .insert(payload)
        .execute()
    )
    rows = list(res.data or [])
    if not rows:
        # PostgREST returns an empty data array on insert when the row
        # was rejected by RLS / a constraint without raising; surface
        # that as an explicit error so the agent retries instead of
        # silently moving on with a None id.
        raise RuntimeError(
            "create_syllabus insert returned no row — "
            "check the thread exists and service-role can write to syllabuses."
        )
    return rows[0]


@mcp.tool()
def create_chapter(
    syllabus_id: str,
    title: str,
    order_index: int,
    outcomes: list[str] | None = None,
    prerequisites: list[str] | None = None,
) -> dict[str, Any]:
    """Create a chapter row under a syllabus.

    Args:
        syllabus_id: Parent syllabus UUID (returned by ``create_syllabus``).
        title: Chapter title (required).
        order_index: 0-based position in the chapter list (the FE
            renders chapters sorted by this column).
        outcomes: Optional list of chapter-level "students will be able
            to..." statements.
        prerequisites: Optional list of prior-knowledge strings.

    Returns the inserted row (``{id, syllabus_id, title, order_index, ...}``).
    Callers MUST run ``list_chapters(syllabus_id)`` before this tool
    when there is any chance the chapter already exists (e.g. on a
    retry of a previously-completed writer task) — duplicates are not
    deduplicated server-side.
    """
    payload: dict[str, Any] = {
        "syllabus_id": syllabus_id,
        "title": title,
        "order_index": order_index,
    }
    if outcomes is not None:
        payload["outcomes"] = outcomes
    if prerequisites is not None:
        payload["prerequisites"] = prerequisites
    res = (
        _supa()
        .table("chapters")
        .insert(payload)
        .execute()
    )
    rows = list(res.data or [])
    if not rows:
        raise RuntimeError(
            "create_chapter insert returned no row — "
            "check the syllabus exists and service-role can write to chapters."
        )
    return rows[0]


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
    """Create a lesson row under a chapter.

    Args:
        chapter_id: Parent chapter UUID (returned by ``create_chapter``).
        title: Lesson title (required).
        content: Markdown body of the lesson. Should follow the
            standard MPFE lesson sections (Overview / Learning
            objectives / Concepts / Worked example / Assessment).
        order_index: 0-based position within the chapter.
        learning_objectives: Optional list of ``{text, bloom_level}``.
        prerequisites: Optional list of prior-knowledge strings.
        key_terms: Optional list of glossary terms.
        worked_example_seed: Short seed prompt the FE uses to generate
            additional worked examples on demand.
        assessment_idea: One-line summative assessment hook.
        duration_min: Suggested duration in minutes (>=0).
        bloom_level: Aggregate Bloom level for the lesson, one of
            ``remember|understand|apply|analyze|evaluate|create``.

    Returns the inserted row. Callers MUST run ``list_lessons(chapter_id)``
    before this tool when retrying — there is no server-side dedupe.
    """
    payload: dict[str, Any] = {
        "chapter_id": chapter_id,
        "title": title,
        "content": content,
        "order_index": order_index,
        "worked_example_seed": worked_example_seed,
        "assessment_idea": assessment_idea,
        "duration_min": duration_min,
    }
    if learning_objectives is not None:
        payload["learning_objectives"] = learning_objectives
    if prerequisites is not None:
        payload["prerequisites"] = prerequisites
    if key_terms is not None:
        payload["key_terms"] = key_terms
    if bloom_level is not None:
        payload["bloom_level"] = bloom_level
    res = (
        _supa()
        .table("lessons")
        .insert(payload)
        .execute()
    )
    rows = list(res.data or [])
    if not rows:
        raise RuntimeError(
            "create_lesson insert returned no row — "
            "check the chapter exists and service-role can write to lessons."
        )
    return rows[0]


@mcp.tool()
def create_activity(
    thread_id: str,
    title: str,
    mcqs: list[dict[str, Any]],
    short_answers: list[dict[str, Any]] | None = None,
    worked_example: dict[str, Any] | None = None,
    intro: str = "",
    lesson_id: str | None = None,
    lesson_title: str = "",
    prompt: str = "",
    kind: str = "worksheet",
) -> dict[str, Any]:
    """Create a worksheet-shaped activity row attached to a thread.

    Used by the deep-agent ``activity_maker`` subagent to persist a
    standalone or lesson-grounded worksheet. The row's ``content``
    JSONB is a ``Worksheet`` (see ``packages/shared/src/index.ts``):

    .. code-block:: json

        {
          "title": "...",
          "intro": "...",
          "mcqs": [
            {"question": "...", "options": ["A","B","C","D"],
             "correct_index": 0, "explanation": "..."}, ...
          ],
          "short_answers": [
            {"prompt": "...", "model_answer": "..."}, ...
          ],
          "worked_example": {
            "prompt": "...", "steps": ["..."], "final_answer": "..."
          }
        }

    Args:
        thread_id: UUID of the deep-agent thread the activity belongs to.
        title: Worksheet title (required, non-empty). Stored inside the
            ``content`` JSON; the FE renders this at the top of the card.
        mcqs: List of MCQ dicts. Each MCQ MUST have ``question``,
            ``options`` (exactly 4 strings), ``correct_index``
            (0..3), and an ``explanation``. The shared ``Worksheet``
            schema rejects fewer than 1 MCQ or more than 8.
        short_answers: Optional list of short-answer dicts, each
            ``{prompt, model_answer}``. Up to 3.
        worked_example: Optional ``{prompt, steps[], final_answer}``.
            Pass ``None`` (or an object with empty ``steps``) when the
            worksheet does not include a worked example.
        intro: Optional one-line orientation paragraph shown above the
            MCQs.
        lesson_id: Optional UUID of the lesson this worksheet grounds
            in. ``None`` for standalone worksheets that do not bind to
            an existing lesson.
        lesson_title: Denormalised lesson / topic title for the FE
            card label. Defaults to ``title`` when not supplied so the
            card always has something to display.
        prompt: The user request that produced this activity (for
            display under the card).
        kind: Discriminator. Only ``"worksheet"`` is rendered today;
            future kinds (``quiz``, ``flashcards``) drop in without a
            schema migration but will not render until the FE knows
            about them.

    Returns the inserted row, including the generated ``id`` the
    deep-agent supervisor embeds in the
    ``<artifact kind="worksheet" id="…" />`` card it writes back to
    the chat.
    """
    label = lesson_title or title
    we = worked_example or {"prompt": "", "steps": [], "final_answer": ""}
    content = {
        "title": title,
        "intro": intro,
        "mcqs": mcqs,
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
        "prompt": prompt or title,
        "lesson_title": label,
        "content": content,
    }
    if lesson_id is not None:
        payload["lesson_id"] = lesson_id
    res = (
        _supa()
        .table("activities")
        .insert(payload)
        .execute()
    )
    rows = list(res.data or [])
    if not rows:
        raise RuntimeError(
            "create_activity insert returned no row — "
            "check the thread exists and service-role can write to activities."
        )
    return rows[0]


def main() -> None:
    """Entry point. Runs the MCP server on the configured transport.

    Default is stdio (used when the API spawns this server as a child
    process). Set `MCP_TRANSPORT=streamable-http` to expose the server
    over HTTP — used by the Railway deployment, where the API connects
    to the private domain `${{mcp-supabase.RAILWAY_PRIVATE_DOMAIN}}:$PORT/mcp`.
    """
    if _TRANSPORT in {"streamable-http", "streamable_http", "http"}:
        mcp.run(transport="streamable-http")
    elif _TRANSPORT == "sse":
        mcp.run(transport="sse")
    else:
        mcp.run()


if __name__ == "__main__":
    main()

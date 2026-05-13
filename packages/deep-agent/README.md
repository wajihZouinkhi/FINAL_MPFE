# @mpfe/deep-agent

Workspace package hosting FINAL_MPFE's **deep-agent**: a generalist
supervisor + four ReAct specialist subagents (`pedagogy_planner`,
`writer`, `activity_maker`, `pedagogy_critic`) that collaborate over
a shared VFS. The supervisor decides at runtime which specialist
each user request needs — building a syllabus, making a worksheet,
critiquing an existing artefact, or just answering a pedagogical
question.

This package is the *only* place in the monorepo that pulls in the
v1 LangChain family (`@langchain/core@1.x`, `@langchain/langgraph@1.x`,
`langchain@1.x`, `zod@4`). Every other workspace stays on the v0.3
family. The api app consumes the deep-agent through a plain TS public
API — no v1 langchain types leak across the boundary.

## What lives here

| File | Role |
| --- | --- |
| `src/runner.ts` | Builds and streams the deepagents agent. Wires MCP tools, Serper tools, the four subagents, and the Postgres checkpointer. Exposes `createDeepAgentRunner(...)`. |
| `src/mcp.ts` | Connects to the `mpfe-mcp-supabase` MCP server (HTTP or stdio), enumerates tools, wraps each as a v1 langchain `tool()` instance. Supplies `pickMcpTools(byName, names)` for per-subagent slicing. |
| `src/serper.ts` | `web_search` + `web_fetch` for the pedagogy_planner. Returns `[]` if no `SERPER_API_KEY` is configured (planner falls back to LLM-only mode). |
| `src/prompts/supervisor.ts` | Supervisor system prompt factory. Capability-based: documents four capabilities (build syllabus / make activity / critique / just answer) and the golden five-piece task description rule. |
| `src/prompts/pedagogy-planner.ts` | Pedagogy planner prompt factory. Curriculum-designer persona, exact `/pedagogy_plan.md` schema, Bloom discipline. Conditionally mentions Serper based on a `hasSearch` flag. |
| `src/prompts/writer.ts` | Writer prompt factory. Idempotency rules (list-before-create), lesson markdown structure, audience-calibrated word counts. |
| `src/prompts/activity-maker.ts` | Activity maker prompt factory. Worksheet shape (1–8 MCQs / 0–3 short answers / optional worked example), grounded vs. standalone flavours, Bloom calibration. |
| `src/prompts/pedagogy-critic.ts` | Pedagogy critic prompt factory. Severity vocabulary (block / revise / polish), critique file format, checklist (LO alignment, Bloom progression, prerequisite chain, grounding, language, quality, polish). |
| `src/index.ts` | Public API — types and `createDeepAgentRunner`. |

## Subagent layout

```
supervisor                       MCP read + create_syllabus
 │
 ├── task(pedagogy_planner) ──→  Serper (optional) + VFS
 │                                writes /pedagogy_plan.md
 │
 ├── task(writer, per chapter) ──→ MCP read + create_chapter + create_lesson
 │                                  mirrors each lesson to /lessons/<id>.md
 │
 ├── task(activity_maker) ──→     MCP read (incl. get_lesson) + create_activity
 │                                  mirrors worksheet to /activities/<id>.json
 │
 └── task(pedagogy_critic) ──→    MCP read only
                                   writes /critiques/<target>.md
```

The supervisor is a generalist conductor — its prompt teaches it to
read the user's request and dispatch one of these specialists (or
several in sequence in the same chat). It is the only agent allowed
to call `create_syllabus` (so the syllabus id authority is owned in
one place); only `writer` calls `create_chapter` / `create_lesson`;
only `activity_maker` calls `create_activity`. The pedagogy_planner
and pedagogy_critic are intentionally read-only on the database side.

The writer and activity_maker mirror their persisted output to the
VFS so the supervisor (and a follow-up critic, if dispatched) can
inspect what landed without an extra DB round-trip.

## How the api wires it

`apps/api/src/agents-v2/deepagent.service.ts`:

- Reads `SUPABASE_DB_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `SERPER_API_KEY` (optional), and `MCP_SUPABASE_URL` (optional) from
  the validated `AppConfigService`.
- Calls `createDeepAgentRunner({ model, checkpointerConfig, mcp,
  serperApiKey })` once at module init.
- If `MCP_SUPABASE_URL` is set, the runner connects over
  streamable-http; otherwise it spawns the `mpfe-mcp-supabase` server
  as a stdio child (see `apps/mcp-supabase/`).
- Calls `runner.close()` on module destroy to drain the MCP child
  process and the Postgres checkpointer.

The runner is fault-tolerant: if MCP startup fails the supervisor
boots without database tools and refuses to build a syllabus or an
activity rather than crashing the api process.

## Architecture notes

- **Capability-based supervisor.** The supervisor does NOT assume
  the user wants a syllabus. Each turn it reads the user's request
  and maps it to one of four capabilities — A (build syllabus), B
  (make activity), C (critique), D (just answer). Multiple
  capabilities can compose in one chat (e.g. "build me a syllabus
  on graph theory then a worksheet for chapter 2 lesson 1" → A → B).
- **Lesson-grounded vs. standalone activities.** When the user asks
  for a worksheet, the supervisor decides whether to bind to an
  existing lesson (`lesson_id` passed to `activity_maker`, which
  fetches the lesson body via `get_lesson` for grounding) or to
  generate standalone (no lesson binding, generated from topic +
  audience). Both flavours persist via `create_activity` and embed
  an `<artifact kind="worksheet" />` chip.
- **Critique is a tool, not a gate.** The supervisor dispatches the
  pedagogy_critic when the user explicitly asks ("review chapter 3")
  OR when it suspects quality issues OR not at all. There is no
  automatic critique step after every writer dispatch.
- **VFS path discipline** is part of the contract. Every prompt
  hard-codes the same paths (`/user_profile.md`,
  `/pedagogy_plan.md`, `/lessons/<lesson_id>.md`,
  `/activities/<activity_id>.json`,
  `/critiques/<target>.md`). Changing a path silently breaks one
  agent's ability to read what another wrote.
- **Thread-id injection.** The supervisor's prompt includes a
  thread-specific footer (`supervisorThreadContext(threadId)`) so the
  model knows the exact value to pass into `create_syllabus` /
  `create_activity`. We rebuild the agent per-stream because of this
  — cheap (no I/O), and the checkpointer + MCP client are reused
  across rebuilds.
- **`general-purpose` subagent**: deepagents@1.9 unconditionally
  prepends the catch-all `GENERAL_PURPOSE_SUBAGENT` to the
  `subagents` array unless an entry with that name is already
  present. The `generalPurposeAgent: false` option exists only on
  `createSubAgentMiddleware`, not on `createDeepAgent`. Our supervisor
  prompt enumerates the four specialists explicitly so this is a
  non-issue in practice; if needed we'll override with a stubbed
  `name: "general-purpose"` entry.

## Streaming chunks (canvas wire shape)

The runner exposes a discriminated union of `DeepAgentChunk`s. The
api's chat controller bridges them into Vercel AI SDK v5 wire frames.
Three chunk kinds drive the deep-agent canvas pane in the frontend:

- **`files-update`** — emitted whenever the LangGraph `updates` stream
  surfaces a `state.files` delta. Payload: a `Record<path, string |
  null>` (null content = delete) and an optional `subagentCallId`
  attribution when the write was made by a subagent. The api forwards
  this verbatim as a `vfs_update` data part.
- **Subagent runs** — the api derives a `subagent_run` data part from
  task() start (`status: "running"`) and task() end (`status: "ok"` /
  `"error"`) events keyed by the supervisor's tool_call_id. The
  payload includes the supervisor's full task description (verbatim,
  not the chip preview), the subagent name, the synthesised final
  output, and a wall-clock duration. Persisted to the durable event
  log so a reload replays the per-call snapshots in chronological
  order.
- **Subagent text deltas** — `text-delta` chunks where `source ===
  "subagent"` carry per-token thinking from the subagent's LLM call.
  The api routes them as `subagent_text_delta` data parts keyed by
  the parent supervisor's `subagentCallId`. They feed the canvas
  Subagents row's live preview and are deliberately NOT added to
  the supervisor's `assistantTextBuf` — the chat stream stays
  supervisor-only. Persisted to Redis Streams (so post-disconnect
  resume picks the live buffer back up) but NOT to the durable event
  log: the canvas hydrates each row's final answer from the
  `subagent_run` snapshot on reload, so per-token deltas would be
  pure write amplification.

All three kinds participate in the same Redis Streams resume protocol
as every other slice — follower tabs and post-disconnect resume see
them through `GET /chat/:threadId/stream?lastId=…`.

## Public docs

End-user-facing description lives in the running app at
`/docs/agents/deepagent` (source: `apps/web/app/docs/agents/deepagent/page.tsx`).
The cross-cutting architecture overview is in `docs/architecture.md`.

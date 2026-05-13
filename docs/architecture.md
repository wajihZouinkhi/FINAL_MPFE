# Architecture

> Living doc. Last revised after PR #91 (Vercel AI SDK v4 → v5
> migration). Anything that crosses the wire — typed slices, SSE
> framing, persistence keys — is described here. The deep
> agent-internal flow lives under `/docs/agents/<slug>` in the running
> app (`apps/web/app/docs/agents/...`).

## Monorepo

- `apps/api` — NestJS server hosting the three legacy LangGraph agents (syllabus-generator, activity-generator-tooled, activity-generator-toolless), the deepagents-based deep-agent (via `@mpfe/deep-agent`), and a thin REST surface for both.
- `apps/web` — Next.js (App Router) workspace. Two-pane layout for syllabus threads, four-pane workbench layout for activity threads.
- `apps/mcp-supabase` — Python (FastMCP) MCP server giving the activity-tooled agent grounded read access and the deep-agent supervisor + four specialist subagents read + write access to syllabuses / chapters / lessons / activities via the service-role Supabase client. Connects over stdio (local) or streamable-http (Railway).
- `packages/deep-agent` — workspace package isolating the v1 LangChain family (`@langchain/core@1.x`, `@langchain/langgraph@1.x`, `langchain@1.x`, `zod@4`) from the rest of the api. Hosts the deepagents-based supervisor + four specialist subagent runners, the MCP client wrapper, the Serper search tools, and the five system prompts (supervisor + pedagogy_planner + writer + activity_maker + pedagogy_critic). The api app consumes it through a plain TS public API — no v1 langchain types leak across the boundary.
- `packages/shared` — Zod schemas + the typed `UIMessage` / `DataPart` union that crosses the wire. Anything that crosses must be defined here first.
- `db/migrations` — raw SQL applied to Supabase via the Management API.

Workspace tool: pnpm. TypeScript everywhere. No Turborepo — `pnpm -r` is sufficient.

## Backend (`apps/api`)

```
main.ts
└── AppModule
    ├── AppConfigModule        (Zod-validated env, fail-fast at boot)
    │     ├── AppConfigService    — Supabase / Redis / API config
    │     └── LlmConfigService    — four OpenAI-compatible tiers
    ├── SupabaseModule         (service-role client, server-only)
    ├── CacheModule            (ioredis wrapper, TTL'd ephemeral)
    ├── RedisStreamModule      (per-run event log: XADD / XREAD BLOCK / XRANGE)
    ├── AgentRunsModule        (run lifecycle row + reaper)
    ├── GraphModule            (compiled LangGraph + checkpointer — legacy agents)
    ├── AgentsV2Module         (DeepAgentService — wraps `@mpfe/deep-agent` runner; built lazily by ChatModule)
    ├── ThreadsModule          (POST /api/threads, GET /api/threads/:id/snapshot, GET /api/threads/:id/stream)
    ├── ChatModule             (POST /api/chat/:threadId — routes by AgentKind to GraphModule or AgentsV2Module)
    └── McpModule              (stdio transport to apps/mcp-supabase, used by activity-tooled; deep-agent has its own MCP client in @mpfe/deep-agent)
```

### LLM tiers

Four OpenAI-compatible endpoints, each with its own `API_KEY / BASE_URL / MODEL`:

| Tier        | Used by                                                    |
|-------------|------------------------------------------------------------|
| supervisor  | Router, summariser, classifier (high reasoning)            |
| writer      | Lesson generation, search synthesis, worksheet generation  |
| critic      | Critic-loop only — optional, falls back to `utility` (audit §2.4 / PR #74)
| utility     | Picker, language detection, classifications (fast / cheap) |

Boot fails if any of the required vars are missing. `CRITIC_LLM_*` is
optional: if absent the critic uses the utility tier — which is what
the audit recommended after measuring critic was the dominant
supervisor-tier consumer. Use `llmConfig.get('writer')` to obtain a
fresh `ChatOpenAI`.

### Agents

Four agents are wired:

- **syllabus-generator** — supervisor router → `search` subgraph (per-topic Serper → picker → scraper → summarizer, fanned out via LangGraph `Send` since PR #73) → `command` subgraph (single-shot writer / critic gate with Redis-rehydrated drafts, SEARCH/REPLACE patches, severity-aware critic gate — critic runs at most once per lesson; on failure the writer revises once and the lesson commits as accepted with the critic's findings dropped silently — zero trace). Writes run in topologically-scheduled waves: each `command_write_one` invocation finds every lesson whose `depends_on` set is already in `committed_lesson_ids` and runs them in parallel, so chapters and the lessons inside them write concurrently unless an explicit dep forces ordering. Public docs at `/docs/agents/syllabus-generator`.
- **activity-generator-tooled** — bound to a syllabus thread. Uses MCP (`apps/mcp-supabase`, fastmcp + supabase-py over stdio) to read chapters / lessons, then produces a structured `Worksheet` JSON grounded in actual course material. Public docs at `/docs/agents/activity-generator-tooled`.
- **activity-generator-toolless** — same wire shape as tooled but with no MCP grounding. Side-by-side baseline. `/docs/agents/activity-generator-toolless`.
- **deep-agent** — generalist supervisor + four ReAct specialist subagents (`pedagogy_planner`, `writer`, `activity_maker`, `pedagogy_critic`) built on `deepagents@1.9` (LangGraph v1 family, isolated in `packages/deep-agent`). The supervisor reads each user request and decides at runtime which capability fits — building a syllabus (planner → writer × N → `<artifact kind="syllabus" />` card), making a worksheet (activity_maker → `<artifact kind="worksheet" />` card; lesson-grounded or standalone), critiquing an existing artefact (pedagogy_critic returning severity-tagged findings), or just answering a pedagogical question. Subagents share a VFS (`/user_profile.md`, `/pedagogy_plan.md`, `/lessons/<id>.md`, `/activities/<id>.json`, `/critiques/<target>.md`) and access Supabase via the same MCP server (extended with `create_syllabus` / `create_chapter` / `create_lesson` / `create_activity` write tools, scoped per-subagent). The thread view is two-pane: chat on the left and a live canvas on the right (`Files` + `Subagents` tabs) hydrated from the runner's `vfs_update`, `subagent_run`, and `subagent_text_delta` slices. The first two replay from the durable event log on reload; `subagent_text_delta` (per-token subagent thinking) lives in Redis Streams only and is replaced on reload by the row's final synthesised output. Public docs at `/docs/agents/deepagent`.

The first three agents share a supervisor-router LangGraph pattern.
The deep-agent uses the deepagents library's supervisor-worker
pattern with the `task` tool for delegation; per-agent topology,
why-not-ReAct, critic-gate semantics, patch applier, and Redis
rehydration are documented in the running app under
`/docs/agents/<slug>`.

### LangGraph state

Wire-visible pieces are defined in `packages/shared/src/index.ts`:

```ts
{
  messages: BaseMessage[],          // Langchain history
  ui_state: UiState,                // typed slices, defined below
  draft_cache_ids: Record<lessonId, redisKey>,
  search_plan_internal: { goal, candidates[] } | null,
  research_anchor_msg_index: number | null,
  todo_anchor_msg_index: number | null,
  command_just_finalized: boolean,
}
```

Discipline: heavy text (lesson markdown, scraped HTML, full chapter
context) lives in Redis or Supabase, keyed by stable IDs in state. The
checkpointer must stay small — the audit §2.6 / §3 finding from
post-PR#69 work.

### Checkpointer

`PostgresSaver.fromConnString(SUPABASE_DB_URL)` with `setup()` on
boot. Falls back to `MemorySaver` with a warning if the connection
fails — useful in local dev without Supabase configured. Real demo
runs must use Postgres so reload-mid-generation resumes.

### Streaming protocol — Vercel AI SDK v5 UI Message Stream (post PR #91)

The wire is **Vercel AI SDK v5 UI Message Stream**: SSE with typed
JSON frames, NOT the v4 line-prefixed Data Stream Protocol. Two
endpoints emit it:

| Endpoint                                | Producer              | Consumer                                               |
|-----------------------------------------|-----------------------|--------------------------------------------------------|
| `POST /api/chat/:threadId`              | one-shot run driver   | `useChat` from `@ai-sdk/react` v5 via `DefaultChatTransport` |
| `GET  /api/threads/:id/stream?after=…`  | Redis-replay endpoint | the custom `agent-run-realtime.ts` hook (cross-tab + reload) |

**Headers (both endpoints):**

```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
x-vercel-ai-ui-message-stream: v1
```

**Frame shape:** every frame is `data: <json>\n\n`. Stream terminates
with the literal `data: [DONE]\n\n` line. The v5 client uses `[DONE]`
— and only `[DONE]` — to decide the producer has closed; if it never
arrives the FE's `useChat` status lingers on `'streaming'` until the
TCP socket physically dies. Both endpoints' error paths now emit a
`finish` chunk + `[DONE]` (PR #91 commit `25e47c6`).

**Frame types we emit:**

| Frame                                           | When                                         |
|-------------------------------------------------|----------------------------------------------|
| `{ type:"start", messageId }`                   | first frame (opens the assistant message)    |
| `{ type:"text-start", id }`                     | once per text block                          |
| `{ type:"text-delta", id, delta }`              | per LLM token (live token streaming)         |
| `{ type:"text-end", id }`                       | end of text block                            |
| `{ type:"data-<kind>", data, transient:true }`  | for every typed slice (see `DataPart` below) |
| `{ type:"error", errorText }`                   | error path before `finish`                   |
| `{ type:"finish", finishReason }`               | terminal lifecycle frame                     |
| `[DONE]` (literal, not JSON)                    | SSE terminator                               |

LangGraph events forwarded to the wire are an **allow-list**:
`on_chain_end` events whose output contains `ui_state` become
`data-<kind>` frames; `on_chat_model_stream` events become
`text-delta` frames after the live-token-streaming work landed in PR
#86–#89. Tool calls and tool messages are **never** forwarded.

#### Typed data-part slices

Defined in `packages/shared/src/index.ts` as a `DataPart`
discriminated union over `kind`. Current set (PR #91 ↑):

| `kind`                       | Carries                                                             |
|------------------------------|---------------------------------------------------------------------|
| `phase`                      | `AgentPhase` enum (idle / researching / planning / writing / done)  |
| `research_plan`              | `ResearchPlan` — topics + per-topic substep + sources (PR #76)      |
| `todo_plan`                  | `TodoPlan` — chapter / lesson list with statuses                    |
| `manifest`                   | per-lesson writer / critic state (`pending → writing → critique → accepted / force_passed / failed`) |
| `activity_manifest`          | activity-agent worksheet manifest                                   |
| `activity_tool_calls`        | timeline of MCP tool calls (PR #65)                                 |
| `activity_progress`          | activity-agent live progress (PR #85)                               |
| `activity_worksheets`        | committed worksheets for the workbench tab                          |
| `interrupt`                  | active interrupt (`ask` / `intake_form` / `activity_intake`)        |
| `interrupt_history`          | resolved interrupts, used to render "[Intake] …" answers inline     |
| `run`                        | current `agent_runs` row snapshot                                   |
| `research_anchor_msg_index`  | server-authoritative anchor for the ResearchCard (PR #41)           |
| `todo_anchor_msg_index`      | server-authoritative anchor for the TodoCard (PR #41)               |

In addition the wire carries two **transport-only** kinds emitted as
`data-_keepalive` and `data-_cursor` with `transient:true`. Neither
ever lands in `messages[].parts`; they're consumed by the realtime
hook for liveness + cursor bookkeeping.

All typed slices are sent with `transient:true` — they're delivered
to the FE via `useChat`'s `onData(chunk)` callback (chat-pane.tsx
~line 272) and routed to a Zustand store keyed by `kind`. The FE
keeps the latest snapshot per kind; we never send partial patches.

#### Wire-ordering contract — `run → done → finalize`

Three lifecycle markers must arrive in order on both the local
socket and the Redis stream (`apps/api/src/chat/chat.controller.ts`
~lines 903–930):

1. The terminal `data-run` slice (with `status: completed | paused`).
2. The Redis `done` marker (`runStream.append(runId, "done", ...)`).
3. The Redis `finalize` marker (`runStream.finalize(runId)`).

`writer.finish()` (which emits `finish` + `[DONE]`) MUST run AFTER
this block, because v5's writer flips an internal `finished = true`
flag on `finish()` and any subsequent `data()` call becomes a silent
no-op. PR #91 commit `f05acc9` is the regression fix for this exact
ordering.

### Cross-tab + reload resume

The driving tab gets the live stream from `POST /api/chat/:threadId`.
**Every other tab** (and the same tab on reload) gets state from two
sources:

1. `GET /api/threads/:id/snapshot` — DB-committed state at the
   moment of the request (typed `UiState`, full message history,
   resolved interrupts, anchor indices, agent-runs row).
2. `GET /api/threads/:id/stream?after=<lastId>` — Redis-stream
   replay using `XRANGE` from a stored `lastId` (in
   `sessionStorage`), then `XREAD BLOCK` for live tail. Same v5 SSE
   wire format as POST.

Stream keys are `run:<runId>:events`. They live for 24 h after the
run terminates. The reaper (a background worker, audit §2 / PR #28)
flips a `running` `agent_runs` row to `failed` when its
`last_heartbeat` is older than 30 s and writes a synthetic `error`
entry to the run's stream — that's how the FE distinguishes "still
streaming" from "process died" without polling.

## Frontend (`apps/web`)

- `/` — landing page; creates a new thread and routes to `/threads/[id]`.
- `/threads` — paginated thread index with agent tab + status filter + ETag-cached polling (PR #79).
- `/threads/[id]` — agent-aware layout:
  - **Syllabus thread**: two-pane (chat ~35% | viewer ~65%).
  - **Activity thread**: four-pane workbench (chat | tool-call timeline | worksheet workbench | tab-switcher; mobile parity TBD per audit §5).
- `/docs` → `/docs/agents` — public per-agent doc pages with mermaid topology diagrams + Pedagogy / Critic / Patch demos.

`useChat` is wired to `POST /api/chat/:threadId` via
`DefaultChatTransport` (v5). Typed slices land in Zustand via the
`onData` callback. Cards (Research / Todo / Worksheet / Resolved-Ask)
are anchored to server-authoritative message indices (PR #41), so
reload places them under the same chat bubble that triggered them.

## Database (Supabase)

Schema in `db/migrations/`. Notable tables:

- `threads` — agent + status + cursor pagination index.
- `syllabuses`, `chapters`, `lessons` — durable accepted-only ledger.
- `activities` (defined in `0007_agents_and_activities.sql`) — committed worksheets.
- `agent_runs` — run lifecycle (status, last_heartbeat, finalized markers, anchor indices) consumed by the FE for the persistent agent-presence indicator.
- `agent_run_events` — per-run event log mirror (Redis is primary; Postgres is durable).

Realtime publication enabled on `syllabuses` / `chapters` / `lessons`
/ `agent_runs`. Apply migrations with `pnpm db:push` (uses
`SUPABASE_MANAGEMENT_PAT` + `SUPABASE_PROJECT_REF`).

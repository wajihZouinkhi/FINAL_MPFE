# Integrating FINAL_MPFE into your application

FINAL_MPFE exposes the deep-agent + MCP stack as a **standalone HTTP service** another application can drive via REST + SSE. This document is the contract for that integration: every endpoint, every wire shape, every auth knob, and a runnable smoke test.

If you're operating the deployment itself (rotating tokens, redeploying Railway services, tailing logs), see the per-session deployment handoff doc (kept separately because it contains live credentials).

---

## 1. Surface area

Live URLs (production):

| Surface | URL |
|---|---|
| API health | <https://api-production-6862.up.railway.app/health> |
| API root | `https://api-production-6862.up.railway.app/` |

There are **two** kinds of endpoints exposed by the api:

1. **Legacy chat-driven flow** — `POST /api/chat/:threadId` with the Vercel AI SDK v5 UI Message Stream. Still the primary surface for the in-tree web UI.
2. **`name first, generate second` flow** *(new — added by the Syllabus → Unity → Activity refactor)* — `POST /api/{syllabuses,unities,activities}` create the row, then `POST /api/.../:id/generate` streams the deep-agent's pass scoped to that entity over bare-bones SSE.

This document focuses on flow #2 — that's what's intended for headless consumers (other apps, scripted tools, CI). Flow #1 is documented inline in `apps/api/src/chat/chat.controller.ts` and `apps/web/src/lib/api.ts`.

---

## 2. Entity model

```
Thread ──┐
         │
         └──> Syllabus ──> Unity ──> Activity
                                       ├── body         (markdown "cours")
                                       └── worksheet    (jsonb questions)
```

Notes:

- A **Syllabus** is the top-level course definition. It carries `title`, `description`, `audience`, `scope`, `pedagogy` JSON columns.
- A **Unity** (post-rename of the legacy "chapter") groups activities under a syllabus.
- An **Activity** is the smallest deliverable unit. The merged shape carries **both** the markdown cours (in `body`) **and** the worksheet (in `worksheet`, jsonb). The legacy `lessons` table is kept around for one release for back-compat and is not used by the new endpoints.
- A `chapters` PostgREST view aliases `unities` (migration 0016) so legacy reads against `public.chapters` continue to work.

Embeddings:

- Each activity is mirrored to `activity_embeddings(activity_id, syllabus_id, content_hash, embedding vector(384))`.
- The writer subagent calls `find_related_activities(syllabus_id, query_text)` before generating, threshold > 0.85 cosine → it produces complementary content instead of duplicates.
- Embeddings are scoped strictly by `syllabus_id`, so the same topic in two different syllabuses never leaks across.

---

## 3. Authentication

By default the api is **open** — no auth header required. Suitable for private network use (e.g. inside a Railway internal network) but not for the public Internet.

Optional bearer-token middleware: if the api service has the environment variable `API_AUTH_TOKEN` set to a non-empty string, every request to `/api/*` must carry `Authorization: Bearer <that-token>`. Requests without the header (or with a mismatched token) get a 401. The `/health` endpoint is always unauthenticated so liveness checks keep working.

To enable:

```bash
# On Railway (account #1, service `api`):
curl -X POST https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation U($i: VariableUpsertInput!) { variableUpsert(input: $i) }",
       "variables":{"i":{"projectId":"<project>","environmentId":"<env>","serviceId":"<api>","name":"API_AUTH_TOKEN","value":"<long-random>"}}}'

# Then trigger a redeploy.
```

CORS: the api accepts `Origin` from whatever is set in `API_CORS_ORIGIN` (string or comma-separated list). All `/api/*` endpoints return the appropriate `Access-Control-Allow-*` headers for `GET`, `POST`, `OPTIONS`.

---

## 4. Endpoints

All paths are relative to the api base. Bodies are JSON. Responses are JSON unless stated otherwise.

### 4.1 Syllabuses

```
POST   /api/syllabuses                  body { title, description?, thread_id? }
                                        -> 201 { id, title, thread_id }

POST   /api/syllabuses/:id/generate     -> SSE (Content-Type: text/event-stream)
                                        kicks off a deep-agent pass scoped to the syllabus

GET    /api/syllabuses/:id/snapshot     -> { thread_id, syllabus, chapters: [...] }
                                        (legacy shape, uses the `chapters` view alias)
```

Create example:

```bash
curl -X POST https://api-production-6862.up.railway.app/api/syllabuses \
  -H "Content-Type: application/json" \
  -d '{"title":"Intro to Algorithms","description":"CS101 grade 11"}'
# -> {"id":"<uuid>","title":"Intro to Algorithms","thread_id":null}
```

Generate example:

```bash
curl -N -X POST https://api-production-6862.up.railway.app/api/syllabuses/<id>/generate
# -> stream of `data: {...}\n\n` lines, terminated by `data: [DONE]\n\n`
```

### 4.2 Unities

```
POST   /api/unities                     body { syllabus_id, title, order_index? }
                                        -> 201 { id, syllabus_id, title }

POST   /api/unities/:id/generate        -> SSE
GET    /api/unities/:id                 -> { id, syllabus_id, title, order_index, outcomes, prerequisites }
```

### 4.3 Activities

```
POST   /api/activities                  body { unity_id, title, order_index? }
                                        -> 201 { id, unity_id, title }

POST   /api/activities/:id/generate     -> SSE
GET    /api/activities/:id              -> { id, thread_id, lesson_id, kind, prompt, lesson_title, content, ... }
```

### 4.4 Other read endpoints (legacy, still supported)

```
GET    /health                          -> { ok: true, ts }
GET    /api/threads                     -> paginated thread list
POST   /api/threads                     body { agent?, bound_syllabus_thread_id? } -> { id, agent, ... }
GET    /api/threads/:id/snapshot        -> SyllabusSnapshot
GET    /api/threads/:id/activities      -> activity feed for an activity-thread
POST   /api/chat/:threadId              -> Vercel AI SDK v5 UI Message Stream
GET    /api/chat/:threadId/stream       -> Redis replay of an in-flight run
POST   /api/chat/:threadId/cancel       -> cancel an in-flight run
```

---

## 5. SSE wire format

### 5.1 Bare-bones SSE (the new `/generate` endpoints)

Each line is a single `DeepAgentChunk` JSON-encoded as-is, framed as one SSE message. Example trace:

```
data: {"type":"start","thread_id":"<id>"}

data: {"type":"text-delta","content":"Planning the syllabus..."}

data: {"type":"tool-start","tool":"list_unities","args":{"syllabus_id":"<id>"}}

data: {"type":"tool-end","tool":"list_unities","ok":true,"result":[]}

data: {"type":"files-update","files":{"/pedagogy_plan.md":"..."}}

data: {"type":"done","ok":true}

data: [DONE]
```

Types you can expect (see `packages/deep-agent/src/types.ts` for the canonical definitions):

| `type` | Meaning |
|---|---|
| `start` | Run started; the runner's checkpointer is in scope. |
| `text-delta` | A token of the supervisor's reply. |
| `tool-start` | A subagent or MCP tool call kicked off. |
| `tool-end` | The matching tool call completed (or errored). |
| `files-update` | The deep-agent's virtual filesystem changed. |
| `error` | A run-level error. |
| `done` | The run reached a terminal state. |

The stream ends with the literal sentinel `data: [DONE]\n\n`. Clients should treat that as the end-of-stream marker, NOT EOF on the TCP connection (the api may keep the socket open for HTTP keepalive).

### 5.2 Vercel AI SDK v5 UI Message Stream (the legacy chat endpoint)

`POST /api/chat/:threadId` returns the full v5 UI Message Stream as documented at <https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol#ui-message-stream>. See `apps/api/src/chat/data-stream.ts` for the writer used by the api.

The two streams carry *the same information* — they're different framings of the same underlying `DeepAgentChunk` source. Pick whichever fits your client library: SDK-driven UIs (Vercel `useChat`) want flow #1; bare CLI / headless consumers want flow #2.

---

## 6. Lifecycle

Each `/generate` call:

1. Resolves the entity's parents (syllabus_id, thread_id if any).
2. Synthesises an internal user message for the deep-agent supervisor scoped to the entity (e.g. "produce unities + activities for syllabus_id=…").
3. Streams the supervisor's run as SSE.
4. The runner persists checkpoints to Supabase (`deep_agent` schema) keyed by the entity_id (used as the synthetic thread_id when no real thread is bound). Subsequent calls to `/generate` on the same entity will resume from the latest checkpoint.

Cancellation: closing the TCP connection on the client side triggers `req.on("close")` server-side, which aborts the `AbortSignal` handed to the runner. The runner stops at the next checkpoint boundary.

---

## 7. Smoke test

`scripts/smoke-test.sh` exercises every CREATE endpoint and reads the result back:

```bash
API_BASE=https://api-production-6862.up.railway.app ./scripts/smoke-test.sh
```

Exits 0 on success. The `/generate` endpoints are *not* hit by the smoke test (they would burn LLM tokens on every run); test them manually with curl when needed.

---

## 8. Indexing verification

`scripts/indexing-verify.py` validates the pgvector anti-duplication path:

```bash
SUPABASE_DB_URL=postgresql://... python3 scripts/indexing-verify.py
```

Four cases (each pinned in the script):

1. INSERT activity → `activity_embeddings` row appears with the right `content_hash`.
2. Two activities in the same syllabus with overlapping topics → `find_related_activities` returns both.
3. Same topic in DIFFERENT syllabuses → scoping by `syllabus_id` excludes the other syllabus's row.
4. UPDATE an activity in place → embedding row upserts cleanly (still one row per activity_id).

The script bakes its own copy of the `all-MiniLM-L6-v2` encoder so it can run standalone; first invocation downloads ~90 MB.

---

## 9. Migrations

Forward-only, idempotent. The Syllabus → Unity → Activity refactor adds four migrations on top of the original twelve:

```
db/migrations/
  0013_rename_chapters_to_unities.sql        -- ALTER TABLE chapters RENAME TO unities
  0014_extend_activities_for_unities.sql     -- add unity_id, body, worksheet columns
  0015_enable_pgvector_and_embeddings.sql    -- CREATE EXTENSION vector + embedding tables
  0016_legacy_chapters_view.sql              -- CREATE VIEW chapters AS SELECT * FROM unities
```

Re-apply (idempotent) with the snippet documented in the deployment handoff doc.

---

## 10. Operational gotchas

- The mcp-supabase Docker image is ~+120 MB heavier than before because the sentence-transformers model is baked in at build time (avoids cold-start latency on the first embed call). Adjust the Railway plan if you're tight on image-size budget.
- Embedding generation is CPU-bound, NOT GPU. The mcp-supabase Railway service should be sized accordingly (1 vCPU is sufficient for the rates we see; ~50 ms/embedding).
- The legacy `lessons` table is intentionally kept for back-compat. Once you're certain no consumer reads from it any more, drop it with a `0017_drop_lessons.sql` migration. (We did NOT do this in the merge because the legacy `/api/chat` flow still touches it.)
- `NEXT_PUBLIC_*` env vars on the `web` service are baked at build time. Changing them requires a redeploy, not a restart.

---

## 11. Repo layout pointer

```
apps/
  api/                          NestJS — controllers above live in src/threads/
    src/threads/
      syllabuses.controller.ts    POST /api/syllabuses + /generate
      unities.controller.ts        POST /api/unities + /generate
      activities.controller.ts     POST /api/activities + /generate
      entities.service.ts          INSERT helpers
      scoped-generate.service.ts   SSE wrapper around DeepAgentService.stream
    src/agents-v2/
      deepagent.service.ts         exposes .stream(threadId, prompt, {signal})
  mcp-supabase/                  Python FastMCP — embedding tools live here
    src/mpfe_mcp_supabase/
      embeddings.py                  sentence-transformers loader + helpers
      server.py                       all MCP tools (renamed + the new embedding ones)
packages/
  deep-agent/                   TypeScript supervisor + 4 subagents
  shared/                       Zod schemas, wire types
db/migrations/                  Raw SQL, idempotent
scripts/
  smoke-test.sh                 §7
  indexing-verify.py            §8
```

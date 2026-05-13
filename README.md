# FINAL_MPFE — AI-Orchestrated Syllabus & Course Generator

Conversational ed-tech platform that generates and edits structured syllabuses through a supervisor-pattern LangGraph agent. Built as a `pnpm` monorepo:

```
apps/
  api/        # NestJS + LangGraph (supervisor / search / writer subgraphs)
  web/        # Next.js (App Router) — two-pane workspace UI
packages/
  shared/     # Zod schemas shared between api & web (ui_state, activities)
db/
  migrations/ # Raw SQL migrations applied via the Supabase Management API
```

## Quick start

```bash
# 1. Install
pnpm install

# 2. Spin up Redis (used by the NestJS cache for ephemeral LLM artifacts)
docker compose up -d redis

# 3. Configure env
cp .env.example .env
# fill in Supabase, LLM tier keys, SerpAPI

# 4. Apply DB migrations to your Supabase project
pnpm db:push

# 5. Run dev servers (two terminals)
pnpm api:dev   # → http://localhost:3001
pnpm web:dev   # → http://localhost:3000
```

## Architecture

See [`docs/architecture.md`](./docs/architecture.md) for the supervisor / search / writer subgraph layout, the `ui_state` schema streamed to the right pane, and the cache/checkpointer wiring.

## Deploy

See [`DEPLOY.md`](./DEPLOY.md) for the production layout (Supabase + Redis + Railway API + Vercel/Railway web), required env vars per host, and the smoke test.

> The live Railway project is **`final-mpfe`** (id `7bc6590a-9492-436a-8434-b69432e61aa8`, https://railway.com/project/7bc6590a-9492-436a-8434-b69432e61aa8). Reuse it — don't create a duplicate. The current public URLs are https://api-production-1caf.up.railway.app and https://web-production-a5346.up.railway.app.

Railway-specific quirks worth knowing before you click around the dashboard:

- Each service has its own `railway.toml` ([`apps/api/railway.toml`](./apps/api/railway.toml) and [`apps/web/railway.toml`](./apps/web/railway.toml)). Set the per-service **Config file** in Railway settings; do not put a single `railway.toml` at the repo root — a shared root file leaks API-only settings (Dockerfile path, `/health` healthcheck) into the web service.
- Railway's BuildKit rejects `--mount=type=cache,id=...` unless the id is prefixed with the per-service cache key (`s/<service-id>-...`). The Dockerfiles intentionally skip the cache mount so they stay portable; layer caching alone keeps rebuilds fast.
- If you use Supabase's IPv6 direct connection string for `SUPABASE_DB_URL`, enable **IPv6 egress** on the API service (Settings → Networking) or LangGraph's `PostgresSaver` will silently fall back to in-memory state. Alternatively use the IPv4 session pooler URL (port `6543`).
- Set an explicit `PORT` env var on each service (`3001` for API, `3000` for web) so the public domain's targetPort stays in sync with what the container actually listens on.
- The web bundle has all `NEXT_PUBLIC_*` values baked into it at `next build` time — they are NOT read at runtime. The web Dockerfile declares them as `ARG`s so Railway forwards same-named service variables as build args automatically. Whenever you change one (e.g. point the web app at a different API URL), the web service must be **rebuilt**, not just restarted.

## LLM tiers

Three OpenAI-compatible endpoints, configured via env (`SUPERVISOR_LLM_*`, `WRITER_LLM_*`, `UTILITY_LLM_*`). Boot fails fast if any are missing. Loaded once into a typed `LlmConfigService`; pick a model with `llmConfig.get('supervisor')`.

## DB migrations

Raw SQL files under `db/migrations/`, applied to Supabase via the Management API using `SUPABASE_MANAGEMENT_PAT` + `SUPABASE_PROJECT_REF`. Run with `pnpm db:push`. Idempotent — safe to re-run.

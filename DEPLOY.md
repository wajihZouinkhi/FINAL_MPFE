# Deploying FINAL_MPFE

End-to-end deploy guide for the syllabus generator. Production layout:

| Layer        | Host                                | Notes                                                                                          |
|--------------|-------------------------------------|------------------------------------------------------------------------------------------------|
| Postgres     | Supabase                             | LangGraph `PostgresSaver` checkpointer + Realtime publication                                  |
| Redis        | Railway Redis service (or Upstash)   | Ephemeral lesson-markdown cache (`apps/api/src/cache`)                                         |
| API (NestJS) | Railway                              | Container built from [`apps/api/Dockerfile`](./apps/api/Dockerfile), config in [`apps/api/railway.toml`](./apps/api/railway.toml) |
| Web (Next)   | Vercel **or** Railway                | Vercel via [`apps/web/vercel.json`](./apps/web/vercel.json); Railway via [`apps/web/Dockerfile`](./apps/web/Dockerfile) + [`apps/web/railway.toml`](./apps/web/railway.toml) |

Total cold-start setup: ~20 minutes.

> **Per-service railway.toml**: configs live under `apps/api/` and `apps/web/`, **not** at the repo root. Each Railway service must point at its own file via Settings → *Config file* (`railwayConfigFile`). A single root `railway.toml` would be applied to every service in the project and leak API-only settings into the web service.

---

## 1. Supabase

1. Create a project at <https://supabase.com/dashboard>.
2. Grab the values you'll need from **Project Settings**:
   - **API** → `Project URL` and `anon` + `service_role` keys.
   - **Database** → **Connection string → URI**. Use the **Session pooler** URL (port `6543`) for `SUPABASE_DB_URL` so LangGraph PostgresSaver shares a connection pool.
   - The project ref is the subdomain in the URL (e.g. `abcdefghijk` from `https://abcdefghijk.supabase.co`).
3. Create a Management API PAT at <https://supabase.com/dashboard/account/tokens> — needed only for `pnpm db:push`.
4. Apply migrations from your local checkout:
   ```bash
   SUPABASE_MANAGEMENT_PAT=… SUPABASE_PROJECT_REF=… pnpm db:push
   ```
   Idempotent — safe to re-run on every deploy.

> Realtime requires both: the `supabase_realtime` publication includes `syllabuses`/`chapters`/`lessons` (`db/migrations/0001_init.sql`) and each table is set to `REPLICA IDENTITY FULL` (`db/migrations/0002_replica_identity_full.sql`) so DELETE payloads carry the full pre-image. Both migrations are idempotent.

## 2. Redis

Pick one. Both expose a `rediss://` URL that the API consumes via `REDIS_URL`.

- **Upstash** (recommended for Vercel-adjacent latency): create a global database, copy the **TLS** endpoint URL.
- **Railway Redis plugin**: add the Redis service in the same Railway project as the API; Railway exposes it as `${{Redis.REDIS_URL}}` you can wire in the API service's env.

## 3. API on Railway

The API ships as a self-contained container. Railway will detect the Dockerfile and build from it directly.

1. **New project → Deploy from GitHub repo** → select `hamdisoudani/FINAL_MPFE`.
2. **Service settings**:
   - **Root Directory**: leave empty / `/` (build context is the repo root so the Dockerfile can see `pnpm-workspace.yaml` and the `packages/shared` sibling).
   - **Config file**: `apps/api/railway.toml` (this also pins the Dockerfile path and `/health` healthcheck).
   - **Networking → IPv6 egress**: **enable** if your `SUPABASE_DB_URL` points at the IPv6 direct connection. Without this the API boots but `[GraphService] PostgresSaver unavailable (connect ENETUNREACH ...)` and silently falls back to `MemorySaver`. The session pooler URL (port `6543`) is IPv4 and avoids this.
   - **Watch Paths** (optional): `apps/api/**`, `packages/shared/**`, `pnpm-lock.yaml`.
3. **Environment variables** (Railway → Variables):

   ```
   API_CORS_ORIGIN=https://<your-vercel-domain>
   SUPABASE_URL=…
   SUPABASE_ANON_KEY=…
   SUPABASE_SERVICE_ROLE_KEY=…
   SUPABASE_DB_URL=postgresql://…pooler.supabase.com:6543/postgres
   REDIS_URL=rediss://…

   SUPERVISOR_LLM_API_KEY=…
   SUPERVISOR_LLM_BASE_URL=https://integrate.api.nvidia.com/v1
   SUPERVISOR_LLM_MODEL=mistralai/mistral-small-4-119b-2603

   WRITER_LLM_API_KEY=…
   WRITER_LLM_BASE_URL=https://integrate.api.nvidia.com/v1
   WRITER_LLM_MODEL=mistralai/mistral-small-4-119b-2603

   UTILITY_LLM_API_KEY=…
   UTILITY_LLM_BASE_URL=https://integrate.api.nvidia.com/v1
   UTILITY_LLM_MODEL=mistralai/mistral-small-4-119b-2603

   SERPR_API_KEY=…
   ```

   The Dockerfile's entrypoint forwards `$PORT` into `API_PORT`. Set `PORT=3001` explicitly so the public domain's targetPort can be pinned to `3001` as well — otherwise Railway picks a random port and the generated domain stops routing through to the container.

4. **Public networking**: generate a Railway domain with **target port `3001`** (or attach a custom one). Note it for the web step.
5. **Health check**: `/health` (HTTP `GET`) is already implemented in `apps/api/src/health.controller.ts` and pinned in `apps/api/railway.toml`.

### Locally validating the container

```bash
# build (run from repo root so the build context includes pnpm-workspace.yaml)
docker build -f apps/api/Dockerfile -t mpfe-api .

# run with all env vars (or use --env-file)
docker run --rm -p 3001:3001 \
  -e SUPABASE_URL=… -e SUPABASE_ANON_KEY=… -e SUPABASE_SERVICE_ROLE_KEY=… \
  -e SUPABASE_DB_URL=… -e REDIS_URL=… \
  -e SUPERVISOR_LLM_API_KEY=… -e SUPERVISOR_LLM_BASE_URL=… -e SUPERVISOR_LLM_MODEL=… \
  -e WRITER_LLM_API_KEY=…     -e WRITER_LLM_BASE_URL=…     -e WRITER_LLM_MODEL=… \
  -e UTILITY_LLM_API_KEY=…    -e UTILITY_LLM_BASE_URL=…    -e UTILITY_LLM_MODEL=… \
  -e SERPR_API_KEY=… \
  mpfe-api

curl http://localhost:3001/health   # → {"ok":true,"ts":"…"}
```

## 4. Web on Vercel **or** Railway

Pick one. Vercel is the default and what `vercel.json` is wired for; Railway works too if you want everything in one place.

### 4a. Vercel (default)

The Next.js app is a Vercel-native deploy. Configuration lives in [`apps/web/vercel.json`](./apps/web/vercel.json).

1. **Import project** at <https://vercel.com/new> → pick `hamdisoudani/FINAL_MPFE`.
2. **Configure project**:
   - **Root Directory**: `apps/web` (Vercel auto-detects Next.js).
   - **Framework Preset**: Next.js (auto-detected).
   - **Build & Output**: leave default — `vercel.json` overrides `installCommand` and `buildCommand` so pnpm workspaces resolve correctly. The install runs from the repo root and `@mpfe/shared` is built before `next build`.
   - **Node version**: 20.x.
3. **Environment variables**:

   ```
   NEXT_PUBLIC_API_URL=https://<railway-api-domain>
   NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=…
   ```

   Set them for **Production**, **Preview** and **Development**.
4. **Deploy**. The first build will take ~2 min (pnpm install + shared build + Next build).
5. After the deploy succeeds, **go back to Railway** and update `API_CORS_ORIGIN` to the Vercel production URL. Re-deploy the API service so the new origin takes effect.

> The `vercel.json` `ignoreCommand` skips builds for changes that don't touch `apps/web`, `packages/shared`, or the lockfile.

### 4b. Railway (alternative)

[`apps/web/Dockerfile`](./apps/web/Dockerfile) produces a self-contained Next.js standalone bundle that runs anywhere Node 20 runs.

1. **Add a service to the same Railway project** → *Deploy from GitHub repo* → select `hamdisoudani/FINAL_MPFE`.
2. **Service settings**:
   - **Root Directory**: `/`.
   - **Config file**: `apps/web/railway.toml` (pins the Dockerfile path; no `/health` healthcheck since Next.js doesn't expose one and Railway's TCP check is sufficient).
3. **Environment variables**:

   ```
   PORT=3000
   NEXT_PUBLIC_API_URL=https://<railway-api-domain>
   NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=…
   ```

   The Dockerfile's runtime layer defaults `PORT=3000`, so the override is technically redundant but keeps the value explicit alongside the public domain's targetPort.

   > **Critical**: `NEXT_PUBLIC_*` vars are inlined into the JS bundle by `next build`, **not** read at runtime. The web Dockerfile declares `ARG NEXT_PUBLIC_API_URL` / `_SUPABASE_URL` / `_SUPABASE_ANON_KEY` in the builder stage so Railway forwards the same-named service variables as build args automatically. If they're not set when the build runs, the bundle ships with the source-code fallbacks (e.g. `http://localhost:3001`) and `New thread` silently fails with `Failed to fetch` because the browser tries to call your laptop. Whenever you change any of these values, the web service must be **rebuilt** (Railway → Deployments → *Redeploy*), not just restarted.
4. **Public networking**: generate a Railway domain with **target port `3000`**.
5. Update `API_CORS_ORIGIN` on the API service to the new Railway web domain and redeploy the API service so the new origin takes effect.

## 5. Smoke test

```bash
# 1. API health
curl https://<railway-domain>/health

# 2. Open the Vercel URL → click "New thread"
#    Send: "Build me a syllabus"
#    Expect: AskCard renders with 2–4 suggestions, exactly one tagged REC.

# 3. Click any chip → AskCard collapses into an AskHistory bubble,
#    phase flips to Researching, ResearchCard fills 5/5, then TodoCard begins.

# 4. Reload the page mid-write — chat transcript, AskHistory bubbles,
#    research/todo cards, and FileTree must all hydrate from
#    GET /api/chat/:id/state (LangGraph PostgresSaver).
```

## 6. Re-applying DB migrations after schema changes

Migrations are versioned, idempotent SQL files in `db/migrations/`. After merging a PR that adds one:

```bash
SUPABASE_MANAGEMENT_PAT=… SUPABASE_PROJECT_REF=… pnpm db:push
```

Run this **before** the API deploy completes so old code doesn't read a new schema or vice-versa. For breaking changes, follow the standard expand → migrate code → contract dance.

## Troubleshooting

| Symptom                                                                                | Fix                                                                                                                                                        |
|----------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Railway build: `Cache mount ID is not prefixed with cache key` or `Cache mounts MUST be in the format --mount=type=cache,id=<cache-id>` | Railway's BuildKit only accepts cache mounts whose id is `s/<service-id>-...`. The committed Dockerfiles intentionally skip `--mount=type=cache,...` so they stay portable. If you re-add one, hardcode the service ID. |
| Railway: web service builds with `apps/api/Dockerfile` instead of the web one          | Both services are reading the same `railway.toml`. Make sure each service's **Config file** setting points at `apps/<svc>/railway.toml`, not the repo root. |
| Railway runtime: API `/health` returns 502 with `Application failed to respond`        | Public domain targetPort doesn't match the port the container is listening on. Set `PORT=3001` (api) / `PORT=3000` (web) explicitly and align the domain's target port. |
| Railway runtime: `[GraphService] PostgresSaver unavailable (connect ENETUNREACH ...)` and falls back to `MemorySaver` | `SUPABASE_DB_URL` resolves to IPv6 but the API service has IPv6 egress disabled. Either enable IPv6 egress on the service (Settings → Networking) or swap to the IPv4 session pooler URL (port `6543`). |
| Railway build: `ERR_PNPM_OUTDATED_LOCKFILE`                                            | Lockfile diverged. Run `pnpm install` locally, commit, push.                                                                                               |
| Railway runtime: API exits with `Invalid environment configuration`                    | One of the required env vars is missing. The error log lists each Zod issue.                                                                               |
| Vercel build: `Module not found: '@mpfe/shared'`                                       | Vercel's Root Directory is misconfigured. Must be `apps/web`. The `installCommand` in `vercel.json` runs `pnpm install` from the repo root via `cd ../..`. |
| Realtime never fires in production                                                     | Confirm the publication exists: `select * from pg_publication_tables where pubname='supabase_realtime';` should list `syllabuses`/`chapters`/`lessons`.    |
| Web on Railway: `New thread` toast shows `Failed to fetch`; Network tab shows the request hitting `http://localhost:3001/api/threads` | The bundle was built without `NEXT_PUBLIC_API_URL` set. Make sure all three `NEXT_PUBLIC_*` service variables are set on the web service **before** the build runs, then **rebuild** (Railway → Deployments → *Redeploy*). Setting them after the fact requires a fresh build because Next.js inlines them at `next build` time. |
| `chat.controller` 500 on first turn                                                    | Usually a stale checkpoint from before a state-shape change. Delete the thread row in Supabase and start a new one.                                        |
| CORS errors from the web app                                                           | `API_CORS_ORIGIN` on Railway must exactly match the web origin (scheme + host, no trailing slash).                                                         |

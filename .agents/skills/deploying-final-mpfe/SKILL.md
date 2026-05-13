# Deploying FINAL_MPFE on Railway

Reference for any future task that involves provisioning, redeploying, or
debugging this monorepo on Railway. Captures gotchas that are not obvious
from Railway's docs and that took several PRs to figure out the first time.

## DO NOT create a new Railway project

The project **already exists**. Reuse it.

| Field | Value |
|---|---|
| Project name | `final-mpfe` |
| Project ID | `7bc6590a-9492-436a-8434-b69432e61aa8` |
| Environment | `production` (id `075f8f25-b85e-49ee-a8a1-7bb70c42d01f`) |
| Dashboard | https://railway.com/project/7bc6590a-9492-436a-8434-b69432e61aa8 |
| Services | `api`, `web`, `Redis`, `mcp-supabase` (all green at last update) |

Before doing anything, verify the project is still alive with the GraphQL
API:

```bash
curl -sS https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -H "User-Agent: x" -H "Content-Type: application/json" \
  -d '{"query":"query{me{workspaces{edges{node{name projects{edges{node{id name services{edges{node{name}}}}}}}}}}}"}'
```

If you find `final-mpfe` in the response, **modify the existing services** in
that project (env vars, redeploy, change config). Do **NOT** call
`projectCreate` — that would orphan the live URLs and require re-issuing
domains and CORS origins from scratch. Only run the from-scratch provisioning
flow below if the project genuinely no longer exists in the workspace.

## TL;DR architecture

| Service | Source | Config file | Notable settings |
|---------|--------|-------------|------------------|
| `api` (NestJS) | `apps/api/Dockerfile` | `apps/api/railway.toml` | `PORT=3001`, healthcheck `/health`, IPv6 egress **on** |
| `web` (Next.js standalone) | `apps/web/Dockerfile` | `apps/web/railway.toml` | `PORT=3000`, no healthcheck |
| `Redis` | image `redis:7-alpine` | n/a | `/data` volume, private-only, exposed via `${{Redis.RAILWAY_PRIVATE_DOMAIN}}` |
| `mcp-supabase` (Python FastMCP) | `apps/mcp-supabase/Dockerfile` | `apps/mcp-supabase/railway.toml` | `PORT=8080`, `MCP_TRANSPORT=streamable-http`, private-only, no healthcheck |

Private-network wiring:
- API ↔ Redis: `REDIS_URL=redis://${{Redis.RAILWAY_PRIVATE_DOMAIN}}:6379`
- API ↔ mcp-supabase: `MCP_SUPABASE_URL=http://${{mcp-supabase.RAILWAY_PRIVATE_DOMAIN}}:8080/mcp`

### `mcp-supabase` notes

- Reachable **only** on the private network — no public domain. The DNS-rebinding
  protection that FastMCP enables by default would block any non-localhost
  `Host:` header, so `apps/mcp-supabase/src/mpfe_mcp_supabase/server.py` overrides
  `TransportSecuritySettings(allowed_hosts=["*"], allowed_origins=["*"])` when
  `MCP_TRANSPORT=streamable-http`. This is safe **because** the service is
  private-only; do not put it behind a public domain without re-tightening
  these settings.
- Default transport in the same image is still `stdio` (used by `pnpm api:dev`
  locally). The container's `ENV MCP_TRANSPORT=streamable-http` flips it for
  the Railway deploy. Don't drop the env-var dispatcher in `server.py` or local
  dev breaks.
- The API connects via `@langchain/mcp-adapters@0.6.0`'s `transport: "http"`
  config (which is the streamable-HTTP transport in 0.6.x — the literal value
  `"streamable_http"` is only valid on `@langchain/mcp-adapters@1.x`).
- The path is **lazy**: the API doesn't open a connection until the first
  activity-tooled tool call. Look for `[McpClientService] MCP server (lazy, http): ...`
  in the API boot logs; the actual tool list shows up later as `MCP tools loaded: list_syllabuses, list_chapters, list_lessons, list_lessons_for_thread, get_lesson`.

## Hard-won gotchas

### 1. Per-service `railway.toml`, not a single root file

Railway looks for `railway.toml` at the repo root by default. With multiple
services pointing at the same repo, **the same root file is applied to every
service** — so an API-shaped config (Dockerfile path, `/health` healthcheck)
will leak into the web service and break it.

Fix: keep `railway.toml` in `apps/api/`, `apps/web/`, and `apps/mcp-supabase/`,
and set the per-service **Config file** (the GraphQL field is `railwayConfigFile`)
to point at the right file. Example via the API:

```graphql
mutation {
  serviceInstanceUpdate(
    serviceId: "<api-service-id>"
    environmentId: "<env-id>"
    input: { railwayConfigFile: "apps/api/railway.toml" }
  )
}
```

### 2. BuildKit cache mounts are basically forbidden

Railway's BuildKit policy:

| Cache mount syntax | Result |
|---|---|
| `--mount=type=cache,id=pnpm,target=/pnpm/store` | `Cache mount ID is not prefixed with cache key` |
| `--mount=type=cache,target=/pnpm/store` (no id) | `Cache mounts MUST be in the format --mount=type=cache,id=<cache-id>` |
| `--mount=type=cache,id=s/<service-id>-pnpm,...` (hardcoded) | Accepted, but ties Dockerfile to one service |
| `--mount=type=cache,id=s/${RAILWAY_SERVICE_ID}-pnpm,...` | Rejected — mount ids are evaluated before ARG substitution |

All committed Dockerfiles **intentionally have no `--mount=type=cache,...` line**.
Layer caching alone is fine — `pnpm install` only re-runs when the lockfile/manifests
change. Don't re-add a cache mount.

### 3. Set `PORT` explicitly on every public service

Railway injects a random `$PORT` per deployment. The Dockerfile entrypoints
forward `$PORT` to the app, so the container listens on whatever Railway gave
it. The public domain's `targetPort`, however, is fixed when you create the
domain. If they don't match, you get HTTP 502 `Application failed to respond`
on the public URL even though the container is healthy.

Fix: set `PORT=3001` on the API service, `PORT=3000` on the web service, and
`PORT=8080` on `mcp-supabase` (so `MCP_SUPABASE_URL` can hardcode the port —
Railway only exposes the **private domain** as a template variable, not the
target port). Create the public domains with matching `targetPort`. Railway
respects the user-set `PORT` over its own injection.

### 4. `NEXT_PUBLIC_*` vars must be present at **build time**, not runtime

Next.js inlines `NEXT_PUBLIC_*` env vars into the static JS bundle when
`next build` runs. Railway exposes service variables to the **runtime**
container by default, so without explicit Dockerfile `ARG`s the build sees
nothing and the bundle ships with whatever fallback the source code has
(`apps/web/app/page.tsx` falls back to `http://localhost:3001`).

The symptom is brutal: the production web app loads fine, but clicking *New
thread* shows a `Failed to fetch` toast and the Network tab reveals the
request was sent to `http://localhost:3001/api/threads` — i.e. the user's
own laptop, which obviously is not running the API.

The committed `apps/web/Dockerfile` declares the three relevant args in the
builder stage:

```dockerfile
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
# ... etc
```

Railway auto-forwards same-named service variables as build args when an
`ARG` of that name is declared. So as long as the three
`NEXT_PUBLIC_*` variables exist on the web service, the next *build* (not
just *restart*) will inline them correctly. **Changing one of these vars
requires a rebuild**, not a redeploy of the existing image. Use `Deployments
→ Redeploy` (which re-runs the build) or push a new commit.

### 5. Supabase IPv6 + Railway IPv6 egress

Supabase's "direct" Postgres connection string resolves to an IPv6 address.
Railway containers have IPv6 egress **disabled** by default, so LangGraph's
`PostgresSaver` will fail with:

```
[GraphService] PostgresSaver unavailable
  (connect ENETUNREACH 2a05:...:5432).
  Falling back to MemorySaver — runs will not persist across restarts.
```

This fallback is silent at the HTTP level (the API still boots), but thread
state stops persisting across restarts and reloads break.

Two fixes, pick one:
- **Enable IPv6 egress** on the API service via `serviceInstanceUpdate(input: { ipv6EgressEnabled: true })`, **or**
- Use the IPv4 **session pooler** URL (port `6543`) for `SUPABASE_DB_URL`.

We currently use option 1 in production.

### 6. `@langchain/mcp-adapters` ↔ `@modelcontextprotocol/sdk` version pin

`@langchain/mcp-adapters@0.6.0` declares `@modelcontextprotocol/sdk@^1.12.1`,
but its `types.cjs` decomposes `CallToolResultContentSchema` in a way that
**only works against SDK ≤ 1.22.0**. SDK 1.23+ wraps some union members
differently and the adapter throws at module-import time:

```
Error: Internal error: Invalid option found in CallToolResultContentSchema's
union. Expected ZodObject with ZodLiteral 'type'.
  at .../@langchain/mcp-adapters/dist/types.cjs:31:11
```

This is at module-load, so even threads that never touch the activity-tooled
agent fail to boot the API. Root `package.json` pins the SDK via
`pnpm.overrides`:

```json
"pnpm": { "overrides": { "@modelcontextprotocol/sdk": "~1.22.0" } }
```

Do not remove this override unless mcp-adapters is also bumped (1.x requires
`@langchain/core@^1.0.0` and `@langchain/langgraph@^1.0.0`, which is a bigger
dep upgrade).

### 7. Required env var inventory

The API fails fast at boot via Zod validation if any of these are missing/blank
(see `apps/api/src/config/`):

```
SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL
REDIS_URL
SERPR_API_KEY                              # note the typo, "SERPR_" not "SERPER_"
API_CORS_ORIGIN                            # must match the web origin exactly
SUPERVISOR_LLM_API_KEY/_BASE_URL/_MODEL    # all 3 tiers required, no defaults
WRITER_LLM_API_KEY/_BASE_URL/_MODEL
UTILITY_LLM_API_KEY/_BASE_URL/_MODEL
MCP_SUPABASE_URL                           # optional; unset = stdio fallback
```

Web service needs:

```
NEXT_PUBLIC_API_URL
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
```

`mcp-supabase` service needs:

```
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY     # service-role bypasses RLS — fine, private-only
MCP_TRANSPORT=streamable-http
MCP_HOST=0.0.0.0                            # FastMCP defaults to 127.0.0.1
PORT=8080                                   # pinned so MCP_SUPABASE_URL can hardcode the port
```

### 8. DB migrations are not applied on deploy

`pnpm db:push` runs `scripts/db-push.ts`, which uses the Supabase Management
API. It needs `SUPABASE_MANAGEMENT_PAT` + `SUPABASE_PROJECT_REF` (already in
session secrets). Run it locally before/after a deploy that touches `db/migrations/`.
Migrations are idempotent, so re-running on every deploy is safe.

### 9. Free-plan service cap

The trial / free plan caps a project at **3 services**. The current
deployment (`api`, `web`, `Redis`, `mcp-supabase`) is on the Hobby plan
(or higher); attempting `serviceCreate` against a free-plan project returns
`Free plan resource provision limit exceeded`. If a future cleanup ever
takes the project back below the cap, watch for this error before adding
a 4th service.

## Programmatic provisioning via the Railway GraphQL API

Endpoint: `https://backboard.railway.com/graphql/v2`

Headers:
```
Authorization: Bearer <account-or-workspace-token>
Content-Type: application/json
User-Agent: <anything-non-empty>     # default python-urllib UA gets 403'd by their WAF
```

**Token type matters**: Project Tokens can only manage an **existing** project
(use the `Project-Access-Token` header, not `Authorization: Bearer`). To
create a new project you need an **Account** or **Workspace** token from
https://railway.com/account/tokens. The `me { name email }` introspection
query fails on workspace tokens — use `{ projects { edges { node { id name } } } }`
to verify auth instead.

The Railway CLI uses different env vars from the API: `RAILWAY_TOKEN` for
project tokens only. Account-token CLI auth requires interactive `railway login`.
Just use the GraphQL API directly — it's straightforward.

Key mutations used during initial provisioning:
- `projectCreate(input: { name, defaultEnvironmentName })`
- `serviceCreate(input: { projectId, name, source: { repo | image }, branch })`
- `serviceInstanceUpdate(serviceId, environmentId, input: { railwayConfigFile, dockerfilePath, healthcheckPath, ipv6EgressEnabled, ... })`
- `variableUpsert(input: { projectId, environmentId, serviceId, name, value, skipDeploys })`
- `serviceDomainCreate(input: { serviceId, environmentId, targetPort })`
- `volumeCreate(input: { projectId, environmentId, serviceId, mountPath })`
- `serviceInstanceDeployV2(serviceId, environmentId)`

Read service vars (note: `projectId` is required as well as `serviceId` and
`environmentId`, and the response **resolves** template references like
`${{mcp-supabase.RAILWAY_PRIVATE_DOMAIN}}` rather than echoing them literally):

```graphql
query($p: String!, $svc: String!, $env: String!) {
  variables(projectId: $p, serviceId: $svc, environmentId: $env)
}
```

## Verifying a deploy

```bash
# 1. Check status of latest deploy on each service
curl -sS -H "Authorization: Bearer $RAILWAY_TOKEN" \
     -H "User-Agent: x" \
     -X POST https://backboard.railway.com/graphql/v2 \
     -d '{"query":"query($pid:String!){project(id:$pid){services{edges{node{name deployments(first:1){edges{node{status meta}}}}}}}}","variables":{"pid":"<project-id>"}}'

# 2. API smoke test
curl https://<api-domain>/health        # → {"ok":true,"ts":"..."}

# 3. API runtime logs (the LangGraph fallback warning hides here, and the
#    `[McpClientService] MCP server (lazy, http): ...` line confirms the
#    Supabase MCP wiring is in effect)
curl ... -d '{"query":"query($id:String!){deploymentLogs(deploymentId:$id,limit:100){message severity}}","variables":{"id":"<deployment-id>"}}'

# 4. mcp-supabase smoke test (requires being on the private network — easiest
#    way is to run an `exec` from another service in the same project)
curl -X POST http://mcp-supabase.railway.internal:8080/mcp \
     -H 'Content-Type: application/json' \
     -H 'Accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
```

If a build fails with no useful build logs, check `deploymentEvents.payload.error`
on the deployment — that's where errors like the cache-mount one show up
before any output is streamed.

## Live deployment URLs (snapshot at last update)

- API:          https://api-production-1caf.up.railway.app/health
- Web:          https://web-production-a5346.up.railway.app
- mcp-supabase: `mcp-supabase.railway.internal:8080` (private only, no public domain)

Domains may have rotated by the time you read this. Re-query
`service.serviceInstances{serviceInstance{domains{serviceDomains{domain}}}}`
for the current values.

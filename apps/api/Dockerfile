# syntax=docker/dockerfile:1.7
#
# Multi-stage build for @mpfe/api (NestJS + LangGraph).
# Designed for Railway / Fly / any container host:
#   - corepack pins pnpm@9.15.1 (matches packageManager in root package.json)
#   - workspace-aware install with cache mounts for fast rebuilds
#   - `pnpm deploy` produces a self-contained, prod-only bundle (workspace
#     deps inlined into node_modules so no symlinks at runtime)
#   - non-root runtime user; honors $PORT (Railway sets this)

# ─── Builder ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /repo

# Manifests first — keeps the install layer cacheable across source-only edits.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/deep-agent/package.json packages/deep-agent/package.json
# apps/web manifest is required because pnpm-workspace.yaml globs apps/*.
COPY apps/web/package.json apps/web/package.json

# Plain install, no BuildKit cache mount. Railway's BuildKit rejects
# cache mounts whose `id` isn't prefixed with `s/<service-id>-` AND
# rejects mounts with no `id` at all, and the prefix can't be supplied
# via build args. Easiest cross-platform fix is to skip the mount; layer
# caching still keeps this fast on rebuilds when the lockfile is unchanged.
#
# `--filter @mpfe/api...` (with the trailing `...`) pulls in every
# transitive workspace dep — including `@mpfe/deep-agent` — so we don't
# need to list it explicitly here. The matching `COPY` above is what
# makes pnpm aware the package exists in the first place.
RUN pnpm install --frozen-lockfile \
      --filter @mpfe/api... \
      --filter @mpfe/shared

# Source
COPY tsconfig.json ./
COPY packages/shared packages/shared
COPY packages/deep-agent packages/deep-agent
COPY apps/api apps/api

# Build workspace deps first (api consumes their compiled dist via
# `main`/`types` in each package.json), then api itself.
RUN pnpm --filter @mpfe/shared build \
 && pnpm --filter @mpfe/deep-agent build \
 && pnpm --filter @mpfe/api build

# Self-contained deployable: prod-only deps + workspace deps inlined.
RUN pnpm --filter @mpfe/api deploy --prod /out

# ─── Runtime ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Railway / Fly inject $PORT; api reads API_PORT (see app-config.service.ts).
# We default API_PORT to $PORT at start time via the entrypoint below.
ENV API_PORT=3001

# Non-root for defense-in-depth.
RUN addgroup -S app && adduser -S app -G app

COPY --from=builder --chown=app:app /out/dist ./dist
COPY --from=builder --chown=app:app /out/node_modules ./node_modules
COPY --from=builder --chown=app:app /out/package.json ./package.json

USER app
EXPOSE 3001

# Lightweight healthcheck against the existing GET /health route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# If the host injects $PORT (Railway / Fly / Cloud Run), surface it as API_PORT.
CMD ["sh", "-c", "API_PORT=${PORT:-${API_PORT:-3001}} node dist/main.js"]

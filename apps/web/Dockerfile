# syntax=docker/dockerfile:1.7
#
# Multi-stage build for @mpfe/web (Next.js 15 App Router).
# Mirrors apps/api/Dockerfile structure:
#   - corepack pins pnpm@9.15.1
#   - workspace-aware install with cache mounts
#   - Next.js `output: "standalone"` produces a minimal self-contained
#     server bundle so the runtime layer doesn't need pnpm or the full
#     monorepo on disk.
#   - non-root runtime user; honors $PORT (Railway sets this).
#
# Build context MUST be the repo root so the build can see
# pnpm-workspace.yaml and the packages/shared sibling.

# ─── Builder ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /repo

# Manifests first — keeps the install layer cacheable across source-only edits.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
# apps/api manifest is required because pnpm-workspace.yaml globs apps/*.
COPY apps/api/package.json apps/api/package.json

# Plain install, no BuildKit cache mount. Railway's BuildKit rejects
# cache mounts whose `id` isn't prefixed with `s/<service-id>-` AND
# rejects mounts with no `id` at all, and the prefix can't be supplied
# via build args. Easiest cross-platform fix is to skip the mount; layer
# caching still keeps this fast on rebuilds when the lockfile is unchanged.
RUN pnpm install --frozen-lockfile \
      --filter @mpfe/web... \
      --filter @mpfe/shared

# Source
COPY tsconfig.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web

# Next.js inlines NEXT_PUBLIC_* env vars into the client bundle at
# `next build` time, NOT at runtime. So they must be present here, in the
# builder stage, or the bundle will ship with whatever default the source
# code falls back to (e.g. http://localhost:3001 for the API).
#
# Declared as ARGs so Railway / `docker build --build-arg` can populate them.
# Promoted to ENVs so `next build` picks them up. Placed immediately before
# the build step so changing one doesn't bust the upstream `pnpm install`
# layer cache.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY}

# Build shared first (web imports its compiled dist), then web.
RUN pnpm --filter @mpfe/shared build \
 && pnpm --filter @mpfe/web build

# ─── Runtime ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root for defense-in-depth.
RUN addgroup -S app && adduser -S app -G app

# Next standalone output preserves the monorepo path structure under
# .next/standalone, so the runnable server lives at apps/web/server.js.
COPY --from=builder --chown=app:app /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=app:app /repo/apps/web/.next/static ./apps/web/.next/static

USER app
EXPOSE 3000

CMD ["node", "apps/web/server.js"]

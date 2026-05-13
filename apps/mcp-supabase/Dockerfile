# syntax=docker/dockerfile:1.7
#
# Container image for the mpfe-mcp-supabase MCP server.
#
# Two transports are supported by the same image:
#   - stdio        (default; used when the API spawns this as a child)
#   - streamable-http (used on Railway; API connects over the private
#                      network at $RAILWAY_PRIVATE_DOMAIN:$PORT/mcp)
#
# Set MCP_TRANSPORT=streamable-http on the Railway service to switch.

FROM python:3.12-slim AS base

# uv is the fastest way to install + lock python deps; pulling the
# pre-built binary keeps the image small (no rust toolchain, no pip).
COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /uvx /usr/local/bin/

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_NO_CACHE=1

WORKDIR /app

# Install deps first (cacheable across source-only edits). uv reads
# pyproject.toml + uv.lock for a reproducible resolve.
COPY apps/mcp-supabase/pyproject.toml apps/mcp-supabase/uv.lock ./
COPY apps/mcp-supabase/src ./src
COPY apps/mcp-supabase/README.md ./README.md

RUN uv sync --frozen --no-dev

# Non-root for defense-in-depth.
RUN useradd --create-home --shell /usr/sbin/nologin app \
 && chown -R app:app /app
USER app

# Default transport is stdio so `docker run` without env vars works
# locally. Railway sets MCP_TRANSPORT=streamable-http + PORT.
ENV MCP_TRANSPORT=streamable-http \
    MCP_HOST=0.0.0.0 \
    PORT=8000

EXPOSE 8000

CMD ["uv", "run", "--no-sync", "mpfe-mcp-supabase"]

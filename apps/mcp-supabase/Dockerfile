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
#
# Includes a CPU-only sentence-transformers stack so the `embed_text`
# / `find_related_*` tools work without an external embedding API. The
# `all-MiniLM-L6-v2` model is pre-downloaded into the image at build
# time so cold-start does not hit Hugging Face from inside Railway.

FROM python:3.12-slim AS base

# uv is the fastest way to install + lock python deps; pulling the
# pre-built binary keeps the image small (no rust toolchain, no pip).
COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /uvx /usr/local/bin/

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_NO_CACHE=1 \
    HF_HOME=/app/.hf_cache \
    SENTENCE_TRANSFORMERS_HOME=/app/.hf_cache

WORKDIR /app

# Install deps first (cacheable across source-only edits). uv reads
# pyproject.toml + uv.lock for a reproducible resolve. Configured to
# pull CPU-only torch wheels so we don't drag in CUDA (~3 GB).
COPY apps/mcp-supabase/pyproject.toml apps/mcp-supabase/uv.lock ./
COPY apps/mcp-supabase/src ./src
COPY apps/mcp-supabase/README.md ./README.md

ENV UV_INDEX_STRATEGY=unsafe-best-match \
    UV_EXTRA_INDEX_URL=https://download.pytorch.org/whl/cpu

RUN uv sync --no-dev

# Note: the sentence-transformer model is downloaded lazily on the
# first /find_related_* call (~80 MB from Hugging Face). Preloading
# during build was removed because it intermittently fails the build
# step on Railway with image-push timeouts on the large layer.

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

"""
Local sentence-transformer embedding helper for the mcp-supabase server.

Loads ``sentence-transformers/all-MiniLM-L6-v2`` (384-dim, ~80 MB on
disk) lazily on first call so the FastMCP server starts quickly even
when no caller actually needs embeddings.

The model is pre-downloaded into the Docker image at build time so
cold start does not have to hit Hugging Face from inside a Railway
container.
"""

from __future__ import annotations

import hashlib
import threading
from typing import Iterable

EMBEDDING_DIM = 384
_MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"

_lock = threading.Lock()
_model = None  # lazy singleton


def _get_model():
    """Load and cache the sentence-transformer model on first use."""
    global _model
    if _model is None:
        with _lock:
            if _model is None:
                # Local import keeps the dependency optional at import
                # time so a misconfigured deploy still exposes the
                # non-embedding tools.
                from sentence_transformers import SentenceTransformer

                _model = SentenceTransformer(_MODEL_NAME)
    return _model


def embed_text(text: str) -> list[float]:
    """Return the 384-d embedding vector for a single string.

    Empty / whitespace-only input returns a zero vector so callers can
    write deterministic upserts without special-casing the early
    "no content yet" state of a freshly-named activity.
    """
    if not text or not text.strip():
        return [0.0] * EMBEDDING_DIM
    model = _get_model()
    vec = model.encode(text, normalize_embeddings=True, convert_to_numpy=True)
    return [float(x) for x in vec.tolist()]


def embed_batch(texts: Iterable[str]) -> list[list[float]]:
    """Batched variant for upsert flows that compute several rows at once."""
    items = list(texts)
    if not items:
        return []
    model = _get_model()
    arr = model.encode(items, normalize_embeddings=True, convert_to_numpy=True)
    return [[float(x) for x in row.tolist()] for row in arr]


def content_hash(text: str) -> str:
    """SHA-1 hex digest of the canonicalised text, used to skip
    re-embedding when the source text has not changed."""
    return hashlib.sha1((text or "").encode("utf-8")).hexdigest()


def vector_literal(embedding: list[float]) -> str:
    """Render a Python list of floats as a pgvector literal string
    (``[0.1,0.2,...]``) suitable for use in INSERT/UPDATE statements
    sent through PostgREST's `rpc` shim or via psycopg directly."""
    return "[" + ",".join(f"{x:.6f}" for x in embedding) + "]"

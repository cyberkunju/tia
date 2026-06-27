# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# TIA API — FastAPI worker (Python 3.12, uv). Build context = repo ROOT so that
# data/seed/*.xlsx ships in the image and the app's path-derived DATA_DIR
# (REPO_ROOT/data) resolves identically to local dev.
#
#   docker build -f workers/ai/Dockerfile -t tia-api .
# ─────────────────────────────────────────────────────────────────────────────

############################
# Stage 1 — build the venv #
############################
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS builder

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

WORKDIR /app/workers/ai

# 1) Install dependencies only — cached unless uv.lock / pyproject.toml change.
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=workers/ai/uv.lock,target=uv.lock \
    --mount=type=bind,source=workers/ai/pyproject.toml,target=pyproject.toml \
    uv sync --frozen --no-install-project --no-dev --extra postgres

# 2) Install the project itself on top of the cached dependency layer.
COPY workers/ai /app/workers/ai
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --extra postgres

############################
# Stage 2 — runtime image  #
############################
FROM python:3.12-slim-bookworm AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/app/workers/ai/.venv/bin:${PATH}" \
    TIA_STAGING_DIR=/app/staging

# libgomp1: OpenBLAS runtime for the numpy/scipy wheels used by the Hungarian matcher.
# fonts-dejavu/liberation: typst (typst-py wheel) renders invoices with these faces.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 fonts-dejavu-core fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

# Unprivileged runtime user.
RUN groupadd --system app \
 && useradd --system --gid app --home-dir /app --shell /usr/sbin/nologin app

WORKDIR /app/workers/ai

# Virtualenv + application source (built in stage 1).
COPY --from=builder --chown=app:app /app/workers/ai /app/workers/ai
# Seed master data + eval gold fixtures (DATA_DIR == /app/data).
COPY --chown=app:app data /app/data

# Writable staging dir for uploads + rendered invoice PDFs.
RUN mkdir -p /app/staging \
 && chmod +x /app/workers/ai/docker-entrypoint.sh \
 && chown -R app:app /app

USER app
EXPOSE 8000

# Liveness via the app's own /health (no curl in the slim image).
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD python -c "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status==200 else 1)"

ENTRYPOINT ["/app/workers/ai/docker-entrypoint.sh"]

# syntax=docker/dockerfile:1
# Hardened image per ADR-0008. Build context is the repo root (uv workspace).
# Base images use rolling Chainguard tags here; real deployments pin by digest
# (managed by Renovate). Output is a shell-less, non-root, bytecode-only image.

FROM cgr.dev/chainguard/python:latest-dev AS build
WORKDIR /app
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never
COPY pyproject.toml uv.lock ./
COPY packages ./packages
COPY services ./services
RUN uv sync --frozen --no-dev --no-editable --package keel-reference-service
# Code protection (ADR-0008 default): compile to bytecode, strip source.
RUN python -m compileall -q -b /app/.venv \
    && find /app/.venv -name '*.py' -delete

FROM cgr.dev/chainguard/python:latest
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
ENV PATH="/app/.venv/bin:$PATH"
USER nonroot
EXPOSE 8000
ENTRYPOINT ["python", "-m", "reference_service.main"]

# syntax=docker/dockerfile:1
# Hardened image per ADR-0008. Build context is the repo root (uv workspace).
# Base images use rolling Chainguard tags by deliberate choice: they are rebuilt
# continuously, so every build is Trivy-scanned (a static digest pin would freeze
# stale CVEs). The published image is cosign-signed and attested by its built
# digest. Output is a shell-less, non-root, bytecode-only image.

FROM cgr.dev/chainguard/python:latest-dev AS build
WORKDIR /app
# uv is a BUILD TOOL that executes during the build (resolves + installs + byte-compiles
# every dependency), so unlike the rolling, continuously-scanned Chainguard base it is
# digest-pinned: a repointed :latest tag could otherwise alter what lands in the signed
# image. Bump via Dependabot (docker ecosystem). uv 0.12.0.
COPY --from=ghcr.io/astral-sh/uv:0.12.0@sha256:606e70c71c852d03f611b1e56a195d08648507018a7057fab82c4974c4eae105 /uv /usr/bin/uv
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

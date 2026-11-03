"""Liveness and readiness endpoints (platform.yaml health)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence

from fastapi import APIRouter, Response
from fastapi.responses import JSONResponse

ReadinessCheck = Callable[[], Awaitable[bool]]


def build_health_router(readiness_checks: Sequence[ReadinessCheck]) -> APIRouter:
    """Return a router exposing ``/healthz`` (liveness) and ``/readyz`` (readiness)."""
    router = APIRouter()

    @router.get("/healthz")
    async def liveness() -> dict[str, str]:
        """Liveness: the process is up."""
        return {"status": "ok"}

    @router.get("/readyz")
    async def readiness() -> Response:
        """Readiness: all dependency checks pass."""
        for check in readiness_checks:
            if not await check():
                return JSONResponse(status_code=503, content={"status": "not ready"})
        return JSONResponse(status_code=200, content={"status": "ready"})

    return router

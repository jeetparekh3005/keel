"""RFC 9457 problem+json error responses for domain errors (platform.yaml errors)."""

from __future__ import annotations

from typing import TYPE_CHECKING, cast

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from keel_core.domain.errors import DomainError, ValidationFailed

if TYPE_CHECKING:
    from keel_core.ports.logging import Logger

PROBLEM_CONTENT_TYPE = "application/problem+json"


def _problem(
    *, status: int, title: str, category: str, detail: str | None, instance: str
) -> JSONResponse:
    body: dict[str, object] = {
        "type": f"urn:keel:error:{category}",
        "title": title,
        "status": status,
        "instance": instance,
    }
    if detail is not None:
        body["detail"] = detail
    return JSONResponse(status_code=status, content=body, media_type=PROBLEM_CONTENT_TYPE)


def register_exception_handlers(app: FastAPI, logger: Logger) -> None:
    """Install problem+json handlers for domain, validation, and unhandled errors."""

    async def _domain(request: Request, exc: Exception) -> Response:
        error = cast("DomainError", exc)
        if error.status >= 500:
            logger.error("domain error", category=error.category.value, status=error.status)
        return _problem(
            status=error.status,
            title=error.title,
            category=error.category.value,
            detail=error.detail,
            instance=request.url.path,
        )

    async def _validation(request: Request, exc: Exception) -> Response:
        return _problem(
            status=400,
            title=ValidationFailed.title,
            category=ValidationFailed.category.value,
            detail="Request validation failed",
            instance=request.url.path,
        )

    async def _unhandled(request: Request, exc: Exception) -> Response:
        # Starlette invokes this inside an `except`, so the exception is active and
        # its traceback is captured; it goes to logs only, never to the client.
        logger.exception("unhandled error")  # noqa: LOG004
        return _problem(
            status=500,
            title="Internal Server Error",
            category="internal",
            detail=None,
            instance=request.url.path,
        )

    app.add_exception_handler(DomainError, _domain)
    app.add_exception_handler(RequestValidationError, _validation)
    app.add_exception_handler(Exception, _unhandled)

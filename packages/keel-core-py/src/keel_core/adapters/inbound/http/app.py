"""FastAPI application factory (ADR-0013).

Deny-by-default by construction: ``create_app`` requires an ``Authenticator``, so
an app cannot be built without one. It wires request-id propagation, problem+json
error handling, and health endpoints; business routers depend on
``app.state.require_principal`` for authentication.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING

from fastapi import FastAPI

from keel_core.adapters.inbound.http.health import ReadinessCheck, build_health_router
from keel_core.adapters.inbound.http.problem import register_exception_handlers
from keel_core.adapters.inbound.http.request_id import RequestIdMiddleware
from keel_core.adapters.inbound.http.security import principal_dependency
from keel_core.adapters.outbound.logging import StructuredLogger

if TYPE_CHECKING:
    from keel_core.ports.auth import Authenticator
    from keel_core.ports.logging import Logger


def create_app(
    *,
    service: str,
    version: str,
    authenticator: Authenticator,
    logger: Logger | None = None,
    readiness_checks: Sequence[ReadinessCheck] = (),
) -> FastAPI:
    """Build a FastAPI app wired with the platform's cross-cutting middleware.

    Args:
        service: logical service name (used in logs and OpenAPI title).
        version: service version.
        authenticator: required; its presence is what makes auth deny-by-default.
        logger: optional Logger; a StructuredLogger is created if omitted.
        readiness_checks: async callables gating ``/readyz``.
    """
    log: Logger = (
        logger if logger is not None else StructuredLogger(service=service, version=version)
    )
    app = FastAPI(title=service, version=version)
    # FastAPI/Starlette emit OTel spans natively once a provider is configured
    # (see keel_core.adapters.outbound.telemetry); the logger reads the active span.
    app.add_middleware(RequestIdMiddleware)
    register_exception_handlers(app, log)
    app.include_router(build_health_router(readiness_checks))
    app.state.require_principal = principal_dependency(authenticator)
    return app

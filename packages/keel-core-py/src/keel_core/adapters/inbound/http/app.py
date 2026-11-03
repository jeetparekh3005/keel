"""FastAPI application factory (ADR-0013).

Deny-by-default is **enforced**, not conventional: at startup a conformance check
fails if any non-exempt route lacks an auth dependency, so a route added without
``require_scopes``/``require_principal`` cannot ship. ``create_app`` also requires an
``Authenticator`` and wires request-id, security headers, a body-size limit,
problem+json errors, metrics, and health endpoints.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

from fastapi import FastAPI

from keel_core.adapters.inbound.http.conformance import assert_routes_require_auth
from keel_core.adapters.inbound.http.edge import BodyLimitMiddleware, SecurityHeadersMiddleware
from keel_core.adapters.inbound.http.health import ReadinessCheck, build_health_router
from keel_core.adapters.inbound.http.metrics import MetricsMiddleware
from keel_core.adapters.inbound.http.problem import register_exception_handlers
from keel_core.adapters.inbound.http.request_id import RequestIdMiddleware
from keel_core.adapters.inbound.http.security import principal_dependency
from keel_core.adapters.outbound.logging import StructuredLogger

if TYPE_CHECKING:
    from keel_core.ports.auth import Authenticator
    from keel_core.ports.logging import Logger


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Graceful shutdown: dispose the DB, stop the log writer, flush traces.

    Resources are read lazily from ``app.state`` so the composition root can set
    them after ``create_app`` returns (``database``, ``log_writer``, ``tracer_provider``).
    Startup fails if any non-exempt route lacks an auth dependency (deny-by-default).
    """
    assert_routes_require_auth(app)
    yield
    database = getattr(app.state, "database", None)
    if database is not None:
        await database.dispose()
    log_writer = getattr(app.state, "log_writer", None)
    if log_writer is not None:
        log_writer.stop()
    tracer_provider = getattr(app.state, "tracer_provider", None)
    if tracer_provider is not None:
        tracer_provider.shutdown()
    meter_provider = getattr(app.state, "meter_provider", None)
    if meter_provider is not None:
        meter_provider.shutdown()


def create_app(
    *,
    service: str,
    version: str,
    authenticator: Authenticator,
    logger: Logger | None = None,
    readiness_checks: Sequence[ReadinessCheck] = (),
    max_request_bytes: int = 1_048_576,
) -> FastAPI:
    """Build a FastAPI app wired with the platform's cross-cutting middleware.

    Args:
        service: logical service name (used in logs and OpenAPI title).
        version: service version.
        authenticator: required; its presence is what makes auth deny-by-default.
        logger: optional Logger; a StructuredLogger is created if omitted.
        readiness_checks: async callables gating ``/readyz``.
        max_request_bytes: reject requests whose Content-Length exceeds this (413).
    """
    log: Logger = (
        logger if logger is not None else StructuredLogger(service=service, version=version)
    )
    app = FastAPI(title=service, version=version, lifespan=_lifespan)
    # FastAPI/Starlette emit OTel spans natively once a provider is configured
    # (see keel_core.adapters.outbound.telemetry); the logger reads the active span.
    # Added inner-to-outer: body-limit runs first (rejects before any work).
    app.add_middleware(MetricsMiddleware)
    app.add_middleware(RequestIdMiddleware)
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(BodyLimitMiddleware, max_bytes=max_request_bytes)
    register_exception_handlers(app, log)
    app.include_router(build_health_router(readiness_checks))
    # Authenticator on state powers require_scopes/require_roles; require_principal is
    # the bound authn-only dependency for routers that don't need scope checks.
    app.state.authenticator = authenticator
    app.state.require_principal = principal_dependency(authenticator)
    return app

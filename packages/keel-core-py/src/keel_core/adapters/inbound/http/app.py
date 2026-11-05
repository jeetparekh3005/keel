"""FastAPI application factory (ADR-0013).

Deny-by-default is **enforced**, not conventional: at startup a conformance check
fails if any non-exempt route lacks an auth dependency, so a route added without
``require_scopes``/``require_principal`` cannot ship. ``create_app`` also requires an
``Authenticator`` and wires request-id, security headers, a body-size limit,
problem+json errors, metrics, and health endpoints.
"""

from __future__ import annotations

import contextlib
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

from fastapi import FastAPI
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from keel_core.adapters.inbound.http.conformance import assert_routes_require_auth
from keel_core.adapters.inbound.http.edge import BodyLimitMiddleware, SecurityHeadersMiddleware
from keel_core.adapters.inbound.http.health import ReadinessCheck, build_health_router
from keel_core.adapters.inbound.http.problem import register_exception_handlers
from keel_core.adapters.inbound.http.ratelimit import RateLimitMiddleware
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
    # Each step is isolated so one failure does not skip the rest, and the log
    # writer is stopped LAST so logs emitted during DB/tracer/meter shutdown are
    # still written.
    database = getattr(app.state, "database", None)
    if database is not None:
        with contextlib.suppress(Exception):
            await database.dispose()
    tracer_provider = getattr(app.state, "tracer_provider", None)
    if tracer_provider is not None:
        with contextlib.suppress(Exception):
            tracer_provider.shutdown()
    meter_provider = getattr(app.state, "meter_provider", None)
    if meter_provider is not None:
        with contextlib.suppress(Exception):
            meter_provider.shutdown()
    log_writer = getattr(app.state, "log_writer", None)
    if log_writer is not None:
        with contextlib.suppress(Exception):
            log_writer.stop()


def create_app(
    *,
    service: str,
    version: str,
    authenticator: Authenticator,
    logger: Logger | None = None,
    readiness_checks: Sequence[ReadinessCheck] = (),
    max_request_bytes: int = 1_048_576,
    expose_docs: bool = True,
    rate_limit: tuple[int, float] | None = None,
    cors_allow_origins: Sequence[str] = (),
    cors_allow_credentials: bool = False,
    trusted_hosts: Sequence[str] = (),
) -> FastAPI:
    """Build a FastAPI app wired with the platform's cross-cutting middleware.

    Args:
        service: logical service name (used in logs and OpenAPI title).
        version: service version.
        authenticator: required; its presence is what makes auth deny-by-default.
        logger: optional Logger; a StructuredLogger is created if omitted.
        readiness_checks: async callables gating ``/readyz``.
        max_request_bytes: reject requests whose Content-Length exceeds this (413).
        rate_limit: optional ``(max_requests, window_seconds)`` enabling the per-instance
            rate-limit middleware (defense-in-depth; the gateway is the primary control).
        expose_docs: serve the OpenAPI schema and Swagger/ReDoc UIs. Keep ``True``
            for local/dev; pass ``False`` in production so the API map is not
            disclosed anonymously (the schema and both doc UIs are disabled).
        cors_allow_origins: explicit allowed origins. **Default-deny**: empty means no
            CORS middleware, so browsers block all cross-origin requests. Origins must be
            listed explicitly (no implicit wildcard).
        cors_allow_credentials: allow credentialed cross-origin requests. Rejected with a
            wildcard origin (``*``), which the CORS spec forbids with credentials.
        trusted_hosts: if non-empty, only these Host headers are accepted (DNS-rebinding
            defense via Starlette's TrustedHostMiddleware); empty disables the check.
    """
    if "*" in cors_allow_origins and cors_allow_credentials:
        msg = "CORS: allow_credentials with a wildcard origin '*' is forbidden by the spec"
        raise ValueError(msg)
    log: Logger = (
        logger if logger is not None else StructuredLogger(service=service, version=version)
    )
    # Disabling ``openapi_url`` removes the schema and, with it, both doc UIs.
    if expose_docs:
        app = FastAPI(title=service, version=version, lifespan=_lifespan)
    else:
        app = FastAPI(
            title=service,
            version=version,
            lifespan=_lifespan,
            docs_url=None,
            redoc_url=None,
            openapi_url=None,
        )
    # FastAPI/Starlette emit OTel spans AND http.server.* metrics natively once a
    # provider is configured (see keel_core.adapters.outbound.telemetry); the native
    # ASGI instrumentation wraps the whole app, so it already records our
    # RateLimit/BodyLimit rejections (429/413) and the logger reads the active span.
    # We add no duplicate duration histogram of our own.
    #
    # add_middleware makes the LAST-added the OUTERMOST. Add inner-to-outer so the
    # final stack is (outer -> inner): CORS, RequestId, SecurityHeaders, RateLimit,
    # BodyLimit, app. Rejections carry the request-id and security headers - they are
    # not invisible to observability.
    app.add_middleware(BodyLimitMiddleware, max_bytes=max_request_bytes)
    if rate_limit is not None:
        max_requests, window_seconds = rate_limit
        app.add_middleware(
            RateLimitMiddleware, max_requests=max_requests, window_seconds=window_seconds
        )
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(RequestIdMiddleware)
    if trusted_hosts:
        # Reject mismatched Host headers (DNS-rebinding defense) before anything else.
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(trusted_hosts))
    if cors_allow_origins:
        # Outermost (preflight + headers on every response). Default-deny: only
        # applied when origins are explicitly listed.
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(cors_allow_origins),
            allow_credentials=cors_allow_credentials,
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
            allow_headers=["authorization", "content-type", "x-api-key"],
        )
    register_exception_handlers(app, log)
    app.include_router(build_health_router(readiness_checks))
    # Authenticator on state powers require_scopes/require_roles; require_principal is
    # the bound authn-only dependency for routers that don't need scope checks.
    app.state.authenticator = authenticator
    app.state.require_principal = principal_dependency(authenticator)
    return app

"""Route-auth conformance: every non-exempt route must carry an auth dependency.

This is what makes deny-by-default real rather than a convention: an unprotected
business route fails app startup (and the shipped test), so forgetting the auth
dependency can't ship silently.
"""

from __future__ import annotations

from collections.abc import Iterable

from fastapi import FastAPI
from fastapi.routing import APIRoute, APIWebSocketRoute

DEFAULT_EXEMPT: frozenset[str] = frozenset(
    {"/healthz", "/readyz", "/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"},
)


def _route_has_auth(route: APIRoute | APIWebSocketRoute) -> bool:
    stack = list(route.dependant.dependencies)
    while stack:
        dependant = stack.pop()
        if getattr(dependant.call, "__keel_auth__", False):
            return True
        stack.extend(dependant.dependencies)
    return False


def unprotected_routes(app: FastAPI, *, exempt: Iterable[str] = DEFAULT_EXEMPT) -> list[str]:
    """Return a label for every non-exempt route not provably carrying auth.

    Covers HTTP and WebSocket routes. A non-exempt route of a type we cannot
    inspect for an auth dependency (a raw Starlette Route or a Mount) is reported
    too, so it must be explicitly exempted rather than silently allowed through.
    """
    exempt_set = set(exempt)
    missing: list[str] = []
    for route in app.routes:
        path = getattr(route, "path", None)
        if path is None or path in exempt_set:
            continue
        if isinstance(route, APIRoute):
            if not _route_has_auth(route):
                missing.append(f"{','.join(sorted(route.methods or set()))} {path}")
        elif isinstance(route, APIWebSocketRoute):
            if not _route_has_auth(route):
                missing.append(f"WS {path}")
        else:
            # Raw Starlette Route / Mount: no dependant to inspect, so it cannot be
            # proven protected. Deny by default; the service must exempt it explicitly.
            missing.append(f"UNVERIFIED {path}")
    return missing


def assert_routes_require_auth(app: FastAPI, *, exempt: Iterable[str] = DEFAULT_EXEMPT) -> None:
    """Raise if any non-exempt route lacks an auth dependency (deny-by-default)."""
    missing = unprotected_routes(app, exempt=exempt)
    if missing:
        msg = f"deny-by-default violation: routes without an auth dependency: {', '.join(missing)}"
        raise RuntimeError(msg)

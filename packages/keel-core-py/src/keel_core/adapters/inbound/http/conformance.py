"""Route-auth conformance: every non-exempt route must carry an auth dependency.

This is what makes deny-by-default real rather than a convention: an unprotected
business route fails app startup (and the shipped test), so forgetting the auth
dependency can't ship silently.
"""

from __future__ import annotations

from collections.abc import Iterable

from fastapi import FastAPI
from fastapi.routing import APIRoute

DEFAULT_EXEMPT: frozenset[str] = frozenset(
    {"/healthz", "/readyz", "/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"},
)


def _route_has_auth(route: APIRoute) -> bool:
    stack = list(route.dependant.dependencies)
    while stack:
        dependant = stack.pop()
        if getattr(dependant.call, "__keel_auth__", False):
            return True
        stack.extend(dependant.dependencies)
    return False


def unprotected_routes(app: FastAPI, *, exempt: Iterable[str] = DEFAULT_EXEMPT) -> list[str]:
    """Return ``"METHODS path"`` for every non-exempt route lacking an auth dependency."""
    exempt_set = set(exempt)
    missing: list[str] = []
    for route in app.routes:
        if not isinstance(route, APIRoute) or route.path in exempt_set:
            continue
        if not _route_has_auth(route):
            methods = ",".join(sorted(route.methods or set()))
            missing.append(f"{methods} {route.path}")
    return missing


def assert_routes_require_auth(app: FastAPI, *, exempt: Iterable[str] = DEFAULT_EXEMPT) -> None:
    """Raise if any non-exempt route lacks an auth dependency (deny-by-default)."""
    missing = unprotected_routes(app, exempt=exempt)
    if missing:
        msg = f"deny-by-default violation: routes without an auth dependency: {', '.join(missing)}"
        raise RuntimeError(msg)

"""FastAPI inbound HTTP adapter: app factory, problem+json, health, auth."""

from keel_core.adapters.inbound.http.app import create_app
from keel_core.adapters.inbound.http.conformance import (
    assert_routes_require_auth,
    unprotected_routes,
)
from keel_core.adapters.inbound.http.ratelimit import RateLimitMiddleware
from keel_core.adapters.inbound.http.security import require_roles, require_scopes

__all__ = [
    "RateLimitMiddleware",
    "assert_routes_require_auth",
    "create_app",
    "require_roles",
    "require_scopes",
    "unprotected_routes",
]

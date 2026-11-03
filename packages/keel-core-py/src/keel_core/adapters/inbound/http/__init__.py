"""FastAPI inbound HTTP adapter: app factory, problem+json, health, auth."""

from keel_core.adapters.inbound.http.app import create_app
from keel_core.adapters.inbound.http.security import require_roles, require_scopes

__all__ = ["create_app", "require_roles", "require_scopes"]

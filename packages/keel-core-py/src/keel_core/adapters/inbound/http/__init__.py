"""FastAPI inbound HTTP adapter: app factory, problem+json, health, auth."""

from keel_core.adapters.inbound.http.app import create_app

__all__ = ["create_app"]

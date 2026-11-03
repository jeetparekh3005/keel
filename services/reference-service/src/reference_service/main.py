"""ASGI entrypoint: configure observability and build the app with real adapters.

Run with: ``uvicorn reference_service.main:app``.
"""

from __future__ import annotations

from fastapi import FastAPI

from keel_core.adapters.outbound.auth import OIDCAuthenticator
from keel_core.adapters.outbound.logging import configure_logging
from keel_core.adapters.outbound.telemetry import configure_tracing
from reference_service.composition import build_app
from reference_service.config import ReferenceConfig


def create_application() -> FastAPI:
    """Build the production application (observability + OIDC + composed app)."""
    config = ReferenceConfig()
    configure_logging(service=config.service_name, version=config.version, level=config.log_level)
    configure_tracing(service=config.service_name, version=config.version)
    authenticator = OIDCAuthenticator.from_jwks(
        jwks_uri=config.oidc_jwks_uri,
        issuer=config.oidc_issuer,
        audience=config.oidc_audience,
    )
    return build_app(config, authenticator=authenticator)


app = create_application()

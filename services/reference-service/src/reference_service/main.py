"""ASGI entrypoint: configure observability and build the app with real adapters.

Run with: ``uvicorn reference_service.main:app``.
"""

from __future__ import annotations

import uvicorn
from fastapi import FastAPI

from keel_core.adapters.outbound.auth import OIDCAuthenticator
from keel_core.adapters.outbound.logging import StructuredLogger, configure_logging
from keel_core.adapters.outbound.telemetry import configure_tracing
from reference_service.composition import build_app
from reference_service.config import ReferenceConfig


def create_application() -> FastAPI:
    """Build the production application (observability + OIDC + composed app)."""
    config = ReferenceConfig()

    # Non-blocking logging: the background writer sinks both the app logger and
    # (via configure_logging) third-party stdlib logs; stopped in the lifespan.
    log_writer = configure_logging(
        service=config.service_name, version=config.version, level=config.log_level
    )
    logger = StructuredLogger(
        service=config.service_name,
        version=config.version,
        level=config.log_level,
        stream=log_writer,
    )

    exporter = None
    if config.otlp_endpoint:
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter

        exporter = OTLPSpanExporter(endpoint=config.otlp_endpoint, insecure=True)
    tracer_provider = configure_tracing(
        service=config.service_name, version=config.version, exporter=exporter
    )

    authenticator = OIDCAuthenticator.from_jwks(
        jwks_uri=config.oidc_jwks_uri,
        issuer=config.oidc_issuer,
        audience=config.oidc_audience,
    )
    app = build_app(config, authenticator=authenticator, logger=logger)
    app.state.log_writer = log_writer
    app.state.tracer_provider = tracer_provider
    return app


app = create_application()


def serve() -> None:
    """Run the service with uvicorn (container entrypoint)."""
    uvicorn.run(app, host="0.0.0.0", port=8000)  # noqa: S104  # bind all in container


if __name__ == "__main__":
    serve()

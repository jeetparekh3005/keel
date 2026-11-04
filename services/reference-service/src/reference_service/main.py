"""ASGI entrypoint: configure observability and build the app with real adapters.

Run with: ``uvicorn reference_service.main:app``.
"""

from __future__ import annotations

from typing import cast

import uvicorn
from fastapi import FastAPI

from keel_core.adapters.outbound.auth import OIDCAuthenticator
from keel_core.adapters.outbound.logging import StructuredLogger, configure_logging
from keel_core.adapters.outbound.persistence import Database
from keel_core.adapters.outbound.telemetry import (
    configure_metrics,
    configure_tracing,
    observe_db_pool,
    observe_log_drops,
)
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
    metric_reader = None
    if config.otlp_endpoint:  # pragma: no cover - requires a live OTLP collector
        from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader

        exporter = OTLPSpanExporter(endpoint=config.otlp_endpoint, insecure=True)
        metric_reader = PeriodicExportingMetricReader(
            OTLPMetricExporter(endpoint=config.otlp_endpoint, insecure=True)
        )
    tracer_provider = configure_tracing(
        service=config.service_name, version=config.version, exporter=exporter
    )
    meter_provider = configure_metrics(
        service=config.service_name, version=config.version, reader=metric_reader
    )

    if not (config.oidc_issuer and config.oidc_audience and config.oidc_jwks_uri):
        msg = "OIDC config required: set KEEL_OIDC_ISSUER, KEEL_OIDC_AUDIENCE, KEEL_OIDC_JWKS_URI"
        raise RuntimeError(msg)
    authenticator = OIDCAuthenticator.from_jwks(
        jwks_uri=config.oidc_jwks_uri,
        issuer=config.oidc_issuer,
        audience=config.oidc_audience,
    )
    app = build_app(config, authenticator=authenticator, logger=logger)
    app.state.log_writer = log_writer
    app.state.tracer_provider = tracer_provider
    app.state.meter_provider = meter_provider
    # Saturation signals (fourth golden signal): pool usage + dropped logs.
    observe_db_pool(cast("Database", app.state.database))
    if log_writer is not None:
        observe_log_drops(log_writer)
    return app


app = create_application()


def serve() -> None:  # pragma: no cover - process entrypoint
    """Run the service with uvicorn (container entrypoint)."""
    uvicorn.run(app, host="0.0.0.0", port=8000)  # noqa: S104  # bind all in container


if __name__ == "__main__":  # pragma: no cover
    serve()

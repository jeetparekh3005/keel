"""OpenTelemetry tracing setup (platform.yaml telemetry; ADR-0012)."""

from keel_core.adapters.outbound.telemetry.otel import (
    configure_tracing,
    get_tracer,
    shutdown_tracing,
)

__all__ = ["configure_tracing", "get_tracer", "shutdown_tracing"]

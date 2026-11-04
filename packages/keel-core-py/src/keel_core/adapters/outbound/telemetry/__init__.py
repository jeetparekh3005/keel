"""OpenTelemetry tracing setup (platform.yaml telemetry; ADR-0012)."""

from keel_core.adapters.outbound.telemetry.metrics import configure_metrics, get_meter
from keel_core.adapters.outbound.telemetry.otel import (
    configure_tracing,
    get_tracer,
    shutdown_tracing,
)
from keel_core.adapters.outbound.telemetry.saturation import observe_db_pool, observe_log_drops

__all__ = [
    "configure_metrics",
    "configure_tracing",
    "get_meter",
    "get_tracer",
    "observe_db_pool",
    "observe_log_drops",
    "shutdown_tracing",
]

"""OpenTelemetry metrics setup (platform.yaml telemetry Meter; ADR-0012).

Vendor-neutral: metrics go to whatever reader/exporter is supplied (OTLP in
production, an in-memory reader in tests). With no reader, a no-op meter is used.
"""

from __future__ import annotations

from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import MetricReader
from opentelemetry.sdk.resources import Resource


def configure_metrics(
    *,
    service: str,
    version: str,
    reader: MetricReader | None = None,
) -> MeterProvider:
    """Install a global MeterProvider for ``service``; collect metrics via ``reader``.

    Call once at startup. In production pass a `PeriodicExportingMetricReader` with an
    OTLP exporter; in tests pass an `InMemoryMetricReader`.
    """
    resource = Resource.create({"service.name": service, "service.version": version})
    readers = [reader] if reader is not None else []
    provider = MeterProvider(resource=resource, metric_readers=readers)
    metrics.set_meter_provider(provider)
    return provider


def get_meter(name: str) -> metrics.Meter:
    """Return a meter from the global provider (a no-op meter if unconfigured)."""
    return metrics.get_meter(name)

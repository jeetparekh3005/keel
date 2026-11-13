"""OpenTelemetry tracer provider setup.

Vendor-neutral: spans go to whatever exporter is supplied (an OTLP exporter in
production, an in-memory one in tests). W3C tracecontext propagation is the OTel
default, so inbound/outbound trace continuation works across services.
"""

from __future__ import annotations

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import (
    BatchSpanProcessor,
    SimpleSpanProcessor,
    SpanExporter,
)

from keel_core.adapters.outbound.telemetry.redacting_exporter import RedactingSpanExporter


def configure_tracing(
    *,
    service: str,
    version: str,
    exporter: SpanExporter | None = None,
    batch: bool = True,
    redact: bool = True,
) -> TracerProvider:
    """Install a global TracerProvider for ``service``; export spans if an exporter is given.

    Safe to call once at startup. In production pass an OTLP exporter (``batch=True``
    uses a non-blocking BatchSpanProcessor). Tests pass an in-memory exporter with
    ``batch=False`` so spans are available synchronously. With no exporter, spans are
    created but not exported. Call ``provider.shutdown()`` at shutdown to flush.

    ``redact`` (default on) wraps the exporter in :class:`RedactingSpanExporter` so
    secrets in span attributes, event attributes, and exception details are scrubbed
    on the way out with the same policy as the JSON log sink. Pass ``redact=False``
    only when the supplied exporter already redacts.
    """
    resource = Resource.create({"service.name": service, "service.version": version})
    provider = TracerProvider(resource=resource)
    if exporter is not None:
        exported = RedactingSpanExporter(exporter) if redact else exporter
        processor = BatchSpanProcessor(exported) if batch else SimpleSpanProcessor(exported)
        provider.add_span_processor(processor)
    trace.set_tracer_provider(provider)
    return provider


def get_tracer(name: str) -> trace.Tracer:
    """Return a tracer from the global provider (a no-op tracer if unconfigured)."""
    return trace.get_tracer(name)


def shutdown_tracing(provider: TracerProvider) -> None:
    """Flush and shut down the provider (call at service shutdown)."""
    provider.shutdown()

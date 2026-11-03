"""OpenTelemetry tracer provider setup.

Vendor-neutral: spans go to whatever exporter is supplied (an OTLP exporter in
production, an in-memory one in tests). W3C tracecontext propagation is the OTel
default, so inbound/outbound trace continuation works across services.
"""

from __future__ import annotations

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter


def configure_tracing(
    *,
    service: str,
    version: str,
    exporter: SpanExporter | None = None,
) -> TracerProvider:
    """Install a global TracerProvider for ``service``; export spans if an exporter is given.

    Safe to call once at startup. In production pass an OTLP exporter; in tests pass
    an in-memory exporter. With no exporter, spans are created but not exported.
    """
    resource = Resource.create({"service.name": service, "service.version": version})
    provider = TracerProvider(resource=resource)
    if exporter is not None:
        provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    return provider


def get_tracer(name: str) -> trace.Tracer:
    """Return a tracer from the global provider (a no-op tracer if unconfigured)."""
    return trace.get_tracer(name)


def shutdown_tracing(provider: TracerProvider) -> None:
    """Flush and shut down the provider (call at service shutdown)."""
    provider.shutdown()

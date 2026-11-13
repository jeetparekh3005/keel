"""Secrets must not leave the process through exported spans (epic #419, v0.6 parity).

The log sink already redacts; these tests pin the same guarantee on the OTLP
span-export path via :class:`RedactingSpanExporter`. Each test drives a real span
through a local provider (not the global one configured in ``test_tracing.py``) so
``set_tracer_provider`` is never touched.
"""

from __future__ import annotations

from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from keel_core.adapters.outbound.telemetry import RedactingSpanExporter

# A secret-family attribute KEY and a value carrying a high-precision pattern (AWS key).
_SECRET_KEY = "password"
_PLAINTEXT = "hunter2-correct-horse"
_AWS_KEY = "AKIAIOSFODNN7EXAMPLE"
_NOTE = f"caller used {_AWS_KEY} to auth"


def _export_one(exporter: InMemorySpanExporter, *, wrap: bool):
    """Create a span with a secret key and a pattern secret, export, return the exported span."""
    provider = TracerProvider()
    sink = RedactingSpanExporter(exporter) if wrap else exporter
    provider.add_span_processor(SimpleSpanProcessor(sink))
    tracer = provider.get_tracer("test-span-redaction")
    with tracer.start_as_current_span("op") as span:
        span.set_attribute(_SECRET_KEY, _PLAINTEXT)
        span.set_attribute("note", _NOTE)
        span.add_event("boom", attributes={"authorization": "Bearer abcdef123456", "ok": "fine"})
    provider.force_flush()
    spans = exporter.get_finished_spans()
    assert len(spans) == 1
    return spans[0]


def test_exported_span_attributes_are_redacted():
    span = _export_one(InMemorySpanExporter(), wrap=True)

    # Secret-family KEY -> fully redacted, plaintext value gone entirely.
    assert span.attributes["password"] == "[REDACTED]"
    assert _PLAINTEXT not in str(span.attributes["password"])

    # Secret PATTERN inside a non-secret string value -> scrubbed in place.
    assert span.attributes["note"] == "caller used [REDACTED] to auth"
    assert _AWS_KEY not in span.attributes["note"]


def test_exported_span_event_attributes_are_redacted():
    span = _export_one(InMemorySpanExporter(), wrap=True)

    (event,) = span.events
    assert event.attributes["authorization"] == "[REDACTED]"
    assert "abcdef123456" not in str(event.attributes["authorization"])
    assert event.attributes["ok"] == "fine"  # non-secret attribute untouched


def test_negative_control_bare_exporter_leaks():
    """Without the redactor the same secrets survive export.

    Pins the assertions above as non-vacuous: if ``RedactingSpanExporter`` is removed
    (``wrap=False``), the plaintext password and AWS key reach the exporter in the
    clear, and this test is what would start passing in their place.
    """
    span = _export_one(InMemorySpanExporter(), wrap=False)

    assert span.attributes["password"] == _PLAINTEXT
    assert _AWS_KEY in span.attributes["note"]

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
from opentelemetry.trace import Link, SpanContext, TraceFlags

from keel_core.adapters.outbound.redaction import REDACTED
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


# A linked span's context plus a link attribute bag carrying a secret-family key and a
# secret-pattern string value, exactly as a cross-trace link would carry them.
_LINK_CONTEXT = SpanContext(
    trace_id=0x0123456789ABCDEF0123456789ABCDEF,
    span_id=0x0123456789ABCDEF,
    is_remote=True,
    trace_flags=TraceFlags(TraceFlags.SAMPLED),
)
_LINK_SECRET = "hunter2-link-secret"
_LINK_BEARER = "Bearer abcdef1234567890"


def _export_with_link(exporter: InMemorySpanExporter):
    """Export a span carrying a link whose attributes mix a secret key and a secret pattern."""
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(RedactingSpanExporter(exporter)))
    tracer = provider.get_tracer("test-span-redaction")
    link = Link(
        _LINK_CONTEXT,
        attributes={
            "db.user.password": _LINK_SECRET,  # secret-family key
            "http.url": f"https://api/x?auth={_LINK_BEARER}",  # secret pattern in value
            "peer.service": "billing",  # non-secret control
        },
    )
    with tracer.start_as_current_span("op", links=[link]):
        pass
    provider.force_flush()
    spans = exporter.get_finished_spans()
    assert len(spans) == 1
    return spans[0]


def test_exported_span_link_attributes_are_redacted():
    span = _export_with_link(InMemorySpanExporter())

    (link,) = span.links
    # The linked SpanContext is preserved verbatim.
    assert link.context.trace_id == _LINK_CONTEXT.trace_id
    assert link.context.span_id == _LINK_CONTEXT.span_id

    # Secret-family KEY -> fully redacted, plaintext gone.
    assert link.attributes["db.user.password"] == "[REDACTED]"
    assert _LINK_SECRET not in str(link.attributes["db.user.password"])

    # Secret PATTERN inside a non-secret value -> scrubbed in place.
    assert "abcdef1234567890" not in link.attributes["http.url"]
    assert "[REDACTED]" in link.attributes["http.url"]

    # Negative control: a non-secret link attribute survives unchanged.
    assert link.attributes["peer.service"] == "billing"


def test_secret_in_span_name_is_scrubbed():
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(RedactingSpanExporter(exporter)))
    tracer = provider.get_tracer("test-span-redaction")
    # An operation name built from user input that embeds a bearer token must not reach
    # the collector in the clear.
    with tracer.start_as_current_span(f"GET /proxy?auth={_LINK_BEARER}"):
        pass
    with tracer.start_as_current_span("GET /items"):  # normal name, must be untouched
        pass
    provider.force_flush()
    tainted, normal = exporter.get_finished_spans()

    assert "abcdef1234567890" not in tainted.name
    assert "[REDACTED]" in tainted.name
    assert normal.name == "GET /items"


# A Luhn-valid 16-digit id (a test Visa number) embedded in a route, plus an AWS access
# key id, both carried in a span name. The first is a legitimate low-cardinality path id
# that must survive; the second is a real secret that must still be scrubbed.
_LUHN_ID = "4532015112830366"
_PAN_SPAN_NAME = f"GET /v1/accounts/{_LUHN_ID}/balance"
_AWS_SPAN_NAME = f"GET /proxy?key={_AWS_KEY}"


def _export_named_span(exporter: InMemorySpanExporter, name: str):
    """Export a single span with ``name`` and return the exported (redacted) span."""
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(RedactingSpanExporter(exporter)))
    tracer = provider.get_tracer("test-span-redaction")
    with tracer.start_as_current_span(name):
        pass
    provider.force_flush()
    (span,) = exporter.get_finished_spans()
    return span


def test_span_name_with_luhn_id_is_preserved():
    """A Luhn-valid numeric path id in a span name must not be mistaken for a PAN.

    Span names are low-cardinality operation identifiers, so a numeric id in the route
    (account number, order id) is part of the name, not a leaked card number. The PAN
    matcher is skipped for names; before the fix it rewrote the id to ``[REDACTED]``.
    """
    span = _export_named_span(InMemorySpanExporter(), _PAN_SPAN_NAME)

    assert span.name == _PAN_SPAN_NAME
    assert _LUHN_ID in span.name
    assert REDACTED not in span.name


def test_span_name_still_scrubs_non_pan_secret():
    """Skipping the PAN matcher for names must not disarm the other matchers.

    A bearer/JWT/AWS-key/PEM secret embedded in a span name is still a leak and must be
    scrubbed; only the PAN/Luhn matcher is suppressed for names.
    """
    span = _export_named_span(InMemorySpanExporter(), _AWS_SPAN_NAME)

    assert _AWS_KEY not in span.name
    assert REDACTED in span.name


def test_span_attribute_value_still_redacts_pan():
    """The full value scrubber (attributes/events/links) must keep PAN redaction.

    Only span names skip the PAN matcher; a Luhn-valid card number in a free-form
    attribute value is still a leak and must be redacted by the unchanged ``scrub_text``.
    """
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(RedactingSpanExporter(exporter)))
    tracer = provider.get_tracer("test-span-redaction")
    with tracer.start_as_current_span("charge") as span:
        span.set_attribute("note", f"card {_LUHN_ID} declined")
    provider.force_flush()
    (exported,) = exporter.get_finished_spans()

    assert _LUHN_ID not in exported.attributes["note"]
    assert REDACTED in str(exported.attributes["note"])

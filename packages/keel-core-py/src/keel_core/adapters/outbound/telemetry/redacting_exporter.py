"""Secret redaction on the span-export path.

A span's attributes, events, and exception details are exported to a backend just
like a log line is written to the sink, so they get the same treatment: without
this, a ``db.statement``, an ``http.url`` with a bearer token, or a
``password`` attribute would leave the process in the clear even though the log
sink redacts the identical value. This decorator wraps the real exporter and
rewrites every :class:`ReadableSpan` through the shared redactor
(:mod:`keel_core.adapters.outbound.redaction`) before delegating, so there is one
redaction policy for both egress paths and no duplicated patterns.

Spans are rebuilt (not mutated in place): a :class:`ReadableSpan` is shared with
every other processor on the provider, so mutating it would corrupt a sibling
exporter. Rebuilding keeps the redaction local to this exporter.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING

from opentelemetry.sdk.trace import Event, ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult

from keel_core.adapters.outbound.redaction import (
    REDACTED,
    is_secret_key,
    sanitize,
)

if TYPE_CHECKING:
    from opentelemetry.util.types import AttributeValue


def _redact_attributes(
    attributes: Mapping[str, AttributeValue] | None,
) -> dict[str, AttributeValue]:
    """Redact a span/event attribute mapping: secret keys dropped, string values scrubbed.

    Attribute values are OTLP primitives (str, bool, int, float) or homogeneous
    sequences of them; :func:`sanitize` redacts secret-family keys to ``[REDACTED]``
    and scrubs secret patterns out of strings while leaving numbers and bools intact.
    """
    if not attributes:
        return {}
    out: dict[str, AttributeValue] = {}
    for key, value in attributes.items():
        if is_secret_key(key):
            out[key] = REDACTED
        else:
            # sanitize handles str scrubbing and recurses into sequence values; non-string
            # primitives (int/float/bool) pass through unchanged.
            out[key] = sanitize(value)  # type: ignore[assignment]
    return out


def _redact_events(events: Sequence[Event]) -> list[Event]:
    """Rebuild span events with redacted attributes (covers exception events too).

    OTel records a raised exception as an ``exception`` event whose attributes
    (``exception.message``, ``exception.stacktrace``) can carry a leaked secret, so
    they run through the same scrubber as every other attribute.
    """
    return [
        Event(
            name=event.name,
            attributes=_redact_attributes(event.attributes),
            timestamp=event.timestamp,
        )
        for event in events
    ]


def _redact_span(span: ReadableSpan) -> ReadableSpan:
    return ReadableSpan(
        name=span.name,
        context=span.context,
        parent=span.parent,
        resource=span.resource,
        attributes=_redact_attributes(span.attributes),
        events=_redact_events(span.events),
        links=span.links,
        kind=span.kind,
        status=span.status,
        start_time=span.start_time,
        end_time=span.end_time,
        instrumentation_scope=span.instrumentation_scope,
    )


class RedactingSpanExporter(SpanExporter):
    """SpanExporter decorator that scrubs secrets from spans before the wrapped exporter sees them.

    Wrap the real exporter (OTLP in production, in-memory in tests) so exported span
    attributes, event attributes, and exception details carry the same ``[REDACTED]``
    treatment as the JSON log sink. ``force_flush`` and ``shutdown`` delegate straight
    through so batching/lifecycle semantics are unchanged.
    """

    def __init__(self, wrapped: SpanExporter) -> None:
        """Wrap ``wrapped`` (the real span exporter) with per-span redaction."""
        self._wrapped = wrapped

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        """Redact every span, then delegate to the wrapped exporter."""
        return self._wrapped.export([_redact_span(span) for span in spans])

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        """Delegate flush to the wrapped exporter."""
        return self._wrapped.force_flush(timeout_millis)

    def shutdown(self) -> None:
        """Delegate shutdown to the wrapped exporter."""
        self._wrapped.shutdown()

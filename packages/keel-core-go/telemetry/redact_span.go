package telemetry

import (
	"context"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/logging"
)

// redactingExporter decorates a span exporter, applying the same secret redaction the log
// sink uses to exported span attributes before delegating. Without it, span attributes reach
// the collector raw even though the log sink redacts the same fields: a secret could leak via
// a trace. Attributes are rewritten, never dropped, so the span shape is preserved.
type redactingExporter struct {
	inner sdktrace.SpanExporter
}

// newRedactingExporter wraps inner so every exported span is redacted before export.
func newRedactingExporter(inner sdktrace.SpanExporter) sdktrace.SpanExporter {
	return redactingExporter{inner: inner}
}

// ExportSpans redacts each span's attributes, events, and links, then delegates to the
// wrapped exporter.
func (e redactingExporter) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
	out := make([]sdktrace.ReadOnlySpan, len(spans))
	for i, span := range spans {
		out[i] = redactedSpan{
			ReadOnlySpan: span,
			attrs:        redactAttributes(span.Attributes()),
			events:       redactEvents(span.Events()),
			links:        redactLinks(span.Links()),
		}
	}
	return e.inner.ExportSpans(ctx, out)
}

// Shutdown delegates to the wrapped exporter.
func (e redactingExporter) Shutdown(ctx context.Context) error {
	return e.inner.Shutdown(ctx)
}

// redactedSpan wraps a ReadOnlySpan, overriding the attribute-bearing accessors to return the
// redacted sets. ReadOnlySpan has unexported methods, so the inner span is embedded to satisfy
// the interface; every other method is promoted unchanged. Events() and Links() must be
// overridden too: a secret recorded on an exception/error event (span.RecordError) or on a
// link would otherwise reach the collector in cleartext via the promoted methods.
type redactedSpan struct {
	sdktrace.ReadOnlySpan
	attrs  []attribute.KeyValue
	events []sdktrace.Event
	links  []sdktrace.Link
}

// Attributes returns the redacted attribute set, shadowing the embedded span's method.
func (s redactedSpan) Attributes() []attribute.KeyValue { return s.attrs }

// Events returns the span's events with each event's attributes redacted, shadowing the
// embedded span's method.
func (s redactedSpan) Events() []sdktrace.Event { return s.events }

// Links returns the span's links with each link's attributes redacted, shadowing the embedded
// span's method.
func (s redactedSpan) Links() []sdktrace.Link { return s.links }

// redactEvents copies each event, rewriting only its attributes through redactAttributes.
// The event name, timestamp, and dropped-attribute count are preserved so the span shape is
// unchanged.
func redactEvents(events []sdktrace.Event) []sdktrace.Event {
	out := make([]sdktrace.Event, len(events))
	for i, ev := range events {
		ev.Attributes = redactAttributes(ev.Attributes)
		out[i] = ev
	}
	return out
}

// redactLinks copies each link, rewriting only its attributes through redactAttributes. The
// linked span context and dropped-attribute count are preserved.
func redactLinks(links []sdktrace.Link) []sdktrace.Link {
	out := make([]sdktrace.Link, len(links))
	for i, ln := range links {
		ln.Attributes = redactAttributes(ln.Attributes)
		out[i] = ln
	}
	return out
}

// redactAttributes applies the log sink's redaction to a span attribute set: a secret-family
// key is replaced with the redaction marker wholesale, and a string value is scrubbed for
// secret patterns. Non-string values pass through unchanged, mirroring the log sink which
// does not descend into composite values.
func redactAttributes(attrs []attribute.KeyValue) []attribute.KeyValue {
	out := make([]attribute.KeyValue, len(attrs))
	for i, kv := range attrs {
		key := string(kv.Key)
		switch {
		case logging.IsSecretKey(key):
			out[i] = attribute.String(key, logging.Redacted)
		case kv.Value.Type() == attribute.STRING:
			out[i] = attribute.String(key, logging.ScrubText(kv.Value.AsString()))
		default:
			out[i] = kv
		}
	}
	return out
}

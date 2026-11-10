package telemetry

import (
	"context"
	"log/slog"

	"go.opentelemetry.io/otel/trace"
)

// correlatingHandler wraps a slog.Handler and stamps trace_id/span_id onto every record
// emitted inside an active span, so a log line can be joined to its trace. This is the
// log-to-trace correlation the Rust vertical does not yet emit; Go's context-aware slog
// makes it a thin wrapper.
type correlatingHandler struct {
	inner slog.Handler
}

func (h correlatingHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.inner.Enabled(ctx, level)
}

func (h correlatingHandler) Handle(ctx context.Context, record slog.Record) error {
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		record.AddAttrs(
			slog.String("trace_id", sc.TraceID().String()),
			slog.String("span_id", sc.SpanID().String()),
		)
	}
	return h.inner.Handle(ctx, record)
}

func (h correlatingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return correlatingHandler{inner: h.inner.WithAttrs(attrs)}
}

func (h correlatingHandler) WithGroup(name string) slog.Handler {
	return correlatingHandler{inner: h.inner.WithGroup(name)}
}

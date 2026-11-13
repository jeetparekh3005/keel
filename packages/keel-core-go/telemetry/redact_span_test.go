package telemetry

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

// secretKeyAttr carries a secret-family attribute key; its value must be redacted wholesale.
const secretKeyAttr = "authorization"

// patternAttr carries a non-secret key whose string value embeds a secret pattern (a bearer
// token); the token must be scrubbed while the surrounding text survives.
const (
	patternAttr    = "db.statement"
	patternRawVal  = "fetch with Bearer abcdef1234567890 header"
	patternWantVal = "fetch with [REDACTED] header"
)

// exportOneSpan starts, annotates, and ends a single span against exporter, then shuts the
// provider down so the span is flushed. It returns the attribute set the exporter received.
func exportOneSpan(t *testing.T, exporter sdktrace.SpanExporter, inmem *tracetest.InMemoryExporter) map[string]string {
	t.Helper()
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
		sdktrace.WithSyncer(exporter),
	)
	_, span := tp.Tracer("test").Start(context.Background(), "op")
	span.SetAttributes(
		attribute.String(secretKeyAttr, "Bearer supersecretvalue1234"),
		attribute.String(patternAttr, patternRawVal),
		attribute.Int("http.status_code", 200),
	)
	// The sync processor exports on End; read before shutting down, since the in-memory
	// exporter's Shutdown resets its buffer.
	span.End()
	stubs := inmem.GetSpans()
	if len(stubs) != 1 {
		t.Fatalf("expected 1 exported span, got %d", len(stubs))
	}
	if err := tp.Shutdown(context.Background()); err != nil {
		t.Fatalf("provider shutdown: %v", err)
	}
	got := map[string]string{}
	for _, kv := range stubs[0].Attributes {
		if kv.Value.Type() == attribute.STRING {
			got[string(kv.Key)] = kv.Value.AsString()
		}
	}
	return got
}

// TestSpanExportRedactsSecrets asserts the redacting exporter replaces a secret-family key's
// value wholesale and scrubs a secret pattern out of a string value before export.
func TestSpanExportRedactsSecrets(t *testing.T) {
	inmem := tracetest.NewInMemoryExporter()
	got := exportOneSpan(t, newRedactingExporter(inmem), inmem)

	if got[secretKeyAttr] != "[REDACTED]" {
		t.Errorf("secret-family attribute not redacted: %q = %q", secretKeyAttr, got[secretKeyAttr])
	}
	if got[patternAttr] != patternWantVal {
		t.Errorf("secret pattern not scrubbed: %q = %q, want %q", patternAttr, got[patternAttr], patternWantVal)
	}
}

// TestSpanExportWithoutRedactorLeaksSecrets is the negative control: the bare in-memory
// exporter (no redactor) exports the raw secret attributes. It proves the redaction in
// TestSpanExportRedactsSecrets comes from the wrapper and not from the SDK or the test setup,
// so removing the wrapper makes the suite fail.
func TestSpanExportWithoutRedactorLeaksSecrets(t *testing.T) {
	inmem := tracetest.NewInMemoryExporter()
	got := exportOneSpan(t, inmem, inmem)

	if got[secretKeyAttr] == "[REDACTED]" {
		t.Errorf("expected raw secret-family value without the redactor, got redacted")
	}
	if got[patternAttr] != patternRawVal {
		t.Errorf("expected raw value %q without the redactor, got %q", patternRawVal, got[patternAttr])
	}
}

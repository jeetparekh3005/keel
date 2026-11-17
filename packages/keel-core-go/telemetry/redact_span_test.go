package telemetry

import (
	"context"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

// eventSecretVal is the cleartext secret placed on a span event's secret-family attribute; it
// must never reach the exporter.
const eventSecretVal = "Bearer eventsupersecret9876"

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

// TestSpanExportRedactsEventAttributes asserts the redacting exporter also scrubs span EVENTS,
// not just top-level attributes: an event (as added by span.AddEvent or span.RecordError)
// carrying a secret-family attribute and a scrubbable string value must reach the exporter
// with the secret replaced by the marker and the pattern scrubbed. Without the Events()
// override the promoted event attributes leak in cleartext.
func TestSpanExportRedactsEventAttributes(t *testing.T) {
	inmem := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
		sdktrace.WithSyncer(newRedactingExporter(inmem)),
	)
	_, span := tp.Tracer("test").Start(context.Background(), "op")
	span.AddEvent("exception", trace.WithAttributes(
		attribute.String(secretKeyAttr, eventSecretVal),
		attribute.String(patternAttr, patternRawVal),
	))
	span.End()

	stubs := inmem.GetSpans()
	if len(stubs) != 1 {
		t.Fatalf("expected 1 exported span, got %d", len(stubs))
	}
	events := stubs[0].Events
	if len(events) != 1 {
		t.Fatalf("expected 1 exported event, got %d", len(events))
	}
	ev := events[0]
	if ev.Name != "exception" {
		t.Errorf("event name not preserved: got %q", ev.Name)
	}
	got := map[string]string{}
	for _, kv := range ev.Attributes {
		if kv.Value.Type() == attribute.STRING {
			got[string(kv.Key)] = kv.Value.AsString()
		}
	}
	if got[secretKeyAttr] != "[REDACTED]" {
		t.Errorf("event secret-family attribute not redacted: %q = %q", secretKeyAttr, got[secretKeyAttr])
	}
	if got[patternAttr] != patternWantVal {
		t.Errorf("event secret pattern not scrubbed: %q = %q, want %q", patternAttr, got[patternAttr], patternWantVal)
	}
	// Belt and suspenders: the cleartext secret must not survive anywhere in the event.
	for _, kv := range ev.Attributes {
		if kv.Value.Type() == attribute.STRING && strings.Contains(kv.Value.AsString(), "eventsupersecret9876") {
			t.Errorf("cleartext secret leaked in event attribute %q = %q", kv.Key, kv.Value.AsString())
		}
	}
}

// exportSpanNamed starts and ends a single span named name against exporter, returning the
// span name the exporter received. The provider is shut down after reading so the span is
// flushed and the in-memory buffer is not reset before the read.
func exportSpanNamed(t *testing.T, name string, exporter sdktrace.SpanExporter, inmem *tracetest.InMemoryExporter) string {
	t.Helper()
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
		sdktrace.WithSyncer(exporter),
	)
	_, span := tp.Tracer("test").Start(context.Background(), name)
	span.End()
	stubs := inmem.GetSpans()
	if len(stubs) != 1 {
		t.Fatalf("expected 1 exported span, got %d", len(stubs))
	}
	if err := tp.Shutdown(context.Background()); err != nil {
		t.Fatalf("provider shutdown: %v", err)
	}
	return stubs[0].Name
}

// TestSpanExportScrubsSpanName asserts the redacting exporter scrubs secret patterns out of
// the span NAME before export, mirroring the TS vertical. A span named with an embedded bearer
// token exports with the token replaced by the marker; a benign name is left unchanged. The
// negative control through the bare exporter proves the scrub comes from the wrapper.
func TestSpanExportScrubsSpanName(t *testing.T) {
	const secretName = "GET /items with Bearer abcdef1234567890"
	const wantName = "GET /items with [REDACTED]"

	inmem := tracetest.NewInMemoryExporter()
	if got := exportSpanNamed(t, secretName, newRedactingExporter(inmem), inmem); got != wantName {
		t.Errorf("span name not scrubbed: got %q, want %q", got, wantName)
	}

	inmem = tracetest.NewInMemoryExporter()
	if got := exportSpanNamed(t, "ItemService/GetItem", newRedactingExporter(inmem), inmem); got != "ItemService/GetItem" {
		t.Errorf("benign span name altered: got %q", got)
	}

	// Negative control: without the wrapper the secret name survives, proving the scrub in the
	// positive case comes from the redacting exporter and not the SDK or the test setup.
	inmem = tracetest.NewInMemoryExporter()
	if got := exportSpanNamed(t, secretName, inmem, inmem); got != secretName {
		t.Errorf("expected raw span name %q without the redactor, got %q", secretName, got)
	}
}

// TestSpanExportPreservesLuhnIDInSpanName asserts the redacting exporter does NOT apply the
// credit-card/PAN/Luhn matcher to the span NAME. A span name is a low-cardinality operation
// identifier; a Luhn-valid 13-19 digit id embedded in it (for example an account id in a REST
// path) is a route parameter, not a card number, and must survive export intact. Scrubbing it
// would corrupt the operation name (".../[REDACTED]/balance") and fracture trace aggregation.
// This fails before the fix (ScrubText redacts the Luhn id) and passes after (ScrubTextForName
// skips the PAN matcher).
func TestSpanExportPreservesLuhnIDInSpanName(t *testing.T) {
	// 4532015112830366 is a Luhn-valid 16-digit number; here it is an account id in a path.
	const name = "GET /v1/accounts/4532015112830366/balance"

	inmem := tracetest.NewInMemoryExporter()
	if got := exportSpanNamed(t, name, newRedactingExporter(inmem), inmem); got != name {
		t.Errorf("span name with a Luhn-valid id was altered: got %q, want %q", got, name)
	}
}

// TestSpanExportScrubsSecretPatternsInSpanName asserts the name-specific scrubber still removes
// the non-PAN secret patterns from a span name: a bearer token and an AWS access-key id must be
// replaced by the marker even though the PAN matcher is skipped for names.
func TestSpanExportScrubsSecretPatternsInSpanName(t *testing.T) {
	cases := map[string]string{
		"POST /login Bearer abcdef1234567890": "POST /login [REDACTED]",
		"job AKIAIOSFODNN7EXAMPLE sync":       "job [REDACTED] sync",
	}
	for name, want := range cases {
		inmem := tracetest.NewInMemoryExporter()
		if got := exportSpanNamed(t, name, newRedactingExporter(inmem), inmem); got != want {
			t.Errorf("span name secret not scrubbed: got %q, want %q", got, want)
		}
	}
}

// TestSpanExportRedactsPANInAttributeValue asserts that, unlike the span NAME, an attribute
// string VALUE still gets full PAN redaction through the unchanged ScrubText: a Luhn-valid card
// number in a high-cardinality value sink must be replaced by the marker. This guards against a
// regression where the name-specific carve-out leaks into the value path.
func TestSpanExportRedactsPANInAttributeValue(t *testing.T) {
	const panAttr = "payment.card"
	const panVal = "4532015112830366"

	inmem := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
		sdktrace.WithSyncer(newRedactingExporter(inmem)),
	)
	_, span := tp.Tracer("test").Start(context.Background(), "op")
	span.SetAttributes(attribute.String(panAttr, panVal))
	span.End()

	stubs := inmem.GetSpans()
	if len(stubs) != 1 {
		t.Fatalf("expected 1 exported span, got %d", len(stubs))
	}
	got := map[string]string{}
	for _, kv := range stubs[0].Attributes {
		if kv.Value.Type() == attribute.STRING {
			got[string(kv.Key)] = kv.Value.AsString()
		}
	}
	if got[panAttr] != "[REDACTED]" {
		t.Errorf("PAN in attribute value not redacted: %q = %q, want %q", panAttr, got[panAttr], "[REDACTED]")
	}
}

// linkSecretVal is the cleartext secret placed on a span link's secret-family attribute; it
// must never reach the exporter.
const linkSecretVal = "Bearer linksupersecret5555"

// TestSpanExportRedactsLinkAttributes asserts the redacting exporter also scrubs span LINK
// attributes, not just top-level and event attributes: a link carrying a secret-family
// attribute and a scrubbable string value must reach the exporter with the secret replaced by
// the marker and the pattern scrubbed, while a benign link attribute survives unchanged.
// Without the Links() override the promoted link attributes leak in cleartext.
func TestSpanExportRedactsLinkAttributes(t *testing.T) {
	inmem := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
		sdktrace.WithSyncer(newRedactingExporter(inmem)),
	)

	// Build a valid linked span context to attach the link to.
	linked := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    trace.TraceID{0x01},
		SpanID:     trace.SpanID{0x02},
		TraceFlags: trace.FlagsSampled,
	})
	_, span := tp.Tracer("test").Start(context.Background(), "op", trace.WithLinks(trace.Link{
		SpanContext: linked,
		Attributes: []attribute.KeyValue{
			attribute.String(secretKeyAttr, linkSecretVal),
			attribute.String(patternAttr, patternRawVal),
			attribute.String("link.kind", "follows-from"),
		},
	}))
	span.End()

	stubs := inmem.GetSpans()
	if len(stubs) != 1 {
		t.Fatalf("expected 1 exported span, got %d", len(stubs))
	}
	links := stubs[0].Links
	if len(links) != 1 {
		t.Fatalf("expected 1 exported link, got %d", len(links))
	}
	got := map[string]string{}
	for _, kv := range links[0].Attributes {
		if kv.Value.Type() == attribute.STRING {
			got[string(kv.Key)] = kv.Value.AsString()
		}
	}
	if got[secretKeyAttr] != "[REDACTED]" {
		t.Errorf("link secret-family attribute not redacted: %q = %q", secretKeyAttr, got[secretKeyAttr])
	}
	if got[patternAttr] != patternWantVal {
		t.Errorf("link secret pattern not scrubbed: %q = %q, want %q", patternAttr, got[patternAttr], patternWantVal)
	}
	// Negative control: a benign link attribute must survive unchanged.
	if got["link.kind"] != "follows-from" {
		t.Errorf("benign link attribute altered: %q = %q", "link.kind", got["link.kind"])
	}
	// Belt and suspenders: the cleartext secret must not survive anywhere in the link.
	for _, kv := range links[0].Attributes {
		if kv.Value.Type() == attribute.STRING && strings.Contains(kv.Value.AsString(), "linksupersecret5555") {
			t.Errorf("cleartext secret leaked in link attribute %q = %q", kv.Key, kv.Value.AsString())
		}
	}
}

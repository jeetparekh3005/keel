package telemetry

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"testing"

	"go.opentelemetry.io/otel/trace"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/logging"
)

func TestResourceCarriesServiceIdentity(t *testing.T) {
	res, err := Resource(context.Background(), "svc", "1.2.3", "test")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, kv := range res.Attributes() {
		got[string(kv.Key)] = kv.Value.AsString()
	}
	if got["service.name"] != "svc" || got["service.version"] != "1.2.3" {
		t.Errorf("unexpected resource attributes: %v", got)
	}
	if got["deployment.environment.name"] != "test" {
		t.Errorf("missing environment: %v", got)
	}
	if got["service.instance.id"] == "" {
		t.Errorf("missing instance id")
	}
}

func TestInitWithoutEndpointReturnsNoopShutdown(t *testing.T) {
	shutdown, err := Init(context.Background(), "svc", "0", "test", "info", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := shutdown(context.Background()); err != nil {
		t.Errorf("noop shutdown should not error: %v", err)
	}
}

func TestLogLineCarriesTraceAndSpanIDInsideASpan(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(correlatingHandler{inner: logging.NewHandler("info", &buf)})

	traceID, _ := trace.TraceIDFromHex("0102030405060708090a0b0c0d0e0f10")
	spanID, _ := trace.SpanIDFromHex("0102030405060708")
	sc := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    traceID,
		SpanID:     spanID,
		TraceFlags: trace.FlagsSampled,
	})
	ctx := trace.ContextWithSpanContext(context.Background(), sc)

	logger.InfoContext(ctx, "handling")

	var rec map[string]any
	if err := json.Unmarshal(buf.Bytes(), &rec); err != nil {
		t.Fatalf("not valid JSON: %v\n%s", err, buf.String())
	}
	if rec["trace_id"] != "0102030405060708090a0b0c0d0e0f10" {
		t.Errorf("trace_id = %v", rec["trace_id"])
	}
	if rec["span_id"] != "0102030405060708" {
		t.Errorf("span_id = %v", rec["span_id"])
	}
}

func TestLogLineHasNoTraceIDOutsideASpan(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(correlatingHandler{inner: logging.NewHandler("info", &buf)})
	logger.Info("no span here")
	var rec map[string]any
	if err := json.Unmarshal(buf.Bytes(), &rec); err != nil {
		t.Fatal(err)
	}
	if _, ok := rec["trace_id"]; ok {
		t.Errorf("trace_id must be absent without an active span: %s", buf.String())
	}
}

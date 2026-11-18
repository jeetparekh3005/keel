package messaging

// Live RabbitMessageBus check against a real RabbitMQ broker (ADR-0025).
//
// Runs only when KEEL_RABBITMQ_URL is set (CI starts a rabbitmq:4 container); skipped otherwise,
// matching the NATS round-trip's honest gating. It exercises a full publish -> subscribe roundtrip
// and asserts both that the payload and custom headers arrive intact and that the W3C trace context
// propagates: the trace id the handler sees must equal the one the producer started with, and the
// traceparent header must survive on the delivery. No broker state is committed.

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/ports"
)

func TestRabbitRoundtripDeliversPayloadAndPropagatesTraceContext(t *testing.T) {
	url := os.Getenv("KEEL_RABBITMQ_URL")
	if url == "" {
		t.Skip("KEEL_RABBITMQ_URL not set; skipping live RabbitMQ integration test")
	}

	// A real TracerProvider mints valid span contexts; the W3C propagator carries them through the
	// message headers. Both are global state the adapter reads, so set them before publishing.
	otel.SetTextMapPropagator(propagation.TraceContext{})
	tp := sdktrace.NewTracerProvider()
	otel.SetTracerProvider(tp)
	defer func() { _ = tp.Shutdown(context.Background()) }()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	bus := NewRabbit(RabbitConfig{URL: url, Exchange: "keel", Queue: "keel", Subjects: []string{"keel.#"}})
	if err := bus.Connect(ctx); err != nil {
		t.Fatalf("connect to RabbitMQ at %s: %v", url, err)
	}
	defer func() { _ = bus.Close() }()

	const subject = "keel.test.events"

	type delivery struct {
		msg     ports.InboundMessage
		traceID trace.TraceID
	}
	got := make(chan delivery, 1)
	var once sync.Once
	handler := func(hctx context.Context, msg ports.InboundMessage) error {
		// Capture only the first delivery; a bounded send avoids blocking the consumer goroutine.
		once.Do(func() {
			got <- delivery{msg: msg, traceID: trace.SpanContextFromContext(hctx).TraceID()}
		})
		return nil
	}
	if err := bus.Subscribe(ctx, subject, handler); err != nil {
		t.Fatalf("subscribe to %s: %v", subject, err)
	}

	pctx, span := tp.Tracer("keel.messaging.test").Start(ctx, "publish")
	wantTrace := span.SpanContext().TraceID()
	if err := bus.Publish(pctx, subject, []byte("hello"), map[string]string{"x-demo": "1"}); err != nil {
		t.Fatalf("publish to %s: %v", subject, err)
	}
	span.End()

	select {
	case d := <-got:
		if string(d.msg.Payload) != "hello" {
			t.Errorf("payload = %q, want %q", d.msg.Payload, "hello")
		}
		if d.msg.Headers["x-demo"] != "1" {
			t.Errorf("header x-demo = %q, want %q", d.msg.Headers["x-demo"], "1")
		}
		if d.msg.Headers["traceparent"] == "" {
			t.Error("traceparent header did not survive delivery")
		}
		if !d.traceID.IsValid() {
			t.Error("handler saw no valid trace id; trace context was not propagated through headers")
		}
		if d.traceID != wantTrace {
			t.Errorf("handler trace id = %s, want %s (producer trace not propagated)", d.traceID, wantTrace)
		}
	case <-ctx.Done():
		t.Fatalf("no message delivered to %s within timeout: %v", subject, ctx.Err())
	}
}

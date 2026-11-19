package messaging

// Broker-free unit tests for the in-memory dev/test bus: a published message reaches every
// subscriber of the subject with the payload intact, a publish to an unsubscribed subject is a
// no-op, a handler error surfaces to the publisher, and the publisher's trace context is carried
// into the handler (the same trace-continuity contract the real broker adapters must meet).

import (
	"context"
	"errors"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/ports"
)

func TestInMemoryBusDeliversToSubscriber(t *testing.T) {
	bus := NewInMemory()
	var got ports.InboundMessage
	seen := 0
	if err := bus.Subscribe(context.Background(), "keel.test", func(_ context.Context, m ports.InboundMessage) error {
		got = m
		seen++
		return nil
	}); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if err := bus.Publish(context.Background(), "keel.test", []byte("payload"), nil); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if seen != 1 {
		t.Fatalf("handler ran %d times, want 1", seen)
	}
	if got.Subject != "keel.test" || string(got.Payload) != "payload" {
		t.Errorf("delivered %q/%q, want keel.test/payload", got.Subject, got.Payload)
	}
}

func TestInMemoryBusPublishWithoutSubscriberIsNoOp(t *testing.T) {
	if err := NewInMemory().Publish(context.Background(), "nobody.listening", []byte("x"), nil); err != nil {
		t.Errorf("publish to an unsubscribed subject must be a no-op, got %v", err)
	}
}

func TestInMemoryBusReturnsHandlerError(t *testing.T) {
	bus := NewInMemory()
	boom := errors.New("boom")
	_ = bus.Subscribe(context.Background(), "keel.test", func(context.Context, ports.InboundMessage) error {
		return boom
	})
	if err := bus.Publish(context.Background(), "keel.test", []byte("x"), nil); !errors.Is(err, boom) {
		t.Errorf("Publish error = %v, want the handler error", err)
	}
}

func TestInMemoryBusPropagatesTraceContext(t *testing.T) {
	// A W3C trace-context propagator and a real (recorded) span let us assert the handler joins the
	// publisher's trace, the behaviour every broker adapter must match.
	prev := otel.GetTextMapPropagator()
	otel.SetTextMapPropagator(propagation.TraceContext{})
	defer otel.SetTextMapPropagator(prev)

	tp := sdktrace.NewTracerProvider()
	defer func() { _ = tp.Shutdown(context.Background()) }()
	ctx, span := tp.Tracer("test").Start(context.Background(), "publish")
	defer span.End()
	wantTrace := span.SpanContext().TraceID()

	bus := NewInMemory()
	var gotTrace trace.TraceID
	_ = bus.Subscribe(context.Background(), "keel.test", func(hctx context.Context, _ ports.InboundMessage) error {
		gotTrace = trace.SpanContextFromContext(hctx).TraceID()
		return nil
	})
	if err := bus.Publish(ctx, "keel.test", []byte("x"), nil); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if gotTrace != wantTrace {
		t.Errorf("handler trace = %s, want the publisher's %s", gotTrace, wantTrace)
	}
}

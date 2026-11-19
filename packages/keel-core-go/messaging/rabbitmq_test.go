package messaging

// Per-message ack/nack/dead-letter dispatch logic for the RabbitMQ adapter, unit-tested without a
// broker (mirrors the NATS adapter's dispatch tests). These assert the poison-message contract
// directly: a handler failure nacks (requeues) below the delivery cap and dead-letters at it, every
// terminate is logged so the drop is never silent, and a failing control call is logged rather than
// propagated. The pure disposition function is exercised in isolation too.

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"testing"

	amqp "github.com/rabbitmq/amqp091-go"
)

// fakeDelivery is a delivery that records which control call dispatch made.
type fakeDelivery struct {
	subject string
	body    []byte
	headers amqp.Table
	ackErr  error

	acked, nacked bool
	nackRequeue   bool
}

func (d *fakeDelivery) Ack(bool) error { d.acked = true; return d.ackErr }
func (d *fakeDelivery) Nack(_ bool, requeue bool) error {
	d.nacked = true
	d.nackRequeue = requeue
	return nil
}
func (d *fakeDelivery) Headers() amqp.Table { return d.headers }
func (d *fakeDelivery) Body() []byte        { return d.body }
func (d *fakeDelivery) RoutingKey() string  { return d.subject }

// newFakeDelivery builds a delivery whose x-delivery-count header encodes a 1-based numDelivered
// (count = numDelivered-1), so the attempt dispatch computes matches the NATS adapter's convention.
func newFakeDelivery(numDelivered int) *fakeDelivery {
	return &fakeDelivery{
		subject: "keel.test.events",
		body:    []byte("payload"),
		headers: amqp.Table{"x-delivery-count": int32(numDelivered - 1)},
	}
}

// rabbitBusWithLog builds a bus with max_deliver 5 that logs to buf, so dispatch decisions are
// assertable.
func rabbitBusWithLog(buf *bytes.Buffer) *RabbitMessageBus {
	logger := slog.New(slog.NewJSONHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	return NewRabbit(RabbitConfig{
		Exchange: "keel", Queue: "keel", Subjects: []string{"keel.#"}, MaxDeliver: 5, Logger: logger,
	})
}

func TestDisposition(t *testing.T) {
	cases := []struct {
		name         string
		ok           bool
		numDelivered int
		want         dispatchAction
	}{
		{"success acks", true, 1, actionAck},
		{"success acks even at cap", true, 5, actionAck},
		{"first failure requeues", false, 1, actionRequeue},
		{"below cap requeues", false, 4, actionRequeue},
		{"at cap dead-letters", false, 5, actionDeadLetter},
		{"beyond cap dead-letters", false, 6, actionDeadLetter},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := disposition(tc.ok, tc.numDelivered, 5); got != tc.want {
				t.Fatalf("disposition(%v, %d, 5) = %v, want %v", tc.ok, tc.numDelivered, got, tc.want)
			}
		})
	}
}

func TestRabbitDispatchAcksOnSuccess(t *testing.T) {
	d := newFakeDelivery(1)
	rabbitBusWithLog(&bytes.Buffer{}).dispatch(context.Background(), okHandler, d)
	if !d.acked || d.nacked {
		t.Fatalf("want ack only, got acked=%v nacked=%v", d.acked, d.nacked)
	}
}

func TestRabbitDispatchNacksBelowMaxDeliver(t *testing.T) {
	d := newFakeDelivery(1)
	rabbitBusWithLog(&bytes.Buffer{}).dispatch(context.Background(), failHandler, d)
	if d.acked || !d.nacked {
		t.Fatalf("want nack only, got acked=%v nacked=%v", d.acked, d.nacked)
	}
}

func TestRabbitDispatchDeadLettersAtMaxDeliver(t *testing.T) {
	d := newFakeDelivery(5) // == MaxDeliver: dead-letter instead of looping forever
	bus := rabbitBusWithLog(&bytes.Buffer{})
	var deadLettered bool
	bus.deadLetter = func(context.Context, delivery) error { deadLettered = true; return nil }
	bus.dispatch(context.Background(), failHandler, d)
	if !deadLettered {
		t.Error("want the message published to the dead-letter exchange")
	}
	// The original is ack'd (removed from the source queue) after dead-lettering, never nack'd.
	if !d.acked || d.nacked {
		t.Fatalf("want ack after dead-letter, got acked=%v nacked=%v", d.acked, d.nacked)
	}
}

// TestRabbitRepeatedFailureDeadLettersAtMaxDeliver walks the quorum queue's x-delivery-count up
// over successive redeliveries and asserts the message is nack-requeued for attempts 1..4 and then
// dead-lettered on the 5th (== MaxDeliver), never looping forever. This is the broker-free proof of
// FIX 1: without a quorum queue x-delivery-count stays 0 (numDelivered stuck at 1), so the message
// would requeue indefinitely and never reach this terminal step.
func TestRabbitRepeatedFailureDeadLettersAtMaxDeliver(t *testing.T) {
	bus := rabbitBusWithLog(&bytes.Buffer{})
	var deadLettered bool
	bus.deadLetter = func(context.Context, delivery) error { deadLettered = true; return nil }

	// Attempts 1..4: still under the cap, so each failing delivery is nack(requeue=true)'d and the
	// broker re-delivers with x-delivery-count incremented.
	for numDelivered := 1; numDelivered < 5; numDelivered++ {
		d := newFakeDelivery(numDelivered)
		bus.dispatch(context.Background(), failHandler, d)
		if d.acked || !d.nacked || !d.nackRequeue {
			t.Fatalf("attempt %d: want nack(requeue=true), got acked=%v nacked=%v requeue=%v",
				numDelivered, d.acked, d.nacked, d.nackRequeue)
		}
		if deadLettered {
			t.Fatalf("attempt %d: dead-lettered before reaching the cap", numDelivered)
		}
	}

	// 5th delivery (x-delivery-count 4 -> numDelivered 5 == MaxDeliver): terminal dead-letter.
	final := newFakeDelivery(5)
	bus.dispatch(context.Background(), failHandler, final)
	if !deadLettered {
		t.Error("want the message dead-lettered on the 5th delivery, not requeued forever")
	}
	if !final.acked || final.nacked {
		t.Fatalf("want ack after dead-letter, got acked=%v nacked=%v", final.acked, final.nacked)
	}
}

func TestRabbitTerminatedMessageIsLoggedNotDroppedSilently(t *testing.T) {
	var buf bytes.Buffer
	bus := rabbitBusWithLog(&buf)
	bus.deadLetter = func(context.Context, delivery) error { return nil }
	bus.dispatch(context.Background(), failHandler, newFakeDelivery(5))
	rec := findLog(t, &buf, "ERROR", "terminated")
	if rec["subject"] != "keel.test.events" {
		t.Errorf("subject = %v, want keel.test.events", rec["subject"])
	}
	// slog encodes numbers as JSON floats.
	if rec["num_delivered"] != float64(5) {
		t.Errorf("num_delivered = %v, want 5", rec["num_delivered"])
	}
}

func TestRabbitDeadLetterPublishFailurePreservesMessage(t *testing.T) {
	var buf bytes.Buffer
	d := newFakeDelivery(5)
	bus := rabbitBusWithLog(&buf)
	bus.deadLetter = func(context.Context, delivery) error { return errors.New("dlx down") }
	bus.dispatch(context.Background(), failHandler, d)
	// Dead-lettering is a durability operation: a failed DLX publish must preserve the message,
	// never ack-and-drop it. The original is nack(requeue=true)'d (retried), not ack'd.
	findLog(t, &buf, "ERROR", "dead-letter publish failed")
	if d.acked {
		t.Error("original must not be ack'd when the dead-letter publish failed (data loss)")
	}
	if !d.nacked || !d.nackRequeue {
		t.Fatalf("want nack(requeue=true) to preserve the message, got nacked=%v requeue=%v", d.nacked, d.nackRequeue)
	}
}

func TestRabbitScheduledRedeliveryIsLogged(t *testing.T) {
	var buf bytes.Buffer
	rabbitBusWithLog(&buf).dispatch(context.Background(), failHandler, newFakeDelivery(1))
	findLog(t, &buf, "WARN", "redelivery")
}

func TestRabbitControlCallFailureIsLoggedNotPanicking(t *testing.T) {
	var buf bytes.Buffer
	d := newFakeDelivery(1)
	d.ackErr = errors.New("ack failed")
	// A failed ack must surface in the log, not propagate out of the dispatch callback.
	rabbitBusWithLog(&buf).dispatch(context.Background(), okHandler, d)
	findLog(t, &buf, "ERROR", "control call failed")
}

func TestDeliveryCountReadsHeaders(t *testing.T) {
	if got := deliveryCount(amqp.Table{"x-delivery-count": int32(3)}); got != 3 {
		t.Errorf("x-delivery-count: got %d, want 3", got)
	}
	// Portable fallback when the broker does not expose x-delivery-count (classic queues).
	if got := deliveryCount(amqp.Table{"keel-delivery-count": int64(2)}); got != 2 {
		t.Errorf("keel-delivery-count fallback: got %d, want 2", got)
	}
	if got := deliveryCount(amqp.Table{}); got != 0 {
		t.Errorf("no count header: got %d, want 0", got)
	}
}

func TestRabbitConnectReturnsErrorWhenServerUnavailable(t *testing.T) {
	// Port 1 has no RabbitMQ server, so the initial dial fails.
	bus := NewRabbit(RabbitConfig{URL: "amqp://guest:guest@127.0.0.1:1/"})
	if err := bus.Connect(context.Background()); err == nil {
		t.Fatal("expected a connection error against an unavailable server")
	}
}

func TestRabbitCloseIsNoOpWithoutConnection(t *testing.T) {
	if err := NewRabbit(RabbitConfig{}).Close(); err != nil {
		t.Fatalf("Close on an unconnected bus should be a no-op, got %v", err)
	}
}

func TestAMQPHeaderCarrierRoundtrips(t *testing.T) {
	carrier := amqpHeaderCarrier(amqp.Table{})
	carrier.Set("traceparent", "abc")
	carrier.Set("x-demo", "1")
	if got := carrier.Get("traceparent"); got != "abc" {
		t.Errorf("Get(traceparent) = %q, want abc", got)
	}
	// A non-string header value reads back as empty, not a panic.
	carrier["x-delivery-count"] = int32(2)
	if got := carrier.Get("x-delivery-count"); got != "" {
		t.Errorf("Get(non-string) = %q, want empty", got)
	}
	keys := carrier.Keys()
	if len(keys) != 3 {
		t.Fatalf("Keys() = %v, want 3 keys", keys)
	}
	seen := map[string]bool{}
	for _, k := range keys {
		seen[k] = true
	}
	if !seen["traceparent"] {
		t.Errorf("Keys() missing traceparent: %v", keys)
	}
}

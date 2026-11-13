package messaging

// Per-message ack/nak/term dispatch logic, unit-tested without a broker (mirrors the Python
// vertical's test_nats_dispatch). These assert the poison-message contract directly: a handler
// failure nak's below the delivery cap and term's (dead-letters) at it, every terminate is logged
// so the drop is never silent, and a failing control call is logged rather than propagated.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/ports"
)

// fakeMsg is a jetstream.Msg that records which control call dispatch made.
type fakeMsg struct {
	subject      string
	data         []byte
	headers      nats.Header
	numDelivered uint64
	ackErr       error

	acked, nakked, termed bool
}

func (m *fakeMsg) Metadata() (*jetstream.MsgMetadata, error) {
	return &jetstream.MsgMetadata{NumDelivered: m.numDelivered}, nil
}
func (m *fakeMsg) Data() []byte                     { return m.data }
func (m *fakeMsg) Headers() nats.Header             { return m.headers }
func (m *fakeMsg) Subject() string                  { return m.subject }
func (m *fakeMsg) Reply() string                    { return "" }
func (m *fakeMsg) Ack() error                       { m.acked = true; return m.ackErr }
func (m *fakeMsg) DoubleAck(context.Context) error  { m.acked = true; return nil }
func (m *fakeMsg) Nak() error                       { m.nakked = true; return nil }
func (m *fakeMsg) NakWithDelay(time.Duration) error { m.nakked = true; return nil }
func (m *fakeMsg) InProgress() error                { return nil }
func (m *fakeMsg) Term() error                      { m.termed = true; return nil }
func (m *fakeMsg) TermWithReason(string) error      { m.termed = true; return nil }

func newFakeMsg(numDelivered uint64) *fakeMsg {
	return &fakeMsg{
		subject:      "keel.test.events",
		data:         []byte("payload"),
		headers:      nats.Header{},
		numDelivered: numDelivered,
	}
}

// busWithLog builds a bus with max_deliver 5 that logs to buf, so dispatch decisions are assertable.
func busWithLog(buf *bytes.Buffer) *NatsMessageBus {
	logger := slog.New(slog.NewJSONHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	return New(Config{Stream: "keel_test", Subjects: []string{"keel.test.>"}, MaxDeliver: 5, Logger: logger})
}

func okHandler(context.Context, ports.InboundMessage) error   { return nil }
func failHandler(context.Context, ports.InboundMessage) error { return errors.New("boom") }

func TestDispatchAcksOnSuccess(t *testing.T) {
	msg := newFakeMsg(1)
	busWithLog(&bytes.Buffer{}).dispatch(context.Background(), okHandler, msg)
	if !msg.acked || msg.nakked || msg.termed {
		t.Fatalf("want ack only, got acked=%v nakked=%v termed=%v", msg.acked, msg.nakked, msg.termed)
	}
}

func TestDispatchNaksBelowMaxDeliver(t *testing.T) {
	msg := newFakeMsg(1)
	busWithLog(&bytes.Buffer{}).dispatch(context.Background(), failHandler, msg)
	if msg.acked || !msg.nakked || msg.termed {
		t.Fatalf("want nak only, got acked=%v nakked=%v termed=%v", msg.acked, msg.nakked, msg.termed)
	}
}

func TestDispatchTermsAtMaxDeliver(t *testing.T) {
	msg := newFakeMsg(5) // == MaxDeliver: dead-letter instead of looping forever
	busWithLog(&bytes.Buffer{}).dispatch(context.Background(), failHandler, msg)
	if msg.acked || msg.nakked || !msg.termed {
		t.Fatalf("want term only, got acked=%v nakked=%v termed=%v", msg.acked, msg.nakked, msg.termed)
	}
}

func TestTerminatedMessageIsLoggedNotDroppedSilently(t *testing.T) {
	var buf bytes.Buffer
	msg := newFakeMsg(5)
	busWithLog(&buf).dispatch(context.Background(), failHandler, msg)
	rec := findLog(t, &buf, "ERROR", "terminated")
	if rec["subject"] != "keel.test.events" {
		t.Errorf("subject = %v, want keel.test.events", rec["subject"])
	}
	// slog encodes numbers as JSON floats.
	if rec["num_delivered"] != float64(5) {
		t.Errorf("num_delivered = %v, want 5", rec["num_delivered"])
	}
}

func TestScheduledRedeliveryIsLogged(t *testing.T) {
	var buf bytes.Buffer
	busWithLog(&buf).dispatch(context.Background(), failHandler, newFakeMsg(1))
	findLog(t, &buf, "WARN", "redelivery")
}

func TestControlCallFailureIsLoggedNotPanicking(t *testing.T) {
	var buf bytes.Buffer
	msg := newFakeMsg(1)
	msg.ackErr = errors.New("ack failed")
	// A failed ack must surface in the log, not propagate out of the dispatch callback.
	busWithLog(&buf).dispatch(context.Background(), okHandler, msg)
	findLog(t, &buf, "ERROR", "control call failed")
}

func TestConnectReturnsErrorWhenServerUnavailable(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// Port 1 has no NATS server, so the initial connect fails.
	bus := New(Config{URL: "nats://127.0.0.1:1", Stream: "keel_test", Subjects: []string{"keel.test.>"}})
	if err := bus.Connect(ctx); err == nil {
		t.Fatal("expected a connection error against an unavailable server")
	}
}

func TestCloseIsNoOpWithoutConnection(t *testing.T) {
	if err := New(Config{Stream: "keel_test"}).Close(); err != nil {
		t.Fatalf("Close on an unconnected bus should be a no-op, got %v", err)
	}
}

func TestNatsHeaderCarrierRoundtrips(t *testing.T) {
	carrier := natsHeaderCarrier(nats.Header{})
	carrier.Set("traceparent", "abc")
	carrier.Set("x-demo", "1")
	if got := carrier.Get("traceparent"); got != "abc" {
		t.Errorf("Get(traceparent) = %q, want abc", got)
	}
	keys := carrier.Keys()
	if len(keys) != 2 {
		t.Fatalf("Keys() = %v, want 2 keys", keys)
	}
	seen := map[string]bool{}
	for _, k := range keys {
		seen[k] = true
	}
	if !seen["Traceparent"] && !seen["traceparent"] {
		t.Errorf("Keys() missing traceparent: %v", keys)
	}
}

// findLog returns the first JSON log line at the given level whose message contains want, failing
// the test if none is present.
func findLog(t *testing.T, buf *bytes.Buffer, level, want string) map[string]any {
	t.Helper()
	for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if line == "" {
			continue
		}
		var rec map[string]any
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			t.Fatalf("log line is not JSON: %q: %v", line, err)
		}
		if rec["level"] == level && strings.Contains(rec["msg"].(string), want) {
			return rec
		}
	}
	t.Fatalf("no %s log containing %q in:\n%s", level, want, buf.String())
	return nil
}

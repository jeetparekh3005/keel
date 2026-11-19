package messaging

// Live KafkaMessageBus check against a real Kafka broker (ADR-0025).
//
// Runs only when KEEL_KAFKA_BROKERS is set (CI starts an apache/kafka KRaft container); skipped
// otherwise, matching the NATS and RabbitMQ round-trips' honest gating. The first test exercises a
// full publish -> subscribe roundtrip and asserts the payload and custom headers arrive intact and
// that the W3C trace context propagates: the trace id the handler sees must equal the one the
// producer started with, and the traceparent header must survive on the record. The second proves
// the poison-record contract end-to-end: a record whose handler always fails is re-produced through
// the retry topic and lands on the dead-letter topic at the cap rather than looping forever.

import (
	"context"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/ports"
)

// kafkaBrokersFromEnv parses KEEL_KAFKA_BROKERS (comma-separated bootstrap servers) or skips.
func kafkaBrokersFromEnv(t *testing.T) []string {
	t.Helper()
	raw := os.Getenv("KEEL_KAFKA_BROKERS")
	if raw == "" {
		t.Skip("KEEL_KAFKA_BROKERS not set; skipping live Kafka integration test")
	}
	var brokers []string
	for _, b := range strings.Split(raw, ",") {
		if b = strings.TrimSpace(b); b != "" {
			brokers = append(brokers, b)
		}
	}
	return brokers
}

func TestKafkaRoundtripDeliversPayloadAndPropagatesTraceContext(t *testing.T) {
	brokers := kafkaBrokersFromEnv(t)

	// A real TracerProvider mints valid span contexts; the W3C propagator carries them through the
	// record headers. Both are global state the adapter reads, so set them before publishing.
	otel.SetTextMapPropagator(propagation.TraceContext{})
	tp := sdktrace.NewTracerProvider()
	otel.SetTracerProvider(tp)
	defer func() { _ = tp.Shutdown(context.Background()) }()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// A unique subject (hence topic + consumer group) per run so a rerun does not read a prior run's
	// committed offsets.
	subject := uniqueSubject("keel.test.roundtrip")
	bus := NewKafka(KafkaConfig{Brokers: brokers, Topics: []string{subject}, GroupID: topicName(subject)})
	if err := bus.Connect(ctx); err != nil {
		t.Fatalf("connect to Kafka: %v", err)
	}
	defer func() { _ = bus.Close() }()

	type delivery struct {
		msg     ports.InboundMessage
		traceID trace.TraceID
	}
	got := make(chan delivery, 1)
	var once sync.Once
	handler := func(hctx context.Context, msg ports.InboundMessage) error {
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
		// The delivered subject must equal the published one. The topic is a lossy sanitization of
		// the subject (keel.test.roundtrip.* -> keel_test_roundtrip_*), so this only holds because the
		// original subject rides in the keel-subject header; asserting it here closes the gap that let
		// the cross-vertical subject-mismatch bug through.
		if d.msg.Subject != subject {
			t.Errorf("delivered subject = %q, want published subject %q", d.msg.Subject, subject)
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

func TestKafkaPoisonRecordDeadLettersEndToEnd(t *testing.T) {
	brokers := kafkaBrokersFromEnv(t)

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	subject := uniqueSubject("keel.test.poison")
	// MaxDeliver 3 keeps the round-trip short; the contract is the same at 5.
	bus := NewKafka(KafkaConfig{Brokers: brokers, Topics: []string{subject}, GroupID: topicName(subject), MaxDeliver: 3})
	if err := bus.Connect(ctx); err != nil {
		t.Fatalf("connect to Kafka: %v", err)
	}
	defer func() { _ = bus.Close() }()

	// A handler that always fails forces the record through retry -> retry -> dead-letter.
	if err := bus.Subscribe(ctx, subject, failHandler); err != nil {
		t.Fatalf("subscribe to %s: %v", subject, err)
	}
	if err := bus.Publish(ctx, subject, []byte("poison"), nil); err != nil {
		t.Fatalf("publish to %s: %v", subject, err)
	}

	// A separate consumer reads the dead-letter topic; the poison record must land there with its
	// original payload, proving it was neither looped forever nor dropped.
	dlqTopic := topicName(subject) + dlqSuffix
	dlq, err := kgo.NewClient(
		kgo.SeedBrokers(brokers...),
		kgo.ConsumeTopics(dlqTopic),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
	)
	if err != nil {
		t.Fatalf("dead-letter consumer: %v", err)
	}
	defer dlq.Close()

	for {
		fetches := dlq.PollFetches(ctx)
		if err := ctx.Err(); err != nil {
			t.Fatalf("poison record never reached the dead-letter topic %s: %v", dlqTopic, err)
		}
		if fetches.IsClientClosed() {
			t.Fatal("dead-letter consumer closed before the poison record arrived")
		}
		var found bool
		fetches.EachRecord(func(rec *kgo.Record) {
			if string(rec.Value) == "poison" {
				found = true
			}
		})
		if found {
			return
		}
	}
}

// uniqueSubject appends a nanosecond stamp so each integration run uses a fresh topic + group and
// does not read a previous run's committed offsets.
func uniqueSubject(prefix string) string {
	return prefix + "." + time.Now().Format("150405.000000000")
}

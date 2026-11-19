package messaging

// Per-record commit/retry/dead-letter dispatch logic for the Kafka adapter, unit-tested without a
// broker (mirrors the NATS and RabbitMQ adapters' dispatch tests). These assert the poison-record
// contract directly: a handler failure re-produces to the retry topic (incrementing the portable
// keel-delivery-count header) and commits below the cap, dead-letters at the cap, and - the critical
// guarantee - a record that fails every time dead-letters on exactly the fifth attempt rather than
// looping forever or dropping early. The preserve-on-produce-failure policy is asserted too: if the
// retry or dead-letter produce fails, the original offset is NOT committed, so the record is
// redelivered rather than lost. The shared pure disposition function is exercised in isolation.

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strconv"
	"testing"

	"github.com/twmb/franz-go/pkg/kgo"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/ports"
)

// fakeSink records the produces and commits dispatch makes, without a live Kafka client. produceErr,
// when set, fails every produce so the preserve-on-failure path can be asserted.
type fakeSink struct {
	produced   []*kgo.Record
	commits    int
	produceErr error
}

func (s *fakeSink) produce(_ context.Context, rec *kgo.Record) error {
	if s.produceErr != nil {
		return s.produceErr
	}
	s.produced = append(s.produced, rec)
	return nil
}

func (s *fakeSink) commit(context.Context, *kgo.Record) error {
	s.commits++
	return nil
}

// lastProducedTo returns the most recent record produced to a topic with the given suffix, or nil.
func (s *fakeSink) lastProducedTo(suffix string) *kgo.Record {
	var last *kgo.Record
	for _, r := range s.produced {
		if len(r.Topic) >= len(suffix) && r.Topic[len(r.Topic)-len(suffix):] == suffix {
			last = r
		}
	}
	return last
}

// newKafkaRecord builds a base-topic record whose keel-delivery-count header encodes a 1-based
// numDelivered (count = numDelivered-1), so the attempt dispatch computes matches the NATS adapter's
// convention; numDelivered 1 omits the header entirely (the first delivery).
func newKafkaRecord(numDelivered int) *kgo.Record {
	rec := &kgo.Record{Topic: "keel_test_events", Value: []byte("payload")}
	if numDelivered > 1 {
		rec.Headers = []kgo.RecordHeader{{Key: deliveryCountHeader, Value: []byte(strconv.Itoa(numDelivered - 1))}}
	}
	return rec
}

// kafkaBusWithLog builds a bus with max_deliver 5 wired to sink that logs to buf, so dispatch
// decisions are assertable.
func kafkaBusWithLog(buf *bytes.Buffer, sink recordSink) *KafkaMessageBus {
	logger := slog.New(slog.NewJSONHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	bus := NewKafka(KafkaConfig{Topics: []string{"keel.test.events"}, GroupID: "keel", MaxDeliver: 5, Logger: logger})
	bus.sink = sink
	return bus
}

func TestKafkaDisposition(t *testing.T) {
	cases := []struct {
		name         string
		ok           bool
		numDelivered int
		want         dispatchAction
	}{
		{"success commits", true, 1, actionAck},
		{"success commits even at cap", true, 5, actionAck},
		{"first failure retries", false, 1, actionRequeue},
		{"below cap retries", false, 4, actionRequeue},
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

func TestKafkaDispatchCommitsOnSuccess(t *testing.T) {
	sink := &fakeSink{}
	kafkaBusWithLog(&bytes.Buffer{}, sink).dispatch(context.Background(), okHandler, newKafkaRecord(1))
	if sink.commits != 1 {
		t.Fatalf("want one commit, got %d", sink.commits)
	}
	if len(sink.produced) != 0 {
		t.Fatalf("want no produce on success, got %d", len(sink.produced))
	}
}

func TestKafkaDispatchRetriesBelowMaxDeliver(t *testing.T) {
	sink := &fakeSink{}
	kafkaBusWithLog(&bytes.Buffer{}, sink).dispatch(context.Background(), failHandler, newKafkaRecord(1))
	// Below the cap: re-produced to the retry topic and the original offset committed so the
	// partition is not head-of-line blocked.
	retry := sink.lastProducedTo(retrySuffix)
	if retry == nil {
		t.Fatal("want a record produced to the retry topic")
	}
	if retry.Topic != "keel_test_events"+retrySuffix {
		t.Errorf("retry topic = %q, want %q", retry.Topic, "keel_test_events"+retrySuffix)
	}
	// The retried record carries the incremented delivery count so the next attempt sees it.
	if got := kafkaDeliveryCount(retry.Headers); got != 1 {
		t.Errorf("retry keel-delivery-count = %d, want 1", got)
	}
	if sink.commits != 1 {
		t.Errorf("want the original offset committed after the retry produce, got %d commits", sink.commits)
	}
}

func TestKafkaDispatchDeadLettersAtMaxDeliver(t *testing.T) {
	sink := &fakeSink{}
	kafkaBusWithLog(&bytes.Buffer{}, sink).dispatch(context.Background(), failHandler, newKafkaRecord(5))
	dlq := sink.lastProducedTo(dlqSuffix)
	if dlq == nil {
		t.Fatal("want a record produced to the dead-letter topic")
	}
	if dlq.Topic != "keel_test_events"+dlqSuffix {
		t.Errorf("dlq topic = %q, want %q", dlq.Topic, "keel_test_events"+dlqSuffix)
	}
	if string(dlq.Value) != "payload" {
		t.Errorf("dlq payload = %q, want original %q", dlq.Value, "payload")
	}
	if sink.commits != 1 {
		t.Errorf("want the original offset committed after dead-lettering, got %d commits", sink.commits)
	}
}

// TestKafkaRepeatedlyFailingRecordDeadLettersAtFifthAttempt is the critical guarantee: it simulates
// the consumer group redelivering the record by feeding each retry produce back into dispatch, and
// proves the record is retried exactly four times and dead-lettered on the fifth attempt - never
// looping forever, never dropped early.
func TestKafkaRepeatedlyFailingRecordDeadLettersAtFifthAttempt(t *testing.T) {
	var buf bytes.Buffer
	bus := kafkaBusWithLog(&buf, nil)
	rec := newKafkaRecord(1)

	attempts := 0
	for attempts < 100 {
		attempts++
		sink := &fakeSink{}
		bus.sink = sink
		bus.dispatch(context.Background(), failHandler, rec)

		if dlq := sink.lastProducedTo(dlqSuffix); dlq != nil {
			break // dead-lettered: the loop terminates
		}
		retry := sink.lastProducedTo(retrySuffix)
		if retry == nil {
			t.Fatalf("attempt %d produced neither a retry nor a dead-letter record", attempts)
		}
		// The consumer group redelivers the retried record; it becomes the next attempt's input.
		rec = &kgo.Record{Topic: "keel_test_events", Value: retry.Value, Headers: retry.Headers}
	}

	if attempts != 5 {
		t.Fatalf("record dead-lettered on attempt %d, want exactly 5 (4 retries then dead-letter)", attempts)
	}
	// And the terminate was logged, never a silent drop.
	findLog(t, &buf, "ERROR", "terminated")
}

func TestKafkaRetryProduceFailurePreservesOffset(t *testing.T) {
	var buf bytes.Buffer
	// produceErr fails the retry produce; below the cap the record has no home, so the offset must
	// stay uncommitted for redelivery rather than being lost.
	sink := &fakeSink{produceErr: errors.New("broker down")}
	kafkaBusWithLog(&buf, sink).dispatch(context.Background(), failHandler, newKafkaRecord(1))
	if sink.commits != 0 {
		t.Errorf("offset must not be committed when the retry produce fails, got %d commits", sink.commits)
	}
	findLog(t, &buf, "ERROR", "retry produce failed")
}

func TestKafkaDeadLetterProduceFailurePreservesOffset(t *testing.T) {
	var buf bytes.Buffer
	// produceErr fails the dead-letter produce at the cap; the offset must stay uncommitted so the
	// record is redelivered rather than silently dropped.
	sink := &fakeSink{produceErr: errors.New("broker down")}
	kafkaBusWithLog(&buf, sink).dispatch(context.Background(), failHandler, newKafkaRecord(5))
	if sink.commits != 0 {
		t.Errorf("offset must not be committed when the dead-letter produce fails, got %d commits", sink.commits)
	}
	findLog(t, &buf, "ERROR", "dead-letter produce failed")
}

func TestKafkaTerminatedMessageIsLoggedNotDroppedSilently(t *testing.T) {
	var buf bytes.Buffer
	kafkaBusWithLog(&buf, &fakeSink{}).dispatch(context.Background(), failHandler, newKafkaRecord(5))
	rec := findLog(t, &buf, "ERROR", "terminated")
	if rec["subject"] != "keel_test_events" {
		t.Errorf("subject = %v, want keel_test_events", rec["subject"])
	}
	// slog encodes numbers as JSON floats.
	if rec["num_delivered"] != float64(5) {
		t.Errorf("num_delivered = %v, want 5", rec["num_delivered"])
	}
}

func TestKafkaScheduledRedeliveryIsLogged(t *testing.T) {
	var buf bytes.Buffer
	kafkaBusWithLog(&buf, &fakeSink{}).dispatch(context.Background(), failHandler, newKafkaRecord(1))
	findLog(t, &buf, "WARN", "redelivery")
}

func TestKafkaCommitCallFailureIsLoggedNotPanicking(t *testing.T) {
	var buf bytes.Buffer
	// A failed commit must surface in the log, not propagate out of the dispatch callback.
	kafkaBusWithLog(&buf, errSink{}).dispatch(context.Background(), okHandler, newKafkaRecord(1))
	findLog(t, &buf, "ERROR", "control call failed")
}

// errSink commits with an error (and produces cleanly), so the control-plane failure path is
// exercised.
type errSink struct{}

func (errSink) produce(context.Context, *kgo.Record) error { return nil }
func (errSink) commit(context.Context, *kgo.Record) error  { return errors.New("commit failed") }

func TestKafkaRetriedRecordRoutesToBaseHandlerSubject(t *testing.T) {
	// A record arriving on <topic>.retry is reported to the handler under the base subject, so the
	// retry loop converges on the same consumer rather than needing a separate ".retry" subscription.
	var seen string
	sink := &fakeSink{}
	bus := kafkaBusWithLog(&bytes.Buffer{}, sink)
	handler := func(_ context.Context, m ports.InboundMessage) error { seen = m.Subject; return nil }
	bus.dispatch(context.Background(), handler, &kgo.Record{Topic: "keel_test_events" + retrySuffix, Value: []byte("x")})
	if seen != "keel_test_events" {
		t.Errorf("handler saw subject %q, want base topic %q", seen, "keel_test_events")
	}
}

func TestKafkaDLQTopicOverride(t *testing.T) {
	sink := &fakeSink{}
	logger := slog.New(slog.NewJSONHandler(&bytes.Buffer{}, nil))
	bus := NewKafka(KafkaConfig{Topics: []string{"keel.test.events"}, DLQTopic: "keel.deadletters", MaxDeliver: 5, Logger: logger})
	bus.sink = sink
	bus.dispatch(context.Background(), failHandler, newKafkaRecord(5))
	if dlq := sink.lastProducedTo(""); dlq == nil || dlq.Topic != "keel.deadletters" {
		t.Fatalf("want dead-letter produced to the override topic keel.deadletters, got %+v", dlq)
	}
}

func TestKafkaDefaultsApplied(t *testing.T) {
	bus := NewKafka(KafkaConfig{Brokers: []string{"localhost:9092"}})
	if bus.cfg.GroupID != "keel" {
		t.Errorf("GroupID default = %q, want keel", bus.cfg.GroupID)
	}
	if len(bus.cfg.Topics) != 1 || bus.cfg.Topics[0] != "keel" {
		t.Errorf("Topics default = %v, want [keel]", bus.cfg.Topics)
	}
	if bus.cfg.MaxDeliver != 5 {
		t.Errorf("MaxDeliver default = %d, want 5", bus.cfg.MaxDeliver)
	}
	if bus.cfg.Logger == nil {
		t.Error("Logger default is nil, want slog.Default()")
	}
}

func TestTopicNameSanitizesSubject(t *testing.T) {
	cases := map[string]string{
		"keel":             "keel",
		"keel.test.events": "keel_test_events",
		"keel.test.>":      "keel_test__",
	}
	for in, want := range cases {
		if got := topicName(in); got != want {
			t.Errorf("topicName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestKafkaDeliveryCountReadsHeader(t *testing.T) {
	if got := kafkaDeliveryCount([]kgo.RecordHeader{{Key: deliveryCountHeader, Value: []byte("3")}}); got != 3 {
		t.Errorf("keel-delivery-count: got %d, want 3", got)
	}
	if got := kafkaDeliveryCount(nil); got != 0 {
		t.Errorf("no count header: got %d, want 0", got)
	}
	// A non-numeric value reads back as 0, not a panic.
	if got := kafkaDeliveryCount([]kgo.RecordHeader{{Key: deliveryCountHeader, Value: []byte("nope")}}); got != 0 {
		t.Errorf("unparseable count: got %d, want 0", got)
	}
}

func TestKafkaCloseIsNoOpWithoutConnection(t *testing.T) {
	if err := NewKafka(KafkaConfig{}).Close(); err != nil {
		t.Fatalf("Close on an unconnected bus should be a no-op, got %v", err)
	}
}

func TestKafkaHeaderCarrierRoundtrips(t *testing.T) {
	hdrs := []kgo.RecordHeader{}
	carrier := kafkaHeaderCarrier{headers: &hdrs}
	carrier.Set("traceparent", "abc")
	carrier.Set("x-demo", "1")
	carrier.Set("traceparent", "def") // overwrite in place, not append
	if got := carrier.Get("traceparent"); got != "def" {
		t.Errorf("Get(traceparent) = %q, want def", got)
	}
	if got := carrier.Get("absent"); got != "" {
		t.Errorf("Get(absent) = %q, want empty", got)
	}
	keys := carrier.Keys()
	if len(keys) != 2 {
		t.Fatalf("Keys() = %v, want 2 keys (traceparent overwritten, not duplicated)", keys)
	}
}

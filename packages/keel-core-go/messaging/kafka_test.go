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
	"strings"
	"testing"
	"time"

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
	// The log pins the sanitized topic, not the keel-subject header.
	if rec["topic"] != "keel_test_events" {
		t.Errorf("topic = %v, want keel_test_events", rec["topic"])
	}
	// slog encodes numbers as JSON floats.
	if rec["num_delivered"] != float64(5) {
		t.Errorf("num_delivered = %v, want 5", rec["num_delivered"])
	}
}

func TestKafkaScheduledRedeliveryIsLogged(t *testing.T) {
	var buf bytes.Buffer
	kafkaBusWithLog(&buf, &fakeSink{}).dispatch(context.Background(), failHandler, newKafkaRecord(1))
	rec := findLog(t, &buf, "WARN", "redelivery")
	if rec["topic"] != "keel_test_events" {
		t.Errorf("topic = %v, want keel_test_events", rec["topic"])
	}
}

// forgedSubject is a crafted keel-subject value: a newline plus a fake key=value pair that, if logged
// verbatim, would forge an operator-log line.
const forgedSubject = "evil\nlevel=ERROR msg=\"forged by attacker\""

// TestKafkaForgedSubjectHeaderNotLogged proves the log-forging defense: a record carrying a crafted
// keel-subject must never put that attacker value into the redelivery or terminate log lines; the
// logged field stays the sanitized base topic. The handler still receives the original subject.
func TestKafkaForgedSubjectHeaderNotLogged(t *testing.T) {
	forged := func(numDelivered int) *kgo.Record {
		rec := newKafkaRecord(numDelivered)
		rec.Headers = append(rec.Headers, kgo.RecordHeader{Key: subjectHeader, Value: []byte(forgedSubject)})
		return rec
	}

	// Redelivery (below the cap).
	var warnBuf bytes.Buffer
	var handlerSaw string
	capture := func(ctx context.Context, m ports.InboundMessage) error {
		handlerSaw = m.Subject
		return failHandler(ctx, m)
	}
	kafkaBusWithLog(&warnBuf, &fakeSink{}).dispatch(context.Background(), capture, forged(1))
	assertNoForgedSubject(t, &warnBuf, "WARN", "redelivery")
	if handlerSaw != forgedSubject {
		t.Errorf("handler subject = %q, want the original (forged) subject delivered verbatim", handlerSaw)
	}

	// Terminate (at the cap).
	var errBuf bytes.Buffer
	kafkaBusWithLog(&errBuf, &fakeSink{}).dispatch(context.Background(), failHandler, forged(5))
	assertNoForgedSubject(t, &errBuf, "ERROR", "terminated")
}

// assertNoForgedSubject fails if the matched log line carries the forged subject anywhere, and checks
// its topic field is the trusted sanitized topic.
func assertNoForgedSubject(t *testing.T, buf *bytes.Buffer, level, want string) {
	t.Helper()
	if strings.Contains(buf.String(), "forged by attacker") {
		t.Errorf("forged keel-subject value leaked into the %s log:\n%s", level, buf.String())
	}
	rec := findLog(t, buf, level, want)
	if rec["topic"] != "keel_test_events" {
		t.Errorf("logged topic = %v, want sanitized keel_test_events", rec["topic"])
	}
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

// TestKafkaDispatchReportsOriginalSubjectFromHeader guards the cross-vertical regression: the
// subject-to-topic mapping is lossy (keel.test.events -> keel_test_events), so dispatch must report
// the original subject carried in keel-subject, not the sanitized topic. It also checks the fallback
// to the topic when the header is absent (a record produced outside this adapter).
func TestKafkaDispatchReportsOriginalSubjectFromHeader(t *testing.T) {
	bus := kafkaBusWithLog(&bytes.Buffer{}, &fakeSink{})

	var seen string
	capture := func(_ context.Context, m ports.InboundMessage) error { seen = m.Subject; return nil }

	// Header present: the original dotted subject is reported verbatim despite the underscored topic.
	withHeader := &kgo.Record{
		Topic:   "keel_test_events",
		Value:   []byte("x"),
		Headers: []kgo.RecordHeader{{Key: subjectHeader, Value: []byte("keel.test.events")}},
	}
	bus.dispatch(context.Background(), capture, withHeader)
	if seen != "keel.test.events" {
		t.Errorf("with keel-subject header: handler saw %q, want original %q", seen, "keel.test.events")
	}

	// Header absent: fall back to the topic name so an externally produced record still has a subject.
	bus.dispatch(context.Background(), capture, &kgo.Record{Topic: "keel_other", Value: []byte("x")})
	if seen != "keel_other" {
		t.Errorf("without keel-subject header: handler saw %q, want topic fallback %q", seen, "keel_other")
	}
}

// TestKafkaPublishStampsOriginalSubjectHeader proves the producing half of the round-trip: Publish
// sanitizes the subject into the topic AND stamps the original into keel-subject so the consumer can
// recover it.
func TestKafkaPublishStampsOriginalSubjectHeader(t *testing.T) {
	sink := &fakeSink{}
	bus := kafkaBusWithLog(&bytes.Buffer{}, sink)
	if err := bus.Publish(context.Background(), "keel.test.events", []byte("x"), nil); err != nil {
		t.Fatalf("publish: %v", err)
	}
	rec := sink.lastProducedTo("")
	if rec == nil {
		t.Fatal("publish produced no record")
	}
	if rec.Topic != "keel_test_events" {
		t.Errorf("topic = %q, want sanitized %q", rec.Topic, "keel_test_events")
	}
	if got := kafkaHeaderString(rec.Headers, subjectHeader); got != "keel.test.events" {
		t.Errorf("keel-subject header = %q, want original %q", got, "keel.test.events")
	}
}

// TestKafkaSubjectHeaderSurvivesRetryAndDeadLetter proves the original subject is carried onto both
// the retry and dead-letter records, so a redelivered or dead-lettered record still reports it.
func TestKafkaSubjectHeaderSurvivesRetryAndDeadLetter(t *testing.T) {
	withSubject := func(numDelivered int) *kgo.Record {
		rec := newKafkaRecord(numDelivered)
		rec.Headers = append(rec.Headers, kgo.RecordHeader{Key: subjectHeader, Value: []byte("keel.test.events")})
		return rec
	}

	retrySink := &fakeSink{}
	kafkaBusWithLog(&bytes.Buffer{}, retrySink).dispatch(context.Background(), failHandler, withSubject(1))
	if got := kafkaHeaderString(retrySink.lastProducedTo(retrySuffix).Headers, subjectHeader); got != "keel.test.events" {
		t.Errorf("retry record keel-subject = %q, want %q", got, "keel.test.events")
	}

	dlqSink := &fakeSink{}
	kafkaBusWithLog(&bytes.Buffer{}, dlqSink).dispatch(context.Background(), failHandler, withSubject(5))
	if got := kafkaHeaderString(dlqSink.lastProducedTo(dlqSuffix).Headers, subjectHeader); got != "keel.test.events" {
		t.Errorf("dead-letter record keel-subject = %q, want %q", got, "keel.test.events")
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
	// A producer-injected negative count is clamped to 0, not trusted: otherwise numDelivered would
	// stay below the cap forever and loop a poison record (redelivery-amplification DoS).
	for _, bad := range []string{"-1", "-5", "-2147483648"} {
		if got := kafkaDeliveryCount([]kgo.RecordHeader{{Key: deliveryCountHeader, Value: []byte(bad)}}); got != 0 {
			t.Errorf("negative count %q: got %d, want 0", bad, got)
		}
	}
	// An empty value is malformed and also reads back as 0.
	if got := kafkaDeliveryCount([]kgo.RecordHeader{{Key: deliveryCountHeader, Value: []byte("")}}); got != 0 {
		t.Errorf("empty count: got %d, want 0", got)
	}
}

// TestKafkaDispatchClampsNegativeDeliveryCount proves the clamp end-to-end through dispatch: a record
// bearing a forged negative keel-delivery-count must be treated as the first delivery (numDelivered
// 1), so it retries once rather than looping, and advances toward the cap on later attempts.
func TestKafkaDispatchClampsNegativeDeliveryCount(t *testing.T) {
	var buf bytes.Buffer
	sink := &fakeSink{}
	rec := newKafkaRecord(1)
	rec.Headers = []kgo.RecordHeader{{Key: deliveryCountHeader, Value: []byte("-100")}}
	kafkaBusWithLog(&buf, sink).dispatch(context.Background(), failHandler, rec)
	rec2 := findLog(t, &buf, "WARN", "redelivery")
	if rec2["num_delivered"] != float64(1) {
		t.Errorf("num_delivered with forged negative count = %v, want 1 (clamped to first delivery)", rec2["num_delivered"])
	}
	// The re-produced retry record carries the correct incremented count (1), not the forged value.
	if got := kafkaDeliveryCount(sink.lastProducedTo(retrySuffix).Headers); got != 1 {
		t.Errorf("retry keel-delivery-count = %d, want 1", got)
	}
}

func TestKafkaConnectErrorIsSanitizedNoBrokerHost(t *testing.T) {
	// Port 1 has no Kafka broker, so Ping fails; the returned error must describe the failure and
	// chain the cause type but never echo the broker host:port.
	const host = "127.0.0.1:1"
	bus := NewKafka(KafkaConfig{Brokers: []string{host}, Topics: []string{"keel"}, GroupID: "keel"})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := bus.Connect(ctx)
	if err == nil {
		_ = bus.Close()
		t.Fatal("expected a connection error against an unavailable broker")
	}
	if strings.Contains(err.Error(), host) || strings.Contains(err.Error(), "127.0.0.1") {
		t.Errorf("connect error leaked the broker host: %q", err.Error())
	}
}

// hostLeakSink mimics a franz-go produce dial error whose string embeds the broker host:port.
type hostLeakSink struct{}

func (hostLeakSink) produce(context.Context, *kgo.Record) error {
	return errors.New("dial tcp 10.1.2.3:9092: connect: connection refused")
}
func (hostLeakSink) commit(context.Context, *kgo.Record) error { return nil }

func TestKafkaPublishErrorIsSanitizedNoBrokerHost(t *testing.T) {
	bus := kafkaBusWithLog(&bytes.Buffer{}, hostLeakSink{})
	err := bus.Publish(context.Background(), "keel.test.events", []byte("x"), nil)
	if err == nil {
		t.Fatal("expected a publish error when the produce fails")
	}
	if strings.Contains(err.Error(), "10.1.2.3") || strings.Contains(err.Error(), "9092") {
		t.Errorf("publish error leaked the broker host: %q", err.Error())
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

package messaging

// Kafka adapter for the MessageBus port (ADR-0025): a subject maps to a Kafka topic (non-alphanumeric
// sanitized exactly as NATS durable names are), publishing produces to that topic, and consumption
// runs through a consumer group with auto-commit OFF so the record's offset is committed only after
// the handler acks. The delivery contract is identical to the NATS JetStream and RabbitMQ adapters:
// trace context is injected into record headers on publish and re-extracted around each handler; on
// handler failure below the cap the record is re-produced to a retry topic (<topic>.retry) with an
// incremented delivery-count header and the original offset committed so the partition is not
// head-of-line blocked, and at the cap it is produced to the dead-letter topic (<topic>.dlq) and
// committed, so a poison record neither loops forever nor is dropped silently. Kafka has no native
// per-message delivery count, so it travels in a keel-delivery-count record header. The ack/retry/
// dead-letter decision is the shared pure disposition function, unit-testable without a broker.

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"

	"github.com/twmb/franz-go/pkg/kgo"
	"go.opentelemetry.io/otel"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/ports"
)

// deliveryCountHeader carries the portable redelivery count Kafka does not track natively; it is
// incremented each time a failed record is re-produced to the retry topic.
const deliveryCountHeader = "keel-delivery-count"

// subjectHeader carries the original subject verbatim. The subject-to-topic mapping is a lossy
// sanitization (keel.test.events -> keel_test_events), so the topic name cannot reconstruct it;
// Publish stamps the pre-sanitization subject here and dispatch reports it back, so the delivered
// subject equals the published one (NATS/RabbitMQ get this for free because their subject IS the
// routing key).
const subjectHeader = "keel-subject"

// retrySuffix and dlqSuffix name the retry and dead-letter topics derived from a base topic.
const (
	retrySuffix = ".retry"
	dlqSuffix   = ".dlq"
)

// KafkaConfig configures a KafkaMessageBus: the bootstrap brokers, the topics (subjects) to consume,
// the consumer group, an optional dead-letter-topic override, and the delivery policy. The zero
// value of each tuning field is replaced with a safe default by NewKafka.
type KafkaConfig struct {
	// Brokers is the list of bootstrap servers (from the comma-separated KEEL_KAFKA_BROKERS); it is
	// the gate: a bus is built only when it is set.
	Brokers []string
	// Topics are the subjects/topics the consumer group subscribes to (KEEL_KAFKA_TOPICS), defaulting
	// to "keel". Each is sanitized to a legal topic and its <topic>.retry sibling is consumed too.
	Topics []string
	// GroupID is the consumer group (KEEL_KAFKA_GROUP_ID), defaulting to "keel".
	GroupID string
	// DLQTopic overrides the per-topic <topic>.dlq dead-letter destination with a single shared
	// dead-letter topic (KEEL_KAFKA_DLQ_TOPIC); empty keeps the per-topic default.
	DLQTopic string

	// MaxDeliver caps delivery attempts before a failed record is dead-lettered.
	MaxDeliver int
	// Logger records retry/dead-letter decisions; it defaults to slog.Default() so a dead-lettered
	// record is never dropped without a trace.
	Logger *slog.Logger
}

// recordSink is the slice of a Kafka client that dispatch needs: produce a record (to a retry or
// dead-letter topic) and commit a consumed record's offset. It is an interface so a broker-free test
// can supply a fake that records produces and commits without a live client.
type recordSink interface {
	produce(ctx context.Context, rec *kgo.Record) error
	commit(ctx context.Context, rec *kgo.Record) error
}

// KafkaMessageBus is a MessageBus backed by Kafka for durable at-least-once delivery.
type KafkaMessageBus struct {
	cfg      KafkaConfig
	client   *kgo.Client
	sink     recordSink
	handlers map[string]ports.MessageHandler
	started  bool
	mu       sync.RWMutex
}

var _ ports.MessageBus = (*KafkaMessageBus)(nil)

// NewKafka builds a KafkaMessageBus from cfg, filling in defaults for any unset tuning field. It is
// lazy: no client is created and no broker is dialed until Connect, so building the bus never blocks
// startup.
func NewKafka(cfg KafkaConfig) *KafkaMessageBus {
	if len(cfg.Topics) == 0 {
		cfg.Topics = []string{"keel"}
	}
	if cfg.GroupID == "" {
		cfg.GroupID = "keel"
	}
	if cfg.MaxDeliver == 0 {
		cfg.MaxDeliver = 5
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return &KafkaMessageBus{cfg: cfg, handlers: map[string]ports.MessageHandler{}}
}

// Connect creates the Kafka client (seed brokers, the consumer group, auto-commit off, pre-subscribed
// to the configured topics and their retry siblings) and pings the cluster to fail fast on an
// unreachable broker. Connect- and ping-failure errors are sanitized before return: franz-go wraps a
// net.Dial error whose string embeds the broker host:port, so the cause is chained by type only
// (never its raw message), keeping the broker list and any SASL config out of the error and the logs
// while still failing startup.
func (b *KafkaMessageBus) Connect(ctx context.Context) error {
	topics := make([]string, 0, len(b.cfg.Topics)*2)
	for _, t := range b.cfg.Topics {
		tn := topicName(t)
		topics = append(topics, tn, tn+retrySuffix)
	}
	opts := []kgo.Opt{
		kgo.SeedBrokers(b.cfg.Brokers...),
		kgo.ConsumerGroup(b.cfg.GroupID),
		// Auto-commit OFF: the offset is committed only after the handler acks (success) or the
		// record has a home on the retry/dead-letter topic, never before the work is done.
		kgo.DisableAutoCommit(),
		// Let a publish create the destination topic on first use, mirroring how the NATS adapter
		// creates its stream and the RabbitMQ adapter declares its exchange/queue in Connect: the
		// base topic and the adapter-owned <topic>.retry / <topic>.dlq topics come into being when
		// first produced to (the broker must have auto-create enabled, which keel's CI config sets).
		kgo.AllowAutoTopicCreation(),
	}
	if len(topics) > 0 {
		opts = append(opts, kgo.ConsumeTopics(topics...))
	}
	client, err := kgo.NewClient(opts...)
	if err != nil {
		return fmt.Errorf("kafka client init failed (%T)", err)
	}
	if err := client.Ping(ctx); err != nil {
		client.Close()
		return fmt.Errorf("kafka connect failed (%T)", err)
	}
	b.client = client
	b.sink = kgoSink{client: client}
	return nil
}

// Publish produces payload to the topic subject maps to, stamping the original subject into the
// keel-subject header (the topic is a lossy sanitization of it) and injecting the current trace
// context into the record headers so a subscriber can continue the same trace and see the subject
// verbatim.
func (b *KafkaMessageBus) Publish(ctx context.Context, subject string, payload []byte, headers map[string]string) error {
	hdrs := make([]kgo.RecordHeader, 0, len(headers)+2)
	for k, v := range headers {
		hdrs = append(hdrs, kgo.RecordHeader{Key: k, Value: []byte(v)})
	}
	hdrs = append(hdrs, kgo.RecordHeader{Key: subjectHeader, Value: []byte(subject)})
	carrier := kafkaHeaderCarrier{headers: &hdrs}
	otel.GetTextMapPropagator().Inject(ctx, carrier)
	rec := &kgo.Record{Topic: topicName(subject), Value: payload, Headers: hdrs}
	if err := b.sink.produce(ctx, rec); err != nil {
		// Sanitize: a produce dial error embeds the broker host:port, so chain the cause by type
		// only and never its raw message, keeping the broker address out of the returned error.
		return fmt.Errorf("kafka publish failed (%T)", err)
	}
	return nil
}

// Subscribe registers handler for subject's topic (and its retry sibling), ensures the client
// consumes both, and starts the poll loop on the first call. One bad delivery runs through dispatch,
// which owns the commit/retry/dead-letter decision, so a handler error never kills the loop.
func (b *KafkaMessageBus) Subscribe(ctx context.Context, subject string, handler ports.MessageHandler) error {
	tn := topicName(subject)
	b.mu.Lock()
	b.handlers[tn] = handler
	start := !b.started
	b.started = true
	b.mu.Unlock()

	// The retried record comes back through the same consumer group, so the retry topic is consumed
	// alongside the base topic; AddConsumeTopics is idempotent for topics already in ConsumeTopics.
	b.client.AddConsumeTopics(tn, tn+retrySuffix)
	if start {
		go b.pollLoop(ctx)
	}
	return nil
}

// pollLoop fetches records and routes each to its registered handler via dispatch until the context
// is cancelled or the client is closed. A fetch-level error is logged, not raised, so a transient
// broker hiccup does not tear down the consumer.
func (b *KafkaMessageBus) pollLoop(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		fetches := b.client.PollFetches(ctx)
		if fetches.IsClientClosed() {
			return
		}
		fetches.EachError(func(topic string, part int32, err error) {
			b.cfg.Logger.Error("kafka fetch error", "topic", topic, "partition", part, "error", err)
		})
		fetches.EachRecord(func(rec *kgo.Record) {
			// A record on <topic>.retry is a retried delivery of the base topic; route it to the base
			// topic's handler so the retry loop converges on the same consumer.
			base := strings.TrimSuffix(rec.Topic, retrySuffix)
			b.mu.RLock()
			handler := b.handlers[base]
			b.mu.RUnlock()
			if handler == nil {
				return
			}
			b.dispatch(ctx, handler, rec)
		})
	}
}

// dispatch runs handler within the record's trace context, then commits on success, re-produces to
// the retry topic below the cap, or to the dead-letter topic at the cap, per the shared disposition
// rule. The dead-letter decision is always logged: it drops the record from redelivery, which must
// never be silent. If the re-produce to the retry or dead-letter topic itself fails, the original
// offset is NOT committed, so the record is redelivered rather than lost (mirrors the RabbitMQ
// preserve-on-dead-letter-failure policy); the offset is committed only once the record has a home.
func (b *KafkaMessageBus) dispatch(parent context.Context, handler ports.MessageHandler, rec *kgo.Record) {
	hdrs := rec.Headers
	ctx := otel.GetTextMapPropagator().Extract(parent, kafkaHeaderCarrier{headers: &hdrs})
	// base is the sanitized topic (retry suffix stripped) and drives the retry/dlq derivation; the
	// subject reported to the handler is the original one carried in keel-subject, falling back to
	// the topic when the header is absent (e.g. a record produced outside this adapter).
	base := strings.TrimSuffix(rec.Topic, retrySuffix)
	subject := base
	if s := kafkaHeaderString(rec.Headers, subjectHeader); s != "" {
		subject = s
	}
	inbound := ports.InboundMessage{
		Subject: subject,
		Payload: rec.Value,
		Headers: flattenKafkaHeaders(rec.Headers),
	}

	err := handler(ctx, inbound)
	numDelivered := kafkaDeliveryCount(rec.Headers) + 1
	// Logs record the sanitized base topic, never the keel-subject header: that header is
	// attacker-controllable, so logging it verbatim would let a crafted subject (newlines, fake
	// key=value) forge operator-log lines. The handler still sees the original subject
	// (inbound.Subject); only the log field is pinned to the trusted topic.
	switch disposition(err == nil, numDelivered, b.cfg.MaxDeliver) {
	case actionAck:
		b.control(func() error { return b.sink.commit(ctx, rec) }, "commit", base)
	case actionRequeue:
		b.cfg.Logger.Warn("message handler failed; scheduling redelivery",
			"topic", base,
			"retry_topic", base+retrySuffix,
			"num_delivered", numDelivered,
			"error", err,
		)
		retry := retryRecord(rec, base, numDelivered)
		if prodErr := b.sink.produce(ctx, retry); prodErr != nil {
			// Preserve: the record has no home on the retry topic, so leave the offset uncommitted
			// and let the consumer group redeliver it rather than silently drop it.
			b.cfg.Logger.Error("retry produce failed; offset left uncommitted for redelivery",
				"topic", base, "retry_topic", base+retrySuffix, "error", prodErr)
			return
		}
		b.control(func() error { return b.sink.commit(ctx, rec) }, "commit", base)
	case actionDeadLetter:
		dlq := b.dlqTopic(base)
		b.cfg.Logger.Error("message terminated after exhausting delivery attempts",
			"topic", base,
			"dlq_topic", dlq,
			"num_delivered", numDelivered,
			"max_deliver", b.cfg.MaxDeliver,
			"error", err,
		)
		dead := deadLetterRecord(rec, dlq)
		if prodErr := b.sink.produce(ctx, dead); prodErr != nil {
			// Preserve: the record has no home on the dead-letter topic, so leave the offset
			// uncommitted and let it be redelivered rather than lost.
			b.cfg.Logger.Error("dead-letter produce failed; offset left uncommitted for redelivery",
				"topic", base, "dlq_topic", dlq, "error", prodErr)
			return
		}
		// Commit the original only after the record has a home on the dead-letter topic.
		b.control(func() error { return b.sink.commit(ctx, rec) }, "commit", base)
	}
}

// control runs a commit call, logging (not raising) a control-plane failure so a redelivery or
// duplicate-processing anomaly stays diagnosable.
func (b *KafkaMessageBus) control(op func() error, name, topic string) {
	if err := op(); err != nil {
		b.cfg.Logger.Error("kafka control call failed", "op", name, "topic", topic, "error", err)
	}
}

// dlqTopic is the dead-letter destination for base: the shared KEEL_KAFKA_DLQ_TOPIC override when set,
// otherwise the per-topic <topic>.dlq sibling.
func (b *KafkaMessageBus) dlqTopic(base string) string {
	if b.cfg.DLQTopic != "" {
		return b.cfg.DLQTopic
	}
	return base + dlqSuffix
}

// Close closes the client, stopping the poll loop (call at shutdown).
func (b *KafkaMessageBus) Close() error {
	if b.client != nil {
		b.client.Close()
		b.client = nil
	}
	return nil
}

// kgoSink is the production recordSink backed by a live Kafka client.
type kgoSink struct{ client *kgo.Client }

func (s kgoSink) produce(ctx context.Context, rec *kgo.Record) error {
	return s.client.ProduceSync(ctx, rec).FirstErr()
}

func (s kgoSink) commit(ctx context.Context, rec *kgo.Record) error {
	return s.client.CommitRecords(ctx, rec)
}

// retryRecord copies rec onto its base's retry topic, preserving the payload, key, and headers (trace
// context included) and stamping the incremented delivery count so the next delivery sees it.
func retryRecord(rec *kgo.Record, base string, numDelivered int) *kgo.Record {
	return &kgo.Record{
		Topic:   base + retrySuffix,
		Key:     rec.Key,
		Value:   rec.Value,
		Headers: setDeliveryCount(cloneHeaders(rec.Headers), numDelivered),
	}
}

// deadLetterRecord copies rec onto the dead-letter topic, preserving the original payload, key, and
// headers so the dead-lettered record is a faithful copy of what failed.
func deadLetterRecord(rec *kgo.Record, dlq string) *kgo.Record {
	return &kgo.Record{
		Topic:   dlq,
		Key:     rec.Key,
		Value:   rec.Value,
		Headers: cloneHeaders(rec.Headers),
	}
}

// topicName sanitizes subject to a legal topic, replacing every non-alphanumeric/underscore character
// (as NATS durable names are sanitized); the result is a subset of Kafka's legal topic alphabet, to
// which the .retry/.dlq suffixes append a legal dot.
func topicName(subject string) string {
	return durableUnsafe.ReplaceAllString(subject, "_")
}

// kafkaHeaderString returns the value of the first record header with key, or "" when it is absent.
func kafkaHeaderString(headers []kgo.RecordHeader, key string) string {
	for _, h := range headers {
		if h.Key == key {
			return string(h.Value)
		}
	}
	return ""
}

// kafkaDeliveryCount reads the prior-delivery count from the keel-delivery-count header as a
// non-negative decimal integer. It returns 0 when the header is absent (the first delivery),
// malformed, OR negative: a producer-injected negative count would otherwise push numDelivered below
// the cap on every attempt and loop a poison record forever (a redelivery-amplification DoS), so a
// hostile value is clamped to the first-delivery baseline. dispatch adds one to get a 1-based attempt
// count matching the NATS adapter's NumDelivered.
func kafkaDeliveryCount(headers []kgo.RecordHeader) int {
	for _, h := range headers {
		if h.Key == deliveryCountHeader {
			if n, err := strconv.Atoi(string(h.Value)); err == nil && n >= 0 {
				return n
			}
			return 0
		}
	}
	return 0
}

// setDeliveryCount sets the keel-delivery-count header to n, replacing any existing value in place.
func setDeliveryCount(headers []kgo.RecordHeader, n int) []kgo.RecordHeader {
	v := []byte(strconv.Itoa(n))
	for i := range headers {
		if headers[i].Key == deliveryCountHeader {
			headers[i].Value = v
			return headers
		}
	}
	return append(headers, kgo.RecordHeader{Key: deliveryCountHeader, Value: v})
}

// cloneHeaders returns a shallow copy of src so a re-produced record does not alias the consumed
// record's header slice when its delivery count is restamped.
func cloneHeaders(src []kgo.RecordHeader) []kgo.RecordHeader {
	out := make([]kgo.RecordHeader, len(src))
	copy(out, src)
	return out
}

// flattenKafkaHeaders collapses record headers to the single-valued string propagation map the port
// exposes (the trace-context carrier among them).
func flattenKafkaHeaders(headers []kgo.RecordHeader) map[string]string {
	out := make(map[string]string, len(headers))
	for _, h := range headers {
		out[h.Key] = string(h.Value)
	}
	return out
}

// kafkaHeaderCarrier adapts a record-header slice to the OTel TextMapCarrier interface, so the global
// propagator can inject into and extract trace context from record headers. It holds a pointer so Set
// can append a new header through the carrier.
type kafkaHeaderCarrier struct{ headers *[]kgo.RecordHeader }

func (c kafkaHeaderCarrier) Get(key string) string {
	for _, h := range *c.headers {
		if h.Key == key {
			return string(h.Value)
		}
	}
	return ""
}

func (c kafkaHeaderCarrier) Set(key, value string) {
	for i := range *c.headers {
		if (*c.headers)[i].Key == key {
			(*c.headers)[i].Value = []byte(value)
			return
		}
	}
	*c.headers = append(*c.headers, kgo.RecordHeader{Key: key, Value: []byte(value)})
}

func (c kafkaHeaderCarrier) Keys() []string {
	keys := make([]string, 0, len(*c.headers))
	for _, h := range *c.headers {
		keys = append(keys, h.Key)
	}
	return keys
}

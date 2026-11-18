package messaging

// RabbitMQ adapter for the MessageBus port (ADR-0025): a topic exchange with the subject as the
// routing key, a durable queue bound to the configured subjects, and manual-ack consumption with a
// bounded prefetch. The delivery contract is identical to the NATS JetStream adapter: trace context
// is injected into AMQP headers on publish and re-extracted around each handler; on handler failure
// the message is nack'd (requeued) until MaxDeliver, then dead-lettered to a dead-letter exchange
// and ack'd, so a poison message neither loops forever nor is dropped silently. The ack/nack/
// dead-letter decision is factored into the pure disposition function so it is unit-testable without
// a broker.

import (
	"context"
	"log/slog"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
	"go.opentelemetry.io/otel"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/ports"
)

// RabbitConfig configures a RabbitMessageBus: the server URL, the topic exchange and the durable
// queue bound to its subjects, the dead-letter exchange, and the delivery policy. The zero value of
// each tuning field is replaced with a safe default by NewRabbit.
type RabbitConfig struct {
	URL string
	// Exchange is the topic exchange messages are published to; the subject is the routing key.
	Exchange string
	// Queue is the durable queue bound to Subjects and consumed with manual ack.
	Queue string
	// Subjects are the routing-key patterns the queue is bound to (AMQP topic wildcards, e.g.
	// "keel.#"), filling in the default "keel.#" when unset.
	Subjects []string
	// DLX is the dead-letter exchange a message is published to once it exhausts MaxDeliver.
	DLX string

	// MaxDeliver caps delivery attempts before a failed message is dead-lettered.
	MaxDeliver int
	// PrefetchCount bounds the number of unacked in-flight deliveries (AMQP basic.qos), the
	// RabbitMQ analogue of the NATS MaxAckPending ceiling.
	PrefetchCount int
	// Logger records redelivery/termination decisions; it defaults to slog.Default() so a
	// dead-lettered message is never dropped without a trace.
	Logger *slog.Logger
}

// RabbitMessageBus is a MessageBus backed by RabbitMQ for durable at-least-once delivery.
type RabbitMessageBus struct {
	cfg  RabbitConfig
	conn *amqp.Connection
	ch   *amqp.Channel

	// deadLetter publishes a terminated delivery to the dead-letter exchange. It is a field so a
	// broker-free test can record the dead-letter decision without a live channel; it defaults to
	// publishDeadLetter.
	deadLetter func(ctx context.Context, d delivery) error
}

var _ ports.MessageBus = (*RabbitMessageBus)(nil)

// NewRabbit builds a RabbitMessageBus from cfg, filling in defaults for any unset tuning field. Call
// Connect before Publish or Subscribe.
func NewRabbit(cfg RabbitConfig) *RabbitMessageBus {
	if cfg.Exchange == "" {
		cfg.Exchange = "keel"
	}
	if cfg.Queue == "" {
		cfg.Queue = "keel"
	}
	if len(cfg.Subjects) == 0 {
		cfg.Subjects = []string{"keel.#"}
	}
	if cfg.DLX == "" {
		cfg.DLX = "keel.dlx"
	}
	if cfg.MaxDeliver == 0 {
		cfg.MaxDeliver = 5
	}
	if cfg.PrefetchCount == 0 {
		cfg.PrefetchCount = 256
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	b := &RabbitMessageBus{cfg: cfg}
	b.deadLetter = b.publishDeadLetter
	return b
}

// Connect opens the connection and declares the topic exchange, the dead-letter exchange, and the
// durable queue bound to the configured subjects, then sets the prefetch ceiling. It is lazy: no
// connection is opened before this call, so building the bus never blocks startup.
func (b *RabbitMessageBus) Connect(ctx context.Context) error {
	_ = ctx // amqp.Dial has no context hook; the signature mirrors the NATS adapter for parity.
	conn, err := amqp.Dial(b.cfg.URL)
	if err != nil {
		return err
	}
	ch, err := conn.Channel()
	if err != nil {
		_ = conn.Close()
		return err
	}
	if err := ch.ExchangeDeclare(b.cfg.Exchange, "topic", true, false, false, false, nil); err != nil {
		_ = conn.Close()
		return err
	}
	if err := ch.ExchangeDeclare(b.cfg.DLX, "topic", true, false, false, false, nil); err != nil {
		_ = conn.Close()
		return err
	}
	if _, err := ch.QueueDeclare(b.cfg.Queue, true, false, false, false, nil); err != nil {
		_ = conn.Close()
		return err
	}
	for _, s := range b.cfg.Subjects {
		if err := ch.QueueBind(b.cfg.Queue, s, b.cfg.Exchange, false, nil); err != nil {
			_ = conn.Close()
			return err
		}
	}
	// Manual-ack consumers must not be handed more than PrefetchCount unacked messages at once.
	if err := ch.Qos(b.cfg.PrefetchCount, 0, false); err != nil {
		_ = conn.Close()
		return err
	}
	b.conn = conn
	b.ch = ch
	return nil
}

// Publish sends payload to subject (the routing key) on the topic exchange, injecting the current
// trace context into the AMQP headers so a subscriber can continue the same trace.
func (b *RabbitMessageBus) Publish(ctx context.Context, subject string, payload []byte, headers map[string]string) error {
	table := amqp.Table{}
	for k, v := range headers {
		table[k] = v
	}
	otel.GetTextMapPropagator().Inject(ctx, amqpHeaderCarrier(table))
	return b.ch.PublishWithContext(ctx, b.cfg.Exchange, subject, false, false, amqp.Publishing{
		Headers:   table,
		Body:      payload,
		Timestamp: time.Now(),
	})
}

// Subscribe binds subject to the durable queue and delivers each message to handler with manual
// ack. One bad delivery runs through dispatch, which owns the ack/nack/dead-letter decision, so a
// handler error never kills the subscription.
func (b *RabbitMessageBus) Subscribe(ctx context.Context, subject string, handler ports.MessageHandler) error {
	if err := b.ch.QueueBind(b.cfg.Queue, subject, b.cfg.Exchange, false, nil); err != nil {
		return err
	}
	deliveries, err := b.ch.Consume(b.cfg.Queue, "", false, false, false, false, nil)
	if err != nil {
		return err
	}
	go func() {
		for d := range deliveries {
			b.dispatch(ctx, handler, amqpDelivery{d})
		}
	}()
	return nil
}

// dispatch runs handler within the delivery's trace context, then acks on success or nacks/dead-
// letters on failure per the disposition rule. The control-plane decision is always logged: a
// dead-letter drops the message from redelivery, which must never be silent. The handler still owns
// its own domain error logging/tracing.
func (b *RabbitMessageBus) dispatch(parent context.Context, handler ports.MessageHandler, d delivery) {
	headers := d.Headers()
	ctx := otel.GetTextMapPropagator().Extract(parent, amqpHeaderCarrier(headers))
	inbound := ports.InboundMessage{
		Subject: d.RoutingKey(),
		Payload: d.Body(),
		Headers: flattenAMQPHeaders(headers),
	}

	err := handler(ctx, inbound)
	numDelivered := deliveryCount(headers) + 1
	switch disposition(err == nil, numDelivered, b.cfg.MaxDeliver) {
	case actionAck:
		b.control(func() error { return d.Ack(false) }, "ack", d.RoutingKey())
	case actionRequeue:
		b.cfg.Logger.Warn("message handler failed; scheduling redelivery",
			"subject", d.RoutingKey(),
			"num_delivered", numDelivered,
			"error", err,
		)
		b.control(func() error { return d.Nack(false, true) }, "nack", d.RoutingKey())
	case actionDeadLetter:
		b.cfg.Logger.Error("message terminated after exhausting delivery attempts",
			"subject", d.RoutingKey(),
			"exchange", b.cfg.Exchange,
			"dlx", b.cfg.DLX,
			"num_delivered", numDelivered,
			"max_deliver", b.cfg.MaxDeliver,
			"error", err,
		)
		if dlErr := b.deadLetter(ctx, d); dlErr != nil {
			b.cfg.Logger.Error("dead-letter publish failed",
				"subject", d.RoutingKey(), "dlx", b.cfg.DLX, "error", dlErr)
		}
		// Ack the original only after dead-lettering, so the message leaves the source queue once
		// it has a home in the DLX.
		b.control(func() error { return d.Ack(false) }, "ack", d.RoutingKey())
	}
}

// publishDeadLetter re-publishes a terminated delivery to the dead-letter exchange, preserving its
// routing key, headers (trace context included), and body.
func (b *RabbitMessageBus) publishDeadLetter(ctx context.Context, d delivery) error {
	table := amqp.Table{}
	for k, v := range d.Headers() {
		table[k] = v
	}
	return b.ch.PublishWithContext(ctx, b.cfg.DLX, d.RoutingKey(), false, false, amqp.Publishing{
		Headers: table,
		Body:    d.Body(),
	})
}

// control runs an ack/nack call, logging (not raising) a control-plane failure so a redelivery or
// duplicate-processing anomaly stays diagnosable.
func (b *RabbitMessageBus) control(op func() error, name, subject string) {
	if err := op(); err != nil {
		b.cfg.Logger.Error("amqp control call failed", "op", name, "subject", subject, "error", err)
	}
}

// Close closes the channel and the connection (call at shutdown).
func (b *RabbitMessageBus) Close() error {
	if b.ch != nil {
		_ = b.ch.Close()
		b.ch = nil
	}
	if b.conn != nil {
		err := b.conn.Close()
		b.conn = nil
		return err
	}
	return nil
}

// dispatchAction is the ack/nack/dead-letter decision for one delivery.
type dispatchAction int

const (
	actionAck dispatchAction = iota
	actionRequeue
	actionDeadLetter
)

// disposition is the pure delivery-contract decision, modelled on the NATS adapter's dispatch and
// unit-tested without a broker: ack on handler success; requeue (nack) while the delivery count is
// below maxDeliver; dead-letter (terminate) at the cap.
func disposition(ok bool, numDelivered, maxDeliver int) dispatchAction {
	if ok {
		return actionAck
	}
	if numDelivered >= maxDeliver {
		return actionDeadLetter
	}
	return actionRequeue
}

// delivery is the slice of amqp.Delivery that dispatch needs, so a broker-free test can supply a
// fake that records its ack/nack calls. amqpDelivery adapts a real amqp.Delivery (whose Headers,
// Body, and RoutingKey are fields, not methods) to it.
type delivery interface {
	Ack(multiple bool) error
	Nack(multiple, requeue bool) error
	Headers() amqp.Table
	Body() []byte
	RoutingKey() string
}

type amqpDelivery struct{ d amqp.Delivery }

func (a amqpDelivery) Ack(multiple bool) error           { return a.d.Ack(multiple) }
func (a amqpDelivery) Nack(multiple, requeue bool) error { return a.d.Nack(multiple, requeue) }
func (a amqpDelivery) Headers() amqp.Table               { return a.d.Headers }
func (a amqpDelivery) Body() []byte                      { return a.d.Body }
func (a amqpDelivery) RoutingKey() string                { return a.d.RoutingKey }

// deliveryCount reads the redelivery count from the AMQP x-delivery-count header (quorum queues
// expose it), falling back to the portable keel-delivery-count header, and 0 when neither is
// present (the first delivery). dispatch adds one to get a 1-based attempt count matching the NATS
// adapter's NumDelivered.
func deliveryCount(t amqp.Table) int {
	if n, ok := headerInt(t, "x-delivery-count"); ok {
		return n
	}
	if n, ok := headerInt(t, "keel-delivery-count"); ok {
		return n
	}
	return 0
}

// headerInt reads an integer AMQP header value across the signed integer types the wire codec may
// decode it as.
func headerInt(t amqp.Table, key string) (int, bool) {
	switch n := t[key].(type) {
	case int:
		return n, true
	case int8:
		return int(n), true
	case int16:
		return int(n), true
	case int32:
		return int(n), true
	case int64:
		return int(n), true
	default:
		return 0, false
	}
}

// flattenAMQPHeaders collapses an AMQP header table to the single-valued string propagation map the
// port exposes, keeping only string-valued headers (the trace-context carrier among them).
func flattenAMQPHeaders(t amqp.Table) map[string]string {
	out := make(map[string]string, len(t))
	for k, v := range t {
		if s, ok := v.(string); ok {
			out[k] = s
		}
	}
	return out
}

// amqpHeaderCarrier adapts an AMQP header table to the OTel TextMapCarrier interface, so the global
// propagator can inject into and extract trace context from message headers.
type amqpHeaderCarrier amqp.Table

func (c amqpHeaderCarrier) Get(key string) string {
	if s, ok := c[key].(string); ok {
		return s
	}
	return ""
}

func (c amqpHeaderCarrier) Set(key, value string) { c[key] = value }

func (c amqpHeaderCarrier) Keys() []string {
	keys := make([]string, 0, len(c))
	for k := range c {
		keys = append(keys, k)
	}
	return keys
}

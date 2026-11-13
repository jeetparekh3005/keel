// Package messaging provides the NATS JetStream adapter for the MessageBus port (ADR-0012):
// durable, explicit-ack, at-least-once delivery. Trace context is injected into message headers
// on publish and re-extracted around each handler, so a consumer's work joins the producer's
// trace. On handler failure the message is nak'd (redelivered) until MaxDeliver, then term'd and
// logged at error, so a poison message neither loops forever nor is dropped silently.
package messaging

import (
	"context"
	"log/slog"
	"regexp"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"go.opentelemetry.io/otel"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/ports"
)

// durableUnsafe matches every character a NATS durable name may not contain (it mirrors the
// Python adapter's rule), so a subject like "keel.test.>" maps to a legal durable name.
var durableUnsafe = regexp.MustCompile(`[^A-Za-z0-9_]`)

// Config configures a NatsMessageBus: the server URL, the JetStream stream and its subjects, and
// the delivery policy. The zero value of each tuning field is replaced with a safe default by New.
type Config struct {
	URL      string
	Stream   string
	Subjects []string

	// MaxDeliver caps redelivery attempts before a failed message is terminated (dead-lettered).
	MaxDeliver int
	// AckWait must exceed the worst-case handler latency, or the server redelivers a still
	// in-flight message and processes it twice.
	AckWait time.Duration
	// MaxAckPending bounds the number of unacked in-flight messages.
	MaxAckPending int
	// Logger records redelivery/termination decisions; it defaults to slog.Default() so a
	// terminated (dead-lettered) message is never dropped without a trace.
	Logger *slog.Logger
}

// NatsMessageBus is a MessageBus backed by NATS JetStream for durable at-least-once delivery.
type NatsMessageBus struct {
	cfg       Config
	nc        *nats.Conn
	js        jetstream.JetStream
	stream    jetstream.Stream
	consumers []jetstream.ConsumeContext
}

var _ ports.MessageBus = (*NatsMessageBus)(nil)

// New builds a NatsMessageBus from cfg, filling in defaults for any unset tuning field. Call
// Connect before Publish or Subscribe.
func New(cfg Config) *NatsMessageBus {
	if cfg.MaxDeliver == 0 {
		cfg.MaxDeliver = 5
	}
	if cfg.AckWait == 0 {
		cfg.AckWait = 30 * time.Second
	}
	if cfg.MaxAckPending == 0 {
		cfg.MaxAckPending = 256
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return &NatsMessageBus{cfg: cfg}
}

// Connect opens the connection and ensures the JetStream stream exists for the configured
// subjects (creating it or reconciling the subject list if it already exists).
func (b *NatsMessageBus) Connect(ctx context.Context) error {
	nc, err := nats.Connect(b.cfg.URL)
	if err != nil {
		return err
	}
	js, err := jetstream.New(nc)
	if err != nil {
		nc.Close()
		return err
	}
	stream, err := js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
		Name:     b.cfg.Stream,
		Subjects: b.cfg.Subjects,
	})
	if err != nil {
		nc.Close()
		return err
	}
	b.nc = nc
	b.js = js
	b.stream = stream
	return nil
}

// Publish sends payload to subject, injecting the current trace context into the message headers
// so a subscriber can continue the same trace.
func (b *NatsMessageBus) Publish(ctx context.Context, subject string, payload []byte, headers map[string]string) error {
	hdr := nats.Header{}
	for k, v := range headers {
		hdr.Set(k, v)
	}
	otel.GetTextMapPropagator().Inject(ctx, natsHeaderCarrier(hdr))
	_, err := b.js.PublishMsg(ctx, &nats.Msg{Subject: subject, Data: payload, Header: hdr})
	return err
}

// Subscribe delivers messages on subject to handler via a durable, explicit-ack consumer. The
// consumer filters to subject within the configured stream; each delivery runs through dispatch.
func (b *NatsMessageBus) Subscribe(ctx context.Context, subject string, handler ports.MessageHandler) error {
	cons, err := b.stream.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{
		Durable:       durableName(subject),
		FilterSubject: subject,
		AckPolicy:     jetstream.AckExplicitPolicy,
		MaxDeliver:    b.cfg.MaxDeliver,
		AckWait:       b.cfg.AckWait,
		MaxAckPending: b.cfg.MaxAckPending,
	})
	if err != nil {
		return err
	}
	consCtx, err := cons.Consume(func(msg jetstream.Msg) {
		b.dispatch(ctx, handler, msg)
	})
	if err != nil {
		return err
	}
	b.consumers = append(b.consumers, consCtx)
	return nil
}

// dispatch runs handler within the message's trace context, then acks on success or nak/terms on
// failure. One bad handler must not kill the subscription, so a handler error is handled here, not
// propagated.
func (b *NatsMessageBus) dispatch(parent context.Context, handler ports.MessageHandler, msg jetstream.Msg) {
	hdr := msg.Headers()
	ctx := otel.GetTextMapPropagator().Extract(parent, natsHeaderCarrier(hdr))
	inbound := ports.InboundMessage{
		Subject: msg.Subject(),
		Payload: msg.Data(),
		Headers: flattenHeaders(hdr),
	}

	if err := handler(ctx, inbound); err != nil {
		// Redeliver until the cap, then terminate. Always log the control-plane decision:
		// terminate dead-letters the message (drops it from redelivery), which must never be
		// silent. The handler still owns its own domain error logging/tracing.
		var delivered uint64
		if meta, metaErr := msg.Metadata(); metaErr == nil {
			delivered = meta.NumDelivered
		}
		if delivered >= uint64(b.cfg.MaxDeliver) {
			b.cfg.Logger.Error("message terminated after exhausting delivery attempts",
				"subject", msg.Subject(),
				"stream", b.cfg.Stream,
				"num_delivered", delivered,
				"max_deliver", b.cfg.MaxDeliver,
				"error", err,
			)
			b.control(msg.Term, "term", msg.Subject())
		} else {
			b.cfg.Logger.Warn("message handler failed; scheduling redelivery",
				"subject", msg.Subject(),
				"num_delivered", delivered,
				"error", err,
			)
			b.control(msg.Nak, "nak", msg.Subject())
		}
		return
	}
	b.control(msg.Ack, "ack", msg.Subject())
}

// control runs an ack/nak/term call, logging (not raising) a control-plane failure so a redelivery
// or duplicate-processing anomaly stays diagnosable.
func (b *NatsMessageBus) control(op func() error, name, subject string) {
	if err := op(); err != nil {
		b.cfg.Logger.Error("jetstream control call failed", "op", name, "subject", subject, "error", err)
	}
}

// Close stops the consumers and drains the connection (call at shutdown).
func (b *NatsMessageBus) Close() error {
	for _, c := range b.consumers {
		c.Stop()
	}
	if b.nc != nil {
		err := b.nc.Drain()
		b.nc = nil
		return err
	}
	return nil
}

func durableName(subject string) string {
	return "keel_" + durableUnsafe.ReplaceAllString(subject, "_")
}

// flattenHeaders collapses a multi-valued NATS header map to the single-valued propagation map the
// port exposes, keeping the first value of each key.
func flattenHeaders(h nats.Header) map[string]string {
	out := make(map[string]string, len(h))
	for k := range h {
		out[k] = h.Get(k)
	}
	return out
}

// natsHeaderCarrier adapts a NATS header map to the OTel TextMapCarrier interface, so the global
// propagator can inject into and extract trace context from message headers.
type natsHeaderCarrier nats.Header

func (c natsHeaderCarrier) Get(key string) string { return nats.Header(c).Get(key) }

func (c natsHeaderCarrier) Set(key, value string) { nats.Header(c).Set(key, value) }

func (c natsHeaderCarrier) Keys() []string {
	keys := make([]string, 0, len(c))
	for k := range c {
		keys = append(keys, k)
	}
	return keys
}

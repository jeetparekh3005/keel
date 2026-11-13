package ports

import "context"

// InboundMessage is a delivered message: its subject, the raw payload, and the propagation
// headers carried alongside it (the trace-context carrier, among any domain headers).
type InboundMessage struct {
	Subject string
	Payload []byte
	Headers map[string]string
}

// MessageHandler processes a delivered message. The context carries the trace context extracted
// from the message headers, so a handler's work joins the producer's trace. Returning a non-nil
// error signals the delivery failed and the message should be redelivered (nak); a nil return
// acks the message.
type MessageHandler func(ctx context.Context, msg InboundMessage) error

// MessagePublisher publishes events to a subject (driven port, platform.yaml interservice.async).
type MessagePublisher interface {
	// Publish sends payload to subject with optional headers. The current trace context is
	// injected into the headers so a subscriber can continue the same trace.
	Publish(ctx context.Context, subject string, payload []byte, headers map[string]string) error
}

// MessageBus is a publisher that also lets consumers subscribe to subjects, with durable,
// explicit-ack, at-least-once delivery.
type MessageBus interface {
	MessagePublisher
	// Subscribe registers handler to receive messages published to subject.
	Subscribe(ctx context.Context, subject string, handler MessageHandler) error
}

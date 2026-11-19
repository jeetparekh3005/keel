package messaging

// In-memory MessageBus (ADR-0025 section 3, the dev/test default). It dispatches synchronously,
// in-process, to every handler subscribed to a subject - no broker, no durability. Trace context is
// injected into the message headers on publish and re-extracted around each handler, so a handler's
// spans and logs correlate to the publisher's trace exactly as a real broker adapter (NATS/Kafka/
// RabbitMQ) must. It is the bus MessageBusFromEnv returns when no broker gating var is set.

import (
	"context"
	"sync"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/ports"
)

// InMemoryMessageBus is a process-local MessageBus for development and tests.
type InMemoryMessageBus struct {
	mu          sync.RWMutex
	subscribers map[string][]ports.MessageHandler
}

var _ ports.MessageBus = (*InMemoryMessageBus)(nil)

// NewInMemory builds an empty in-memory bus.
func NewInMemory() *InMemoryMessageBus {
	return &InMemoryMessageBus{subscribers: map[string][]ports.MessageHandler{}}
}

// Subscribe registers handler for subject. The context is unused: there is no connection to scope
// the subscription to, matching the lazy no-broker nature of this bus.
func (b *InMemoryMessageBus) Subscribe(_ context.Context, subject string, handler ports.MessageHandler) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.subscribers[subject] = append(b.subscribers[subject], handler)
	return nil
}

// Publish delivers payload to every handler subscribed to subject, injecting the current trace
// context into the headers so each handler continues the publisher's trace. Delivery is synchronous
// and in order; a handler error is returned to the caller and stops the fan-out, since there is no
// broker to redeliver through. A publish to a subject with no subscribers is a no-op.
func (b *InMemoryMessageBus) Publish(ctx context.Context, subject string, payload []byte, headers map[string]string) error {
	carrier := propagation.MapCarrier{}
	for k, v := range headers {
		carrier[k] = v
	}
	otel.GetTextMapPropagator().Inject(ctx, carrier)

	// Copy the handler slice under the lock so a handler that subscribes or publishes during
	// dispatch neither races the read nor mutates the slice being ranged over.
	b.mu.RLock()
	handlers := append([]ports.MessageHandler(nil), b.subscribers[subject]...)
	b.mu.RUnlock()

	for _, handler := range handlers {
		hctx := otel.GetTextMapPropagator().Extract(ctx, carrier)
		msg := ports.InboundMessage{
			Subject: subject,
			Payload: payload,
			Headers: map[string]string(carrier),
		}
		if err := handler(hctx, msg); err != nil {
			return err
		}
	}
	return nil
}

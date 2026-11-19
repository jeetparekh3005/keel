// In-memory MessageBus (the dev/test default). Dispatches synchronously to in-process subscribers.
// Trace context is injected into message headers on publish and re-attached around each handler, so
// handler spans and logs correlate to the publisher's trace - the same way a real broker adapter
// (NATS/Kafka/RabbitMQ) must behave. Parity with the Python vertical's
// keel_core.adapters.outbound.messaging.memory.InMemoryMessageBus.
//
// This module pulls in no broker client, so it is safe for the default build and is the bus the
// `messageBusFromEnv` selector returns when no broker is gated.
import { context as otelContext, propagation } from '@opentelemetry/api';

import { type InboundMessage, type MessageBus, type MessageHandler } from './index.js';

/** A process-local MessageBus for development and tests. */
export class InMemoryMessageBus implements MessageBus {
  private readonly subscribers = new Map<string, MessageHandler[]>();

  /** Register `handler` for `subject`. */
  async subscribe(subject: string, handler: MessageHandler): Promise<void> {
    const handlers = this.subscribers.get(subject);
    if (handlers) {
      handlers.push(handler);
    } else {
      this.subscribers.set(subject, [handler]);
    }
    await Promise.resolve();
  }

  /** Deliver `payload` to every subscriber of `subject`, propagating the active trace context. */
  async publish(
    subject: string,
    payload: Uint8Array,
    options?: { headers?: Record<string, string> },
  ): Promise<void> {
    const carrier: Record<string, string> = { ...(options?.headers ?? {}) };
    // Serialize the active trace context (W3C `traceparent`/`tracestate`) into the carrier so a
    // handler can continue the trace, matching the broker adapters.
    propagation.inject(otelContext.active(), carrier);
    const message: InboundMessage = { subject, payload, headers: carrier };
    // Snapshot the handler list so a subscribe during dispatch does not mutate the iteration.
    for (const handler of [...(this.subscribers.get(subject) ?? [])]) {
      const extracted = propagation.extract(otelContext.active(), carrier);
      await otelContext.with(extracted, async () => {
        await handler(message);
      });
    }
  }
}

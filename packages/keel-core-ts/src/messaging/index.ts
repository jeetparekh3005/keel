// Messaging ports (platform.yaml interservice.async): publish events and consume them. The
// port lives in @keel/core so the domain depends on the seam, not a broker. The NATS JetStream
// adapter (./nats) is a separate, opt-in module that pulls the `nats` client in only when a
// broker URL is configured, so core services without a broker never load it (ADR-0012 parity
// with the Python vertical's keel_core.adapters.outbound.messaging).

/** A delivered message: subject, raw payload, and propagation (e.g. trace-context) headers. */
export interface InboundMessage {
  subject: string;
  payload: Uint8Array;
  headers: Record<string, string>;
}

/**
 * Handles a delivered message. A handler that throws signals a processing failure: the adapter
 * redelivers the message (at-least-once) until the delivery cap, then dead-letters it. Returning
 * acknowledges delivery.
 */
export type MessageHandler = (message: InboundMessage) => Promise<void>;

/** Publishes events to a subject (driven port). */
export interface MessagePublisher {
  /** Publish `payload` to `subject` with optional application headers. */
  publish(
    subject: string,
    payload: Uint8Array,
    options?: { headers?: Record<string, string> },
  ): Promise<void>;
}

/** A publisher that also lets consumers subscribe to subjects. */
export interface MessageBus extends MessagePublisher {
  /** Register `handler` to receive messages published to `subject`. */
  subscribe(subject: string, handler: MessageHandler): Promise<void>;
}

/** DI token for the MessageBus port. */
export const MESSAGE_BUS = Symbol('keel.MessageBus');

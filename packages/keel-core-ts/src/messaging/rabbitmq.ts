// RabbitMQ MessageBus adapter (ADR-0025 parity with the NATS JetStream adapter in ./nats and the
// Python vertical's adapters/outbound/messaging/rabbitmq.py). Implements the MessageBus port over a
// RabbitMQ topic exchange + durable queue with manual-ack, at-least-once delivery.
//
// Delivery contract is identical to NATS, mapped onto RabbitMQ primitives: handler success ->
// basic.ack; failure below the redelivery cap -> basic.nack(requeue=true); at the cap -> publish to
// a dead-letter exchange then basic.ack the original (always logging the terminate) - but if that
// dead-letter publish fails the original is nack(requeue)'d instead of acked, so a poison message
// is never dropped (preserve policy). The redelivery count is read from the AMQP `x-delivery-count`
// header (the queue is declared as a quorum queue so the broker populates it) with a portable
// `keel-delivery-count` fallback, +1 to make it the 1-based num_delivered the cap compares. Trace
// context is injected into AMQP headers on publish (via the global OpenTelemetry propagator,
// configured by the telemetry SDK as W3C trace-context) and
// re-attached around each handler so a consumer's work joins the producer's trace.
//
// amqplib is pinned to 0.10.9, the genuine stable line (it needs the separate @types/amqplib typings
// and carries the real url-parse/buffer-more-ints deps); the registry's anomalous "2.x" dist-tag is a
// different lineage and is deliberately not used.
//
// This module imports the optional `amqplib` client and is NOT re-exported from @keel/core's main
// entry point: import it directly (`@keel/core/messaging/rabbitmq`) only when a broker is configured,
// so services without a broker never load the client.
import { context as otelContext, propagation } from '@opentelemetry/api';
import {
  connect as amqpConnect,
  type Channel,
  type ChannelModel,
  type ConsumeMessage,
  type MessagePropertyHeaders,
} from 'amqplib';

import { createLogger } from '../logging/logger.js';
import { type InboundMessage, type MessageHandler } from './index.js';

/** Minimal structured logger surface used by the adapter (pino's Logger satisfies it). */
export interface BusLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** Connection factory, overridable as a test seam; defaults to the real amqplib client. */
export type ConnectFn = (url: string) => Promise<ChannelModel>;

/** The per-message disposition the delivery contract selects. */
export type Disposition = 'ack' | 'nak' | 'term';

/**
 * Pure delivery-contract decision (modelled on the Rust NATS adapter's `disposition`), factored out
 * so the ack/nak/dead-letter rule is unit-tested without a broker: ack on handler success; redeliver
 * (nak) while the delivery count is below the cap; dead-letter (term) at the cap.
 */
export function disposition(ok: boolean, numDelivered: number, maxDeliver: number): Disposition {
  if (ok) {
    return 'ack';
  }
  if (numDelivered >= maxDeliver) {
    return 'term';
  }
  return 'nak';
}

/** Delivery policy and wiring for the exchange/queue the bus owns. */
export interface RabbitMqMessageBusOptions {
  /** Topic exchange to publish to and bind the queue against. */
  exchange: string;
  /** Durable queue the bus consumes from. */
  queue: string;
  /** Binding patterns (routing-key globs) the queue subscribes to (e.g. `['keel.#']`). */
  subjects: string[];
  /** Dead-letter exchange a poison message is published to at the delivery cap. */
  dlx: string;
  /** Redelivery cap before a failing message is dead-lettered. */
  maxDeliver?: number;
  /** Bound on unacked in-flight messages per consumer (AMQP basic.qos prefetch). */
  prefetch?: number;
  /** Records redelivery/termination decisions; defaults to an info-level JSON logger. */
  logger?: BusLogger;
  /** Overridable connection factory (test seam); defaults to amqplib's `connect`. */
  connectFn?: ConnectFn;
}

/** A MessageBus backed by RabbitMQ for durable at-least-once delivery. */
export class RabbitMqMessageBus {
  private readonly exchange: string;
  private readonly queue: string;
  private readonly subjects: string[];
  private readonly dlx: string;
  private readonly maxDeliver: number;
  private readonly prefetch: number;
  private readonly logger: BusLogger;
  private readonly connectFn: ConnectFn;
  private conn: ChannelModel | undefined;
  private ch: Channel | undefined;

  constructor(
    private readonly url: string,
    options: RabbitMqMessageBusOptions,
  ) {
    this.exchange = options.exchange;
    this.queue = options.queue;
    this.subjects = [...options.subjects];
    this.dlx = options.dlx;
    this.maxDeliver = options.maxDeliver ?? 5;
    this.prefetch = options.prefetch ?? 256;
    this.logger = options.logger ?? createLogger('info');
    this.connectFn = options.connectFn ?? amqpConnect;
  }

  /** Connect, declare the durable topic exchange + dead-letter exchange + queue, and bind subjects. */
  async connect(): Promise<void> {
    const conn = await this.connectFn(this.url);
    this.conn = conn;
    const ch = await conn.createChannel();
    this.ch = ch;
    await ch.assertExchange(this.exchange, 'topic', { durable: true });
    // The dead-letter exchange a terminated message is routed to; declared so publish at the cap
    // cannot fail for a missing exchange.
    await ch.assertExchange(this.dlx, 'topic', { durable: true });
    // Declared as a quorum queue so the broker maintains a native per-message x-delivery-count
    // (classic queues do not emit it) - without it the redelivery count never advances and a
    // poison message is nack(requeue)'d forever instead of dead-lettering. Parity with the
    // Python/Rust adapters, which also declare x-queue-type=quorum.
    await ch.assertQueue(this.queue, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
    for (const subject of this.subjects) {
      await ch.bindQueue(this.queue, this.exchange, subject);
    }
    await ch.prefetch(this.prefetch);
  }

  /** Publish `payload` to `subject` (the routing key), injecting the active trace context into headers. */
  async publish(
    subject: string,
    payload: Uint8Array,
    options?: { headers?: Record<string, string> },
  ): Promise<void> {
    const ch = this.requireChannel('publish');
    const carrier: Record<string, string> = { ...(options?.headers ?? {}) };
    // Serialize the active trace context (W3C `traceparent`/`tracestate`) into the carrier so a
    // consumer can continue the trace.
    propagation.inject(otelContext.active(), carrier);
    // persistent marks the message durable so it survives a broker restart, matching the durable
    // at-least-once contract.
    ch.publish(this.exchange, subject, Buffer.from(payload), {
      headers: carrier,
      persistent: true,
    });
    await Promise.resolve();
  }

  /** Bind `subject` and deliver matching messages to `handler` via a manual-ack consumer. */
  async subscribe(subject: string, handler: MessageHandler): Promise<void> {
    const ch = this.requireChannel('subscribe');
    // Bind the specific subject in addition to the default patterns so a caller can subscribe to a
    // routing key the default binding does not cover.
    await ch.bindQueue(this.queue, this.exchange, subject);
    await ch.consume(
      this.queue,
      (message: ConsumeMessage | null) => {
        // A null delivery signals the consumer was cancelled server-side; nothing to dispatch.
        if (message === null) {
          return;
        }
        void this.dispatch(ch, message, handler);
      },
      { noAck: false },
    );
  }

  /**
   * Run `handler` for one delivered message within its extracted trace context; ack on success,
   * nak (redeliver) on failure below the cap, dead-letter at the cap (publish to the DLX, then ack
   * only if that publish succeeded - otherwise nak(requeue) to preserve the message). The channel
   * is passed in so the disposition is exercised without a live connection. Invoked by the consume
   * callback; exposed for contract tests.
   */
  async dispatch(ch: Channel, message: ConsumeMessage, handler: MessageHandler): Promise<void> {
    const headers = headersToRecord(message.properties.headers);
    const subject = message.fields.routingKey;
    const inbound: InboundMessage = {
      subject,
      payload: new Uint8Array(message.content),
      headers,
    };
    // Re-attach the producer's trace context so the handler's spans/logs join that trace.
    const extracted = propagation.extract(otelContext.active(), headers);
    await otelContext.with(extracted, async () => {
      let ok = false;
      let err: unknown;
      try {
        await handler(inbound);
        ok = true;
      } catch (caught) {
        err = caught;
      }

      // x-delivery-count is the broker's count of prior failed attempts (0 on first delivery), so
      // +1 yields the 1-based num_delivered the disposition cap compares against - matching the
      // Go/Rust adapters. Without the +1 the cap is reached one delivery late (dead-letters on the
      // 6th attempt instead of the 5th for maxDeliver=5).
      const numDelivered = deliveryCount(headers) + 1;
      const decision = disposition(ok, numDelivered, this.maxDeliver);
      switch (decision) {
        case 'ack':
          await this.control(() => ch.ack(message), 'ack', subject);
          return;
        case 'nak':
          // One bad handler must not kill the subscription: redeliver until the cap.
          this.logger.warn(
            { subject, num_delivered: numDelivered, err: errorText(err) },
            'message handler failed; scheduling redelivery',
          );
          await this.control(() => ch.nack(message, false, true), 'nak', subject);
          return;
        case 'term': {
          // At the cap the message is dead-lettered. The terminate decision is always logged - a
          // dead-letter must never be silent. Preserve policy: the original is acked ONLY after the
          // DLX publish succeeds; if that publish fails the message is nack(requeue)'d so it is
          // retried rather than ack-and-dropped (data loss). Parity with the Python/Java adapters.
          this.logger.error(
            {
              subject,
              exchange: this.exchange,
              queue: this.queue,
              dlx: this.dlx,
              num_delivered: numDelivered,
              max_deliver: this.maxDeliver,
              err: errorText(err),
            },
            'message terminated after exhausting delivery attempts',
          );
          let dlxPublished = false;
          try {
            ch.publish(this.dlx, subject, message.content, {
              headers: message.properties.headers ?? {},
            });
            dlxPublished = true;
          } catch (dlxErr) {
            this.logger.error(
              { op: 'dlx', subject, err: errorText(dlxErr) },
              'dead-letter publish failed; requeueing to preserve the message',
            );
          }
          if (!dlxPublished) {
            await this.control(() => ch.nack(message, false, true), 'nak', subject);
            return;
          }
          await this.control(() => ch.ack(message), 'ack', subject);
          return;
        }
      }
    });
  }

  /** Close the channel and connection (call at shutdown). */
  async close(): Promise<void> {
    if (this.ch) {
      await this.ch.close();
      this.ch = undefined;
    }
    if (this.conn) {
      await this.conn.close();
      this.conn = undefined;
    }
  }

  private requireChannel(op: string): Channel {
    if (!this.ch) {
      throw new Error(`RabbitMqMessageBus.connect() must be called before ${op}()`);
    }
    return this.ch;
  }

  /** Run an ack/nak/dead-letter call, logging (not raising) a control-plane failure so it is diagnosable. */
  private async control(
    op: () => void | Promise<void>,
    name: string,
    subject: string,
  ): Promise<void> {
    try {
      await op();
    } catch (err) {
      this.logger.error({ op: name, subject, err: errorText(err) }, 'amqp control call failed');
    }
  }
}

/** Flatten AMQP message headers into a plain string record for propagation extract and the handler. */
function headersToRecord(headers: MessagePropertyHeaders | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) {
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) {
      continue;
    }
    out[key] = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  }
  return out;
}

/**
 * The broker's raw redelivery count: the quorum-queue `x-delivery-count` header, falling back to
 * the portable `keel-delivery-count` header. This is the count of prior failed attempts, 0 on the
 * first delivery; the caller adds 1 to get the 1-based num_delivered the delivery cap compares.
 */
function deliveryCount(headers: Record<string, string>): number {
  const raw = headers['x-delivery-count'] ?? headers['keel-delivery-count'];
  if (raw === undefined) {
    return 0;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

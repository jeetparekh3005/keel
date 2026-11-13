// NATS JetStream MessageBus adapter (ADR-0012 parity with the Python vertical's
// adapters/outbound/messaging/nats.py). Implements the MessageBus port over NATS JetStream with
// durable, explicit-ack, at-least-once delivery.
//
// Trace context is injected into message headers on publish (via the global OpenTelemetry
// propagator, which the telemetry SDK configures as W3C trace-context) and re-attached around
// each handler so a consumer's work joins the producer's trace. On handler failure the message is
// nak'd (redelivered) until `maxDeliver`, then term'd and logged at error, so a poison message
// neither loops forever nor is dropped silently.
//
// This module imports the optional `nats` client and is NOT re-exported from @keel/core's main
// entry point: import it directly (`@keel/core/messaging/nats`) only when a broker is configured,
// so services without a broker never load the client.
import { context as otelContext, propagation } from '@opentelemetry/api';
import {
  connect as natsConnect,
  consumerOpts,
  createInbox,
  headers as natsHeaders,
  type ConnectionOptions,
  type JetStreamClient,
  type JsMsg,
  type MsgHdrs,
  type NatsConnection,
} from 'nats';

import { createLogger } from '../logging/logger.js';
import { type InboundMessage, type MessageHandler } from './index.js';

/** Minimal structured logger surface used by the adapter (pino's Logger satisfies it). */
export interface BusLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** Connection factory, overridable as a test seam; defaults to the real nats client. */
export type ConnectFn = (options: ConnectionOptions) => Promise<NatsConnection>;

/** Delivery policy and wiring for the JetStream stream the bus owns. */
export interface NatsMessageBusOptions {
  /** JetStream stream name to create/reconcile for `subjects`. */
  stream: string;
  /** Subjects the stream captures (e.g. `['keel.events.>']`). */
  subjects: string[];
  /** Redelivery cap before a failing message is dead-lettered (term'd). */
  maxDeliver?: number;
  /**
   * Milliseconds the server waits for an ack before redelivering. Must exceed the worst-case
   * handler latency, or an in-flight message is redelivered and processed twice.
   */
  ackWaitMs?: number;
  /** Bound on unacked in-flight messages per consumer. */
  maxAckPending?: number;
  /** Records redelivery/termination decisions; defaults to an info-level JSON logger. */
  logger?: BusLogger;
  /** Overridable connection factory (test seam); defaults to the nats client's `connect`. */
  connectFn?: ConnectFn;
}

// Durable consumer names allow only [A-Za-z0-9_-]; derive a stable, safe name per subject.
const DURABLE_UNSAFE = /[^A-Za-z0-9_]/g;

/** A MessageBus backed by NATS JetStream for durable at-least-once delivery. */
export class NatsMessageBus {
  private readonly stream: string;
  private readonly subjects: string[];
  private readonly maxDeliver: number;
  private readonly ackWaitMs: number;
  private readonly maxAckPending: number;
  private readonly logger: BusLogger;
  private readonly connectFn: ConnectFn;
  private nc: NatsConnection | undefined;
  private js: JetStreamClient | undefined;

  constructor(
    private readonly url: string,
    options: NatsMessageBusOptions,
  ) {
    this.stream = options.stream;
    this.subjects = [...options.subjects];
    this.maxDeliver = options.maxDeliver ?? 5;
    this.ackWaitMs = options.ackWaitMs ?? 30_000;
    this.maxAckPending = options.maxAckPending ?? 256;
    this.logger = options.logger ?? createLogger('info');
    this.connectFn = options.connectFn ?? natsConnect;
  }

  /** Connect and ensure the JetStream stream exists for the configured subjects. */
  async connect(): Promise<void> {
    const nc = await this.connectFn({ servers: this.url });
    this.nc = nc;
    this.js = nc.jetstream();
    const jsm = await nc.jetstreamManager();
    try {
      await jsm.streams.add({ name: this.stream, subjects: this.subjects });
    } catch {
      // Stream already exists (created by another instance or a prior run) - reconcile subjects.
      await jsm.streams.update(this.stream, { subjects: this.subjects });
    }
  }

  /** Publish `payload` to `subject`, injecting the active trace context into message headers. */
  async publish(
    subject: string,
    payload: Uint8Array,
    options?: { headers?: Record<string, string> },
  ): Promise<void> {
    const js = this.requireJs('publish');
    const carrier: Record<string, string> = { ...(options?.headers ?? {}) };
    // Serialize the active trace context (W3C `traceparent`/`tracestate`) into the carrier so a
    // consumer can continue the trace.
    propagation.inject(otelContext.active(), carrier);
    const hdrs = natsHeaders();
    for (const [key, value] of Object.entries(carrier)) {
      hdrs.set(key, value);
    }
    await js.publish(subject, payload, { headers: hdrs });
  }

  /** Deliver messages on `subject` to `handler` via a durable, explicit-ack push consumer. */
  async subscribe(subject: string, handler: MessageHandler): Promise<void> {
    const js = this.requireJs('subscribe');
    const durable = 'keel_' + subject.replace(DURABLE_UNSAFE, '_');
    const opts = consumerOpts();
    opts.durable(durable);
    opts.manualAck();
    opts.ackExplicit();
    opts.deliverTo(createInbox());
    opts.maxDeliver(this.maxDeliver);
    opts.ackWait(this.ackWaitMs);
    opts.maxAckPending(this.maxAckPending);

    const sub = await js.subscribe(subject, opts);
    void (async () => {
      for await (const message of sub) {
        await this.dispatch(message, handler);
      }
    })();
  }

  /**
   * Run `handler` for one delivered message within its extracted trace context; ack on success,
   * nak (redeliver) on failure below the cap, term (dead-letter) at the cap. Invoked by the
   * subscription loop; exposed for contract tests.
   */
  async dispatch(message: JsMsg, handler: MessageHandler): Promise<void> {
    const headers = headersToRecord(message.headers);
    const inbound: InboundMessage = {
      subject: message.subject,
      payload: message.data,
      headers,
    };
    // Re-attach the producer's trace context so the handler's spans/logs join that trace.
    const extracted = propagation.extract(otelContext.active(), headers);
    await otelContext.with(extracted, async () => {
      try {
        await handler(inbound);
      } catch (err) {
        // One bad handler must not kill the subscription: redeliver until the cap, then terminate.
        // The terminate decision is always logged - a dead-letter must never be silent.
        const numDelivered = message.info.redeliveryCount;
        if (numDelivered >= this.maxDeliver) {
          this.logger.error(
            {
              subject: message.subject,
              stream: this.stream,
              num_delivered: numDelivered,
              max_deliver: this.maxDeliver,
              err: errorText(err),
            },
            'message terminated after exhausting delivery attempts',
          );
          await this.control(() => message.term(), 'term', message.subject);
        } else {
          this.logger.warn(
            { subject: message.subject, num_delivered: numDelivered, err: errorText(err) },
            'message handler failed; scheduling redelivery',
          );
          await this.control(() => message.nak(), 'nak', message.subject);
        }
        return;
      }
      await this.control(() => message.ack(), 'ack', message.subject);
    });
  }

  /** Drain and close the connection (call at shutdown). */
  async close(): Promise<void> {
    if (this.nc) {
      await this.nc.drain();
      this.nc = undefined;
      this.js = undefined;
    }
  }

  private requireJs(op: string): JetStreamClient {
    if (!this.js) {
      throw new Error(`NatsMessageBus.connect() must be called before ${op}()`);
    }
    return this.js;
  }

  /** Run an ack/nak/term call, logging (not raising) a control-plane failure so it is diagnosable. */
  private async control(
    op: () => void | Promise<void>,
    name: string,
    subject: string,
  ): Promise<void> {
    try {
      await op();
    } catch (err) {
      this.logger.error(
        { op: name, subject, err: errorText(err) },
        'jetstream control call failed',
      );
    }
  }
}

/** Flatten NATS message headers into a plain record for propagation extract and the handler. */
function headersToRecord(hdrs: MsgHdrs | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!hdrs) {
    return out;
  }
  for (const key of hdrs.keys()) {
    const value = hdrs.get(key);
    if (value) {
      out[key] = value;
    }
  }
  return out;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Unit coverage for the RabbitMQ adapter without a broker (ADR-0025 parity with nats.spec.ts and
// the Python vertical's tests/test_rabbitmq_dispatch.py): per-message ack/nak/dead-letter logic, the
// pure disposition function, trace-context injection on publish, exchange/queue declaration on
// connect, and the subscription dispatch loop. A fake channel/connection (the adapter's connectFn
// seam) exercises connect/subscribe/close; the real round-trip lives in rabbitmq.integration.spec.ts
// (gated on KEEL_RABBITMQ_URL).
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import type { Channel, ConsumeMessage, MessagePropertyHeaders } from 'amqplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { InboundMessage, MessageHandler } from './index.js';
import { type BusLogger, disposition, RabbitMqMessageBus } from './rabbitmq.js';

interface LogCall {
  level: 'info' | 'warn' | 'error';
  obj: Record<string, unknown>;
  msg: string;
}

function recordingLogger(): { logger: BusLogger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const logger: BusLogger = {
    info: (obj, msg) => calls.push({ level: 'info', obj, msg }),
    warn: (obj, msg) => calls.push({ level: 'warn', obj, msg }),
    error: (obj, msg) => calls.push({ level: 'error', obj, msg }),
  };
  return { logger, calls };
}

interface Published {
  exchange: string;
  routingKey: string;
  content: Buffer;
  headers?: MessagePropertyHeaders;
}

/** A fake AMQP channel recording ack/nack/publish so the disposition is asserted broker-free. */
function fakeChannel(opts?: { failAck?: boolean }) {
  const state = {
    acked: 0,
    nacked: 0,
    lastNackRequeue: undefined as boolean | undefined,
    published: [] as Published[],
    exchanges: [] as { exchange: string; type: string }[],
    queues: [] as string[],
    bindings: [] as { queue: string; source: string; pattern: string }[],
    prefetchCount: undefined as number | undefined,
    closed: false,
    delivered: [] as ConsumeMessage[],
  };
  const ch = {
    assertExchange(exchange: string, type: string) {
      state.exchanges.push({ exchange, type });
      return Promise.resolve({ exchange });
    },
    assertQueue(queue: string) {
      state.queues.push(queue);
      return Promise.resolve({ queue, messageCount: 0, consumerCount: 0 });
    },
    bindQueue(queue: string, source: string, pattern: string) {
      state.bindings.push({ queue, source, pattern });
      return Promise.resolve({});
    },
    prefetch(count: number) {
      state.prefetchCount = count;
      return Promise.resolve({});
    },
    publish(
      exchange: string,
      routingKey: string,
      content: Buffer,
      options?: { headers?: MessagePropertyHeaders },
    ): boolean {
      state.published.push({ exchange, routingKey, content, headers: options?.headers });
      return true;
    },
    consume(_queue: string, onMessage: (msg: ConsumeMessage | null) => void) {
      for (const m of state.delivered) {
        onMessage(m);
      }
      return Promise.resolve({ consumerTag: 'tag' });
    },
    ack() {
      if (opts?.failAck) {
        throw new Error('ack failed');
      }
      state.acked += 1;
    },
    nack(_message: unknown, _allUpTo?: boolean, requeue?: boolean) {
      state.nacked += 1;
      state.lastNackRequeue = requeue;
    },
    close() {
      state.closed = true;
      return Promise.resolve();
    },
  };
  return { ch: ch as unknown as Channel, state };
}

/** A fake ChannelModel driving the adapter's connectFn seam. */
function fakeConnection(opts?: { failAck?: boolean }) {
  const channel = fakeChannel(opts);
  let connClosed = false;
  const conn = {
    createChannel: () => Promise.resolve(channel.ch),
    close: () => {
      connClosed = true;
      return Promise.resolve();
    },
  };
  const connectFn = () => Promise.resolve(conn as never);
  return { connectFn, channel, isConnClosed: () => connClosed };
}

function fakeMsg(opts?: {
  deliveryCount?: number;
  keelDeliveryCount?: number;
  headers?: MessagePropertyHeaders;
  routingKey?: string;
  payload?: string;
}): ConsumeMessage {
  const headers: MessagePropertyHeaders = { ...(opts?.headers ?? {}) };
  if (opts?.deliveryCount !== undefined) {
    headers['x-delivery-count'] = opts.deliveryCount;
  }
  if (opts?.keelDeliveryCount !== undefined) {
    headers['keel-delivery-count'] = String(opts.keelDeliveryCount);
  }
  return {
    content: Buffer.from(opts?.payload ?? 'payload'),
    fields: {
      deliveryTag: 1,
      redelivered: false,
      exchange: 'keel',
      routingKey: opts?.routingKey ?? 'keel.test.events',
      consumerTag: 'tag',
    },
    properties: {
      headers,
      contentType: undefined,
      contentEncoding: undefined,
      deliveryMode: undefined,
      priority: undefined,
      correlationId: undefined,
      replyTo: undefined,
      expiration: undefined,
      messageId: undefined,
      timestamp: undefined,
      type: undefined,
      userId: undefined,
      appId: undefined,
      clusterId: undefined,
    },
  };
}

function makeBus(o?: {
  logger?: BusLogger;
  connectFn?: ReturnType<typeof fakeConnection>['connectFn'];
  maxDeliver?: number;
}): RabbitMqMessageBus {
  return new RabbitMqMessageBus('amqp://unused', {
    exchange: 'keel',
    queue: 'keel',
    subjects: ['keel.#'],
    dlx: 'keel.dlx',
    maxDeliver: o?.maxDeliver ?? 5,
    logger: o?.logger,
    connectFn: o?.connectFn,
  });
}

// A real W3C propagator + async-context manager so publish/consume exercise genuine trace-context
// serialization (the global propagator is a no-op until the SDK or a test sets one).
beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(new BasicTracerProvider());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
});

afterAll(() => {
  context.disable();
  trace.disable();
  propagation.disable();
});

describe('disposition', () => {
  it('acks on success regardless of delivery count', () => {
    expect(disposition(true, 9, 5)).toBe('ack');
  });

  it('naks below the cap and terms at or above it', () => {
    expect(disposition(false, 1, 5)).toBe('nak');
    expect(disposition(false, 4, 5)).toBe('nak');
    expect(disposition(false, 5, 5)).toBe('term');
    expect(disposition(false, 6, 5)).toBe('term');
  });
});

describe('RabbitMqMessageBus.dispatch', () => {
  it('acks on handler success', async () => {
    const { ch, state } = fakeChannel();
    const handler: MessageHandler = () => Promise.resolve();
    await makeBus().dispatch(ch, fakeMsg(), handler);
    expect(state.acked).toBe(1);
    expect(state.nacked).toBe(0);
    expect(state.published).toHaveLength(0);
  });

  it('naks (requeues) on failure below maxDeliver', async () => {
    const { logger, calls } = recordingLogger();
    const { ch, state } = fakeChannel();
    const handler: MessageHandler = () => Promise.reject(new Error('transient'));
    await makeBus({ logger }).dispatch(ch, fakeMsg({ deliveryCount: 1 }), handler);
    expect(state.nacked).toBe(1);
    expect(state.lastNackRequeue).toBe(true);
    expect(state.acked).toBe(0);
    expect(state.published).toHaveLength(0);
    expect(calls.some((c) => c.level === 'warn')).toBe(true);
  });

  it('dead-letters to the DLX and acks at the delivery cap, logging the terminate', async () => {
    const { logger, calls } = recordingLogger();
    const { ch, state } = fakeChannel();
    const handler: MessageHandler = () => Promise.reject(new Error('poison'));
    await makeBus({ logger, maxDeliver: 5 }).dispatch(ch, fakeMsg({ deliveryCount: 5 }), handler);
    // Published to the dead-letter exchange with the original subject as routing key, then acked.
    expect(state.published).toHaveLength(1);
    expect(state.published[0].exchange).toBe('keel.dlx');
    expect(state.published[0].routingKey).toBe('keel.test.events');
    expect(state.acked).toBe(1);
    expect(state.nacked).toBe(0);
    const terminated = calls.find((c) => c.level === 'error' && c.msg.includes('terminated'));
    expect(terminated, 'terminate must be logged').toBeDefined();
    expect(terminated?.obj.subject).toBe('keel.test.events');
    expect(terminated?.obj.num_delivered).toBe(5);
    expect(terminated?.obj.max_deliver).toBe(5);
    expect(terminated?.obj.dlx).toBe('keel.dlx');
  });

  it('reads the delivery count from the keel-delivery-count fallback header', async () => {
    const { logger, calls } = recordingLogger();
    const { ch, state } = fakeChannel();
    const handler: MessageHandler = () => Promise.reject(new Error('poison'));
    // No x-delivery-count; the portable fallback at the cap must still dead-letter.
    await makeBus({ logger, maxDeliver: 5 }).dispatch(
      ch,
      fakeMsg({ keelDeliveryCount: 5 }),
      handler,
    );
    expect(state.published).toHaveLength(1);
    expect(state.acked).toBe(1);
    expect(calls.some((c) => c.level === 'error' && c.msg.includes('terminated'))).toBe(true);
  });

  it('logs a failed control call instead of propagating it', async () => {
    const { logger, calls } = recordingLogger();
    const { ch } = fakeChannel({ failAck: true });
    const handler: MessageHandler = () => Promise.resolve();
    await makeBus({ logger }).dispatch(ch, fakeMsg(), handler);
    expect(calls.some((c) => c.level === 'error' && c.msg.includes('control call failed'))).toBe(
      true,
    );
  });

  it('extracts the producer trace context and runs the handler within it', async () => {
    const tracer = trace.getTracer('test');
    const span = tracer.startSpan('producer');
    const producerTraceId = span.spanContext().traceId;
    const carrier: Record<string, string> = {};
    context.with(trace.setSpan(context.active(), span), () => {
      propagation.inject(context.active(), carrier);
    });
    span.end();

    const { ch } = fakeChannel();
    let seenTraceId: string | undefined;
    const handler: MessageHandler = () => {
      seenTraceId = trace.getSpanContext(context.active())?.traceId;
      return Promise.resolve();
    };
    await makeBus().dispatch(ch, fakeMsg({ headers: carrier }), handler);
    expect(seenTraceId).toBe(producerTraceId);
  });
});

describe('RabbitMqMessageBus.connect', () => {
  it('declares the exchange, dead-letter exchange, queue, bindings, and prefetch', async () => {
    const conn = fakeConnection();
    const bus = makeBus({ connectFn: conn.connectFn });
    await bus.connect();
    const { state } = conn.channel;
    expect(state.exchanges).toContainEqual({ exchange: 'keel', type: 'topic' });
    expect(state.exchanges).toContainEqual({ exchange: 'keel.dlx', type: 'topic' });
    expect(state.queues).toEqual(['keel']);
    expect(state.bindings).toContainEqual({ queue: 'keel', source: 'keel', pattern: 'keel.#' });
    expect(state.prefetchCount).toBe(256);
  });
});

describe('RabbitMqMessageBus.publish', () => {
  it('throws if called before connect', async () => {
    await expect(makeBus().publish('keel.test.events', new Uint8Array())).rejects.toThrow(
      /connect\(\) must be called/,
    );
  });

  it('injects trace context and application headers into the message', async () => {
    const conn = fakeConnection();
    const bus = makeBus({ connectFn: conn.connectFn });
    await bus.connect();

    const tracer = trace.getTracer('test');
    const span = tracer.startSpan('publisher');
    const traceId = span.spanContext().traceId;
    await context.with(trace.setSpan(context.active(), span), () =>
      bus.publish('keel.test.events', new TextEncoder().encode('hi'), {
        headers: { 'x-demo': '1' },
      }),
    );
    span.end();

    const { state } = conn.channel;
    expect(state.published).toHaveLength(1);
    expect(state.published[0].exchange).toBe('keel');
    expect(state.published[0].routingKey).toBe('keel.test.events');
    const headers = state.published[0].headers as Record<string, string>;
    expect(headers['x-demo']).toBe('1');
    expect(headers.traceparent).toContain(traceId);
  });
});

describe('RabbitMqMessageBus.subscribe', () => {
  it('binds the subject and dispatches delivered messages to the handler, acking them', async () => {
    const conn = fakeConnection();
    conn.channel.state.delivered = [fakeMsg(), fakeMsg()];
    const bus = makeBus({ connectFn: conn.connectFn });
    await bus.connect();

    const received: string[] = [];
    const handler: MessageHandler = (m: InboundMessage) => {
      received.push(new TextDecoder().decode(m.payload));
      return Promise.resolve();
    };
    await bus.subscribe('keel.test.events', handler);

    for (let i = 0; i < 50 && received.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(received).toEqual(['payload', 'payload']);
    expect(conn.channel.state.bindings).toContainEqual({
      queue: 'keel',
      source: 'keel',
      pattern: 'keel.test.events',
    });
    expect(conn.channel.state.acked).toBe(2);
  });
});

describe('RabbitMqMessageBus.close', () => {
  it('closes the channel and connection', async () => {
    const conn = fakeConnection();
    const bus = makeBus({ connectFn: conn.connectFn });
    await bus.connect();
    await bus.close();
    expect(conn.channel.state.closed).toBe(true);
    expect(conn.isConnClosed()).toBe(true);
  });

  it('is a no-op before connect', async () => {
    await expect(makeBus().close()).resolves.toBeUndefined();
  });
});

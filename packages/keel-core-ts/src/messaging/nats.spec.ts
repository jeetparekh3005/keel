// Unit coverage for the NATS JetStream adapter without a broker (parity with the Python
// vertical's tests/test_nats_dispatch.py): per-message ack/nak/term logic, trace-context
// injection on publish, stream reconciliation on connect, and the subscription dispatch loop.
// A fake connection (the adapter's connectFn seam) exercises connect/subscribe/close; the real
// round-trip lives in nats.integration.spec.ts (gated on KEEL_NATS_URL).
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { headers as natsHeaders, type JsMsg, type MsgHdrs } from 'nats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { InboundMessage, MessageHandler } from './index.js';
import { type BusLogger, NatsMessageBus } from './nats.js';

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

interface FakeMsg {
  subject: string;
  data: Uint8Array;
  headers?: MsgHdrs;
  info: { redeliveryCount: number };
  acked: boolean;
  nakked: boolean;
  termed: boolean;
  ack(): void;
  nak(): void;
  term(): void;
}

function fakeMsg(opts?: { redeliveryCount?: number; hdrs?: MsgHdrs; failAck?: boolean }): FakeMsg {
  return {
    subject: 'keel.test.events',
    data: new TextEncoder().encode('payload'),
    headers: opts?.hdrs,
    info: { redeliveryCount: opts?.redeliveryCount ?? 1 },
    acked: false,
    nakked: false,
    termed: false,
    ack() {
      if (opts?.failAck) {
        throw new Error('ack failed');
      }
      this.acked = true;
    },
    nak() {
      this.nakked = true;
    },
    term() {
      this.termed = true;
    },
  };
}

function asJsMsg(msg: FakeMsg): JsMsg {
  return msg as unknown as JsMsg;
}

/** A fake JetStream connection driving the adapter's connectFn seam. */
function fakeConnection(opts?: { streamExists?: boolean; delivered?: FakeMsg[] }) {
  const published: { subject: string; data: Uint8Array; hdrs?: MsgHdrs }[] = [];
  const streams = {
    added: [] as unknown[],
    updated: [] as unknown[],
    add(cfg: unknown): Promise<unknown> {
      if (opts?.streamExists) {
        return Promise.reject(new Error('stream name already in use'));
      }
      streams.added.push(cfg);
      return Promise.resolve(cfg);
    },
    update(_name: string, cfg: unknown): Promise<unknown> {
      streams.updated.push(cfg);
      return Promise.resolve(cfg);
    },
  };
  const js = {
    publish(subject: string, data: Uint8Array, popts?: { headers?: MsgHdrs }): Promise<unknown> {
      published.push({ subject, data, hdrs: popts?.headers });
      return Promise.resolve({ seq: published.length });
    },
    subscribe(): Promise<AsyncIterable<JsMsg>> {
      const msgs = opts?.delivered ?? [];
      const iterable: AsyncIterable<JsMsg> = {
        async *[Symbol.asyncIterator]() {
          for (const m of msgs) {
            await Promise.resolve();
            yield asJsMsg(m);
          }
        },
      };
      return Promise.resolve(iterable);
    },
  };
  let drained = false;
  const nc = {
    jetstream: () => js,
    jetstreamManager: () => Promise.resolve({ streams }),
    drain: () => {
      drained = true;
      return Promise.resolve();
    },
  };
  const connectFn = () => Promise.resolve(nc as never);
  return { connectFn, published, streams, isDrained: () => drained };
}

function newBus(overrides?: Partial<Parameters<typeof makeBus>[0]>) {
  return makeBus(overrides ?? {});
}

function makeBus(o: {
  logger?: BusLogger;
  connectFn?: ReturnType<typeof fakeConnection>['connectFn'];
  maxDeliver?: number;
}): NatsMessageBus {
  return new NatsMessageBus('nats://unused', {
    stream: 'keel-test',
    subjects: ['keel.test.>'],
    maxDeliver: o.maxDeliver ?? 5,
    logger: o.logger,
    connectFn: o.connectFn,
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

describe('NatsMessageBus.dispatch', () => {
  it('acks on handler success', async () => {
    const handler: MessageHandler = () => Promise.resolve();
    const msg = fakeMsg();
    await newBus().dispatch(asJsMsg(msg), handler);
    expect(msg.acked).toBe(true);
    expect(msg.nakked).toBe(false);
    expect(msg.termed).toBe(false);
  });

  it('naks (redelivers) on failure below maxDeliver', async () => {
    const { logger, calls } = recordingLogger();
    const handler: MessageHandler = () => Promise.reject(new Error('transient'));
    const msg = fakeMsg({ redeliveryCount: 1 });
    await newBus({ logger }).dispatch(asJsMsg(msg), handler);
    expect(msg.nakked).toBe(true);
    expect(msg.acked).toBe(false);
    expect(msg.termed).toBe(false);
    expect(calls.some((c) => c.level === 'warn')).toBe(true);
  });

  it('terminates and logs at the delivery cap so a poison message is not silent', async () => {
    const { logger, calls } = recordingLogger();
    const handler: MessageHandler = () => Promise.reject(new Error('poison'));
    const msg = fakeMsg({ redeliveryCount: 5 });
    await newBus({ logger, maxDeliver: 5 }).dispatch(asJsMsg(msg), handler);
    expect(msg.termed).toBe(true);
    expect(msg.acked).toBe(false);
    expect(msg.nakked).toBe(false);
    const terminated = calls.find((c) => c.level === 'error' && c.msg.includes('terminated'));
    expect(terminated, 'terminate must be logged').toBeDefined();
    expect(terminated?.obj.subject).toBe('keel.test.events');
    expect(terminated?.obj.num_delivered).toBe(5);
    expect(terminated?.obj.max_deliver).toBe(5);
  });

  it('logs a failed control call instead of propagating it', async () => {
    const { logger, calls } = recordingLogger();
    const handler: MessageHandler = () => Promise.resolve();
    const msg = fakeMsg({ failAck: true });
    await newBus({ logger }).dispatch(asJsMsg(msg), handler);
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

    const hdrs = natsHeaders();
    for (const [k, v] of Object.entries(carrier)) {
      hdrs.set(k, v);
    }

    let seenTraceId: string | undefined;
    const handler: MessageHandler = () => {
      seenTraceId = trace.getSpanContext(context.active())?.traceId;
      return Promise.resolve();
    };
    const msg = fakeMsg({ hdrs });
    await newBus().dispatch(asJsMsg(msg), handler);
    expect(seenTraceId).toBe(producerTraceId);
  });
});

describe('NatsMessageBus.connect', () => {
  it('creates the stream for the configured subjects', async () => {
    const conn = fakeConnection();
    const bus = newBus({ connectFn: conn.connectFn });
    await bus.connect();
    expect(conn.streams.added).toHaveLength(1);
    expect(conn.streams.updated).toHaveLength(0);
  });

  it('reconciles subjects when the stream already exists', async () => {
    const conn = fakeConnection({ streamExists: true });
    const bus = newBus({ connectFn: conn.connectFn });
    await bus.connect();
    expect(conn.streams.added).toHaveLength(0);
    expect(conn.streams.updated).toHaveLength(1);
  });
});

describe('NatsMessageBus.publish', () => {
  it('throws if called before connect', async () => {
    await expect(newBus().publish('keel.test.events', new Uint8Array())).rejects.toThrow(
      /connect\(\) must be called/,
    );
  });

  it('injects trace context and application headers into the message', async () => {
    const conn = fakeConnection();
    const bus = newBus({ connectFn: conn.connectFn });
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

    expect(conn.published).toHaveLength(1);
    const hdrs = conn.published[0].hdrs;
    expect(hdrs?.get('x-demo')).toBe('1');
    const traceparent = hdrs?.get('traceparent');
    expect(traceparent).toContain(traceId);
  });
});

describe('NatsMessageBus.subscribe', () => {
  it('dispatches delivered messages to the handler and acks them', async () => {
    const delivered = [fakeMsg(), fakeMsg()];
    const conn = fakeConnection({ delivered });
    const bus = newBus({ connectFn: conn.connectFn });
    await bus.connect();

    const received: string[] = [];
    const handler: MessageHandler = (m: InboundMessage) => {
      received.push(new TextDecoder().decode(m.payload));
      return Promise.resolve();
    };
    await bus.subscribe('keel.test.events', handler);

    for (let i = 0; i < 50 && received.length < delivered.length; i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(received).toEqual(['payload', 'payload']);
    expect(delivered.every((m) => m.acked)).toBe(true);
  });
});

describe('NatsMessageBus.close', () => {
  it('drains the connection', async () => {
    const conn = fakeConnection();
    const bus = newBus({ connectFn: conn.connectFn });
    await bus.connect();
    await bus.close();
    expect(conn.isDrained()).toBe(true);
  });

  it('is a no-op before connect', async () => {
    await expect(newBus().close()).resolves.toBeUndefined();
  });
});

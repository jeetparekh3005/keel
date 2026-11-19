// Unit coverage for the Kafka adapter without a broker (ADR-0025 parity with rabbitmq.spec.ts,
// nats.spec.ts, and the Go vertical's kafka_test.go): per-record commit/retry/dead-letter logic, the
// pure disposition function, trace-context injection on publish, producer/consumer wiring on connect,
// and the subscription dispatch loop. A fake sink records produces/commits so the disposition is
// asserted broker-free; a fake kafkajs client (the adapter's connectFn seam) exercises
// connect/publish/subscribe/close. The real round-trip lives in kafka.integration.spec.ts (gated on
// KEEL_KAFKA_BROKERS).
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import type { Consumer, KafkaMessage, Producer } from 'kafkajs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { InboundMessage, MessageHandler } from './index.js';
import {
  type BusLogger,
  type ConnectFn,
  type ConsumedRecord,
  type KafkaFactory,
  type ProducedRecord,
  type RecordSink,
  disposition,
  KafkaMessageBus,
  topicName,
} from './kafka.js';

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

/** A fake sink recording produces and commits so the disposition is asserted without a live client. */
function fakeSink(opts?: { produceErr?: boolean; commitErr?: boolean }) {
  const state = { produced: [] as ProducedRecord[], commits: 0 };
  const sink: RecordSink = {
    produce(record: ProducedRecord): Promise<void> {
      if (opts?.produceErr) {
        return Promise.reject(new Error('broker down'));
      }
      state.produced.push(record);
      return Promise.resolve();
    },
    commit(): Promise<void> {
      if (opts?.commitErr) {
        return Promise.reject(new Error('commit failed'));
      }
      state.commits += 1;
      return Promise.resolve();
    },
  };
  const lastProducedTo = (suffix: string): ProducedRecord | undefined => {
    let last: ProducedRecord | undefined;
    for (const r of state.produced) {
      if (r.topic.endsWith(suffix)) {
        last = r;
      }
    }
    return last;
  };
  return { sink, state, lastProducedTo };
}

/**
 * Build a base-topic record whose keel-delivery-count header encodes a 1-based numDelivered
 * (count = numDelivered-1), matching the Go adapter's convention; numDelivered 1 omits the header
 * entirely (the first delivery).
 */
function newRecord(
  numDelivered: number,
  opts?: { topic?: string; payload?: string; headers?: Record<string, string> },
): ConsumedRecord {
  const headers: Record<string, string> = { ...(opts?.headers ?? {}) };
  if (numDelivered > 1) {
    headers['keel-delivery-count'] = String(numDelivered - 1);
  }
  return {
    topic: opts?.topic ?? 'keel_test_events',
    partition: 0,
    offset: '0',
    key: null,
    value: Buffer.from(opts?.payload ?? 'payload'),
    headers,
  };
}

function makeBus(o?: {
  logger?: BusLogger;
  maxDeliver?: number;
  dlqTopic?: string;
  connectFn?: ConnectFn;
}): KafkaMessageBus {
  return new KafkaMessageBus({
    brokers: ['unused:9092'],
    topics: ['keel.test.events'],
    groupId: 'keel',
    maxDeliver: o?.maxDeliver ?? 5,
    dlqTopic: o?.dlqTopic,
    logger: o?.logger,
    connectFn: o?.connectFn,
  });
}

function kafkaMessage(opts?: {
  value?: Buffer;
  offset?: string;
  headers?: Record<string, string>;
  key?: Buffer | null;
}): KafkaMessage {
  return {
    key: opts?.key ?? null,
    value: opts?.value ?? Buffer.from('payload'),
    timestamp: '0',
    attributes: 0,
    offset: opts?.offset ?? '0',
    size: 0,
    headers: opts?.headers,
  } as unknown as KafkaMessage;
}

/** A fake kafkajs client driving the adapter's connectFn seam. */
function fakeKafka(opts?: {
  connectErr?: Error;
  delivered?: { topic: string; partition: number; message: KafkaMessage }[];
}) {
  const state = {
    producerConnected: false,
    consumerConnected: false,
    producerDisconnected: false,
    consumerDisconnected: false,
    sent: [] as {
      topic: string;
      messages: { key?: unknown; value: unknown; headers?: unknown }[];
    }[],
    committed: [] as { topic: string; partition: number; offset: string }[],
    subscribed: [] as { topics: string[]; fromBeginning: boolean }[],
  };
  const producer = {
    connect: () =>
      opts?.connectErr
        ? Promise.reject(opts.connectErr)
        : voidP(() => (state.producerConnected = true)),
    disconnect: () => voidP(() => (state.producerDisconnected = true)),
    send: (record: {
      topic: string;
      messages: { key?: unknown; value: unknown; headers?: unknown }[];
    }) => {
      state.sent.push(record);
      return Promise.resolve([]);
    },
  };
  const consumer = {
    connect: () => voidP(() => (state.consumerConnected = true)),
    disconnect: () => voidP(() => (state.consumerDisconnected = true)),
    subscribe: (s: { topics: string[]; fromBeginning: boolean }) => {
      state.subscribed.push(s);
      return Promise.resolve();
    },
    run: async (config: {
      autoCommit: boolean;
      eachMessage: (p: {
        topic: string;
        partition: number;
        message: KafkaMessage;
      }) => Promise<void>;
    }) => {
      for (const d of opts?.delivered ?? []) {
        await config.eachMessage(d);
      }
    },
    commitOffsets: (o: { topic: string; partition: number; offset: string }[]) => {
      state.committed.push(...o);
      return Promise.resolve();
    },
  };
  const kafka: KafkaFactory = {
    producer: () => producer as unknown as Producer,
    consumer: () => consumer as unknown as Consumer,
  };
  const connectFn: ConnectFn = () => kafka;
  return { connectFn, state };
}

function voidP(fn: () => void): Promise<void> {
  fn();
  return Promise.resolve();
}

const okHandler: MessageHandler = () => Promise.resolve();
const failHandler: MessageHandler = () => Promise.reject(new Error('poison'));

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
  it('commits on success regardless of delivery count', () => {
    expect(disposition(true, 1, 5)).toBe('commit');
    expect(disposition(true, 9, 5)).toBe('commit');
  });

  it('retries below the cap and dead-letters at or above it', () => {
    expect(disposition(false, 1, 5)).toBe('retry');
    expect(disposition(false, 4, 5)).toBe('retry');
    expect(disposition(false, 5, 5)).toBe('dead-letter');
    expect(disposition(false, 6, 5)).toBe('dead-letter');
  });
});

describe('topicName', () => {
  it('sanitizes non-alphanumeric characters to underscore (the NATS durable rule)', () => {
    expect(topicName('keel')).toBe('keel');
    expect(topicName('keel.test.events')).toBe('keel_test_events');
    expect(topicName('keel.test.>')).toBe('keel_test__');
  });
});

describe('KafkaMessageBus.dispatch', () => {
  it('commits on handler success, producing nothing', async () => {
    const { sink, state } = fakeSink();
    await makeBus().dispatch(sink, newRecord(1), okHandler);
    expect(state.commits).toBe(1);
    expect(state.produced).toHaveLength(0);
  });

  it('re-produces to the retry topic and commits below the cap', async () => {
    const { logger, calls } = recordingLogger();
    const { sink, state, lastProducedTo } = fakeSink();
    await makeBus({ logger }).dispatch(sink, newRecord(1), failHandler);
    const retry = lastProducedTo('.retry');
    expect(retry, 'want a record produced to the retry topic').toBeDefined();
    expect(retry?.topic).toBe('keel_test_events.retry');
    // The retried record carries the incremented delivery count so the next attempt sees it.
    expect(retry?.headers['keel-delivery-count']).toBe('1');
    expect(state.commits, 'original offset committed after the retry produce').toBe(1);
    expect(calls.some((c) => c.level === 'warn' && c.msg.includes('redelivery'))).toBe(true);
  });

  it('dead-letters to the dlq topic and commits at the cap, logging the terminate', async () => {
    const { logger, calls } = recordingLogger();
    const { sink, state, lastProducedTo } = fakeSink();
    await makeBus({ logger, maxDeliver: 5 }).dispatch(sink, newRecord(5), failHandler);
    const dlq = lastProducedTo('.dlq');
    expect(dlq, 'want a record produced to the dead-letter topic').toBeDefined();
    expect(dlq?.topic).toBe('keel_test_events.dlq');
    expect(dlq?.value.toString('utf8')).toBe('payload');
    expect(state.commits, 'original offset committed after dead-lettering').toBe(1);
    const terminated = calls.find((c) => c.level === 'error' && c.msg.includes('terminated'));
    expect(terminated, 'terminate must be logged').toBeDefined();
    expect(terminated?.obj.subject).toBe('keel_test_events');
    expect(terminated?.obj.num_delivered).toBe(5);
    expect(terminated?.obj.max_deliver).toBe(5);
    expect(terminated?.obj.dlq_topic).toBe('keel_test_events.dlq');
  });

  // The critical guarantee (mirrors Go's TestKafkaRepeatedlyFailingRecordDeadLettersAtFifthAttempt):
  // simulate the consumer group redelivering the record by feeding each retry produce back into
  // dispatch, and prove it is retried exactly four times and dead-lettered on the fifth attempt -
  // never looping forever, never dropped early.
  it('dead-letters a repeatedly failing record on exactly the fifth attempt as the count grows', async () => {
    const { logger, calls } = recordingLogger();
    const bus = makeBus({ logger, maxDeliver: 5 });
    let rec = newRecord(1);
    let attempts = 0;
    let deadLettered = false;
    while (attempts < 100) {
      attempts++;
      const { sink, lastProducedTo } = fakeSink();
      await bus.dispatch(sink, rec, failHandler);
      const dlq = lastProducedTo('.dlq');
      if (dlq) {
        deadLettered = true;
        break;
      }
      const retry = lastProducedTo('.retry');
      expect(retry, `attempt ${attempts} produced neither a retry nor a dead-letter`).toBeDefined();
      // The consumer group redelivers the retried record; it becomes the next attempt's input.
      rec = {
        topic: 'keel_test_events',
        partition: 0,
        offset: '0',
        key: (retry as ProducedRecord).key,
        value: (retry as ProducedRecord).value,
        headers: (retry as ProducedRecord).headers,
      };
    }
    expect(deadLettered).toBe(true);
    expect(attempts, '4 retries then dead-letter on the 5th attempt').toBe(5);
    expect(calls.some((c) => c.level === 'error' && c.msg.includes('terminated'))).toBe(true);
  });

  it('preserves the offset (no commit) when the retry produce fails', async () => {
    const { logger, calls } = recordingLogger();
    const { sink, state } = fakeSink({ produceErr: true });
    await makeBus({ logger, maxDeliver: 5 }).dispatch(sink, newRecord(1), failHandler);
    expect(state.commits, 'offset must not be committed when the retry produce fails').toBe(0);
    expect(calls.some((c) => c.level === 'error' && c.msg.includes('retry produce failed'))).toBe(
      true,
    );
  });

  it('preserves the offset (no commit) when the dead-letter produce fails', async () => {
    const { logger, calls } = recordingLogger();
    const { sink, state } = fakeSink({ produceErr: true });
    await makeBus({ logger, maxDeliver: 5 }).dispatch(sink, newRecord(5), failHandler);
    expect(state.commits, 'offset must not be committed when the dead-letter produce fails').toBe(
      0,
    );
    expect(
      calls.some((c) => c.level === 'error' && c.msg.includes('dead-letter produce failed')),
    ).toBe(true);
  });

  it('logs a failed commit instead of propagating it', async () => {
    const { logger, calls } = recordingLogger();
    const { sink } = fakeSink({ commitErr: true });
    await makeBus({ logger }).dispatch(sink, newRecord(1), okHandler);
    expect(calls.some((c) => c.level === 'error' && c.msg.includes('control call failed'))).toBe(
      true,
    );
  });

  it('routes a record arriving on <topic>.retry back to the base-topic subject', async () => {
    const { sink } = fakeSink();
    let seen: string | undefined;
    const handler: MessageHandler = (m: InboundMessage) => {
      seen = m.subject;
      return Promise.resolve();
    };
    await makeBus().dispatch(sink, newRecord(1, { topic: 'keel_test_events.retry' }), handler);
    expect(seen).toBe('keel_test_events');
  });

  it('dead-letters to the KEEL_KAFKA_DLQ_TOPIC override when set', async () => {
    const { sink, lastProducedTo } = fakeSink();
    await makeBus({ maxDeliver: 5, dlqTopic: 'keel.deadletters' }).dispatch(
      sink,
      newRecord(5),
      failHandler,
    );
    const dlq = lastProducedTo('');
    expect(dlq?.topic).toBe('keel.deadletters');
  });

  it('treats an absent delivery-count header as the first delivery', async () => {
    const { sink, lastProducedTo } = fakeSink();
    // No keel-delivery-count header: numDelivered is 1, so a failure retries (not dead-letters).
    await makeBus({ maxDeliver: 5 }).dispatch(sink, newRecord(1), failHandler);
    expect(lastProducedTo('.retry')?.headers['keel-delivery-count']).toBe('1');
  });

  it('reads the delivery count from the keel-delivery-count header to dead-letter at the cap', async () => {
    const { sink, lastProducedTo } = fakeSink();
    // keel-delivery-count 4 => this is the 5th delivery == the cap, so it must dead-letter.
    await makeBus({ maxDeliver: 5 }).dispatch(
      sink,
      newRecord(1, { headers: { 'keel-delivery-count': '4' } }),
      failHandler,
    );
    expect(lastProducedTo('.dlq')).toBeDefined();
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

    const { sink } = fakeSink();
    let seenTraceId: string | undefined;
    const handler: MessageHandler = () => {
      seenTraceId = trace.getSpanContext(context.active())?.traceId;
      return Promise.resolve();
    };
    await makeBus().dispatch(sink, newRecord(1, { headers: carrier }), handler);
    expect(seenTraceId).toBe(producerTraceId);
  });
});

describe('KafkaMessageBus.connect', () => {
  it('creates and connects the producer and consumer', async () => {
    const kafka = fakeKafka();
    await makeBus({ connectFn: kafka.connectFn }).connect();
    expect(kafka.state.producerConnected).toBe(true);
    expect(kafka.state.consumerConnected).toBe(true);
  });

  it('never leaks brokers or SASL credentials into a connect error', async () => {
    const leaky = new Error(
      'connect ECONNREFUSED broker-host:9092 sasl password=super-secret-pass',
    );
    const kafka = fakeKafka({ connectErr: leaky });
    const { logger, calls } = recordingLogger();
    let thrown: unknown;
    try {
      await makeBus({ logger, connectFn: kafka.connectFn }).connect();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toBe('kafka connection failed');
    expect(message).not.toContain('broker-host');
    expect(message).not.toContain('super-secret-pass');
    // And nothing with the credentials reached the logs either.
    const logged = JSON.stringify(calls);
    expect(logged).not.toContain('broker-host');
    expect(logged).not.toContain('super-secret-pass');
  });
});

describe('KafkaMessageBus.publish', () => {
  it('throws if called before connect', async () => {
    await expect(makeBus().publish('keel.test.events', new Uint8Array())).rejects.toThrow(
      /connect\(\) must be called/,
    );
  });

  it('produces to the sanitized topic with trace context and application headers', async () => {
    const kafka = fakeKafka();
    const bus = makeBus({ connectFn: kafka.connectFn });
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

    expect(kafka.state.sent).toHaveLength(1);
    expect(kafka.state.sent[0].topic).toBe('keel_test_events');
    const headers = kafka.state.sent[0].messages[0].headers as Record<string, string>;
    expect(headers['x-demo']).toBe('1');
    expect(headers.traceparent).toContain(traceId);
  });
});

describe('KafkaMessageBus.subscribe', () => {
  it('subscribes the base and retry topics and dispatches delivered records, committing them', async () => {
    const kafka = fakeKafka({
      delivered: [
        {
          topic: 'keel_test_events',
          partition: 0,
          message: kafkaMessage({ offset: '7', value: Buffer.from('hello') }),
        },
      ],
    });
    const bus = makeBus({ connectFn: kafka.connectFn });
    await bus.connect();

    const received: string[] = [];
    const handler: MessageHandler = (m: InboundMessage) => {
      received.push(new TextDecoder().decode(m.payload));
      return Promise.resolve();
    };
    await bus.subscribe('keel.test.events', handler);

    expect(received).toEqual(['hello']);
    expect(kafka.state.subscribed).toContainEqual({
      topics: ['keel_test_events', 'keel_test_events.retry'],
      fromBeginning: false,
    });
    // Committed the next offset to consume (one past the processed record).
    expect(kafka.state.committed).toContainEqual({
      topic: 'keel_test_events',
      partition: 0,
      offset: '8',
    });
  });
});

describe('KafkaMessageBus.close', () => {
  it('disconnects the producer and consumer', async () => {
    const kafka = fakeKafka();
    const bus = makeBus({ connectFn: kafka.connectFn });
    await bus.connect();
    await bus.close();
    expect(kafka.state.producerDisconnected).toBe(true);
    expect(kafka.state.consumerDisconnected).toBe(true);
  });

  it('is a no-op before connect', async () => {
    await expect(makeBus().close()).resolves.toBeUndefined();
  });
});

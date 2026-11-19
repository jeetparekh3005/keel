// Kafka adapter against a real broker (ADR-0025, parity with the Go vertical's
// kafka_integration_test.go and rabbitmq.integration.spec.ts).
//
// Runs only when KEEL_KAFKA_BROKERS is set (CI starts an apache/kafka KRaft container); skipped
// otherwise so a local `pnpm test` stays green without a broker. The first test exercises a full
// publish -> subscribe round-trip: the payload and application headers arrive intact and the
// producer's W3C trace context propagates (the trace id the handler sees equals the one the producer
// started with, and the traceparent header survives on the record). The second proves the
// poison-record contract end to end: a record whose handler always fails is re-produced through the
// retry topic and lands on the dead-letter topic at the cap rather than looping forever.
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { Kafka, logLevel } from 'kafkajs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { InboundMessage, MessageHandler } from './index.js';
import { KafkaMessageBus, topicName } from './kafka.js';

const rawBrokers = process.env.KEEL_KAFKA_BROKERS;
const brokers = (rawBrokers ?? '')
  .split(',')
  .map((b) => b.trim())
  .filter((b) => b.length > 0);

/** A unique subject per run so a rerun does not read a prior run's committed offsets. */
function uniqueSubject(prefix: string): string {
  return `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1e6)}`;
}

/**
 * Poll `predicate` until it is true or `timeoutMs` elapses. The deadline is an absolute wall-clock
 * instant (`Date.now() + timeoutMs`) and the per-tick sleep is a fixed small positive interval, so no
 * computed delay is ever negative (a relative timeout used as an absolute deadline would make the
 * remaining-time setTimeout wildly negative).
 */
async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe.skipIf(brokers.length === 0)('KafkaMessageBus (real broker)', () => {
  let provider: BasicTracerProvider;

  beforeAll(() => {
    // A real propagator + async-context manager: without them the global propagator is a no-op and
    // no trace context would be written, so the propagation assertion below would be vacuous.
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    provider = new BasicTracerProvider();
    trace.setGlobalTracerProvider(provider);
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  });

  afterAll(async () => {
    await provider.shutdown();
    context.disable();
    trace.disable();
    propagation.disable();
  });

  it('round-trips a payload and propagates trace context end to end', async () => {
    const subject = uniqueSubject('keel.test.roundtrip');
    const bus = new KafkaMessageBus({ brokers, topics: [subject], groupId: topicName(subject) });
    await bus.connect();
    try {
      const received: InboundMessage[] = [];
      const traceIds: (string | undefined)[] = [];
      await bus.subscribe(subject, (message) => {
        received.push(message);
        traceIds.push(trace.getSpanContext(context.active())?.traceId);
        return Promise.resolve();
      });

      const span = trace.getTracer('test').startSpan('producer');
      const producerTraceId = span.spanContext().traceId;
      await context.with(trace.setSpan(context.active(), span), () =>
        bus.publish(subject, new TextEncoder().encode('hello'), { headers: { 'x-demo': '1' } }),
      );
      span.end();

      await waitUntil(() => received.length > 0, 60_000);

      expect(received, `no message delivered to ${subject}`).toHaveLength(1);
      const message = received[0];
      // The delivered subject is the ORIGINAL published subject (carried in the keel-subject header),
      // not the lossy-sanitized topic name.
      expect(message.subject).toBe(subject);
      expect(new TextDecoder().decode(message.payload)).toBe('hello');
      expect(message.headers['x-demo']).toBe('1');
      // The producer's trace id reached the consumer through the record headers.
      expect(message.headers.traceparent).toContain(producerTraceId);
      expect(traceIds[0]).toBe(producerTraceId);
    } finally {
      await bus.close();
    }
  }, 90_000);

  it('dead-letters a poison record to <topic>.dlq rather than looping forever', async () => {
    const subject = uniqueSubject('keel.test.poison');
    // maxDeliver 3 keeps the round-trip short; the contract is the same at 5.
    const bus = new KafkaMessageBus({
      brokers,
      topics: [subject],
      groupId: topicName(subject),
      maxDeliver: 3,
    });
    await bus.connect();

    // A separate consumer reads the dead-letter topic from the start so it sees the poison record.
    const dlqTopic = `${topicName(subject)}.dlq`;
    const dlqConsumer = new Kafka({
      clientId: 'keel-dlq-reader',
      brokers,
      logLevel: logLevel.NOTHING,
    }).consumer({ groupId: `${topicName(subject)}.dlq.reader` });
    await dlqConsumer.connect();

    try {
      const failing: MessageHandler = () => Promise.reject(new Error('poison'));
      await bus.subscribe(subject, failing);

      const deadLettered: string[] = [];
      await dlqConsumer.subscribe({ topic: dlqTopic, fromBeginning: true });
      await dlqConsumer.run({
        autoCommit: true,
        eachMessage: ({ message }) => {
          deadLettered.push((message.value ?? Buffer.alloc(0)).toString('utf8'));
          return Promise.resolve();
        },
      });

      await bus.publish(subject, new TextEncoder().encode('poison'));

      await waitUntil(() => deadLettered.includes('poison'), 90_000);
      expect(
        deadLettered,
        `poison record never reached the dead-letter topic ${dlqTopic}`,
      ).toContain('poison');
    } finally {
      await dlqConsumer.disconnect();
      await bus.close();
    }
  }, 120_000);
});

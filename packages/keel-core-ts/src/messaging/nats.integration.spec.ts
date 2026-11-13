// NATS JetStream adapter against a real server (epic #419, v0.6 parity with the Python vertical's
// tests/test_nats_integration.py).
//
// Runs only when KEEL_NATS_URL is set (CI spins up a NATS JetStream container); skipped otherwise
// so a local `pnpm test` stays green without a broker. Asserts both halves of the contract: the
// payload and application headers survive a publish -> subscribe round-trip, AND the producer's
// W3C trace context propagates to the consumer (the handler sees the same trace id).
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { InboundMessage } from './index.js';
import { NatsMessageBus } from './nats.js';

const natsUrl = process.env.KEEL_NATS_URL;

describe.skipIf(!natsUrl)('NatsMessageBus (real JetStream)', () => {
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
    // A unique subject space (and stream) per run so the test is idempotent against a reused
    // broker: NATS rejects two streams whose subjects overlap, so a fixed subject would clash with
    // a stream left by a prior run.
    const token = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const subject = `keel.test.${token}.events`;
    const bus = new NatsMessageBus(natsUrl as string, {
      stream: `keel-test-${token}`,
      subjects: [`keel.test.${token}.>`],
    });
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

      for (let i = 0; i < 100 && received.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(received, `no message delivered to ${subject}`).toHaveLength(1);
      const message = received[0];
      expect(message.subject).toBe(subject);
      expect(new TextDecoder().decode(message.payload)).toBe('hello');
      expect(message.headers['x-demo']).toBe('1');
      // The producer's trace id reached the consumer through the message headers.
      expect(message.headers.traceparent).toContain(producerTraceId);
      expect(traceIds[0]).toBe(producerTraceId);
    } finally {
      await bus.close();
    }
  });
});

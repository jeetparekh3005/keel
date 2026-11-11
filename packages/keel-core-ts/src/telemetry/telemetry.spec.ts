import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import type { DestinationStream } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '../logging/logger.js';

// Proves the gap the v0.4 review found: that log-to-trace correlation actually produces
// output, not just that the mixin is wired. With a span active (as HTTP instrumentation makes
// it per request), a log line must carry a valid trace_id/span_id - and the redactor must NOT
// mangle those ids (a digit-heavy or all-zero id is Luhn-valid and was being scrubbed).
describe('trace correlation', () => {
  let provider: BasicTracerProvider;

  beforeAll(() => {
    // OTel 2.x: register the global tracer provider + an async context manager explicitly
    // (BasicTracerProvider.register() was removed). The context manager is what makes
    // startActiveSpan's span readable via trace.getActiveSpan().
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    provider = new BasicTracerProvider();
    trace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    await provider.shutdown();
    context.disable();
    trace.disable();
  });

  function capture(): { lines: Record<string, unknown>[]; stream: DestinationStream } {
    const lines: Record<string, unknown>[] = [];
    const stream: DestinationStream = {
      write(chunk: string) {
        lines.push(JSON.parse(chunk) as Record<string, unknown>);
      },
    };
    return { lines, stream };
  }

  it('stamps a valid, unredacted trace_id/span_id on a log emitted inside a span', () => {
    const { lines, stream } = capture();
    const logger = createLogger('info', stream);
    trace.getTracer('test').startActiveSpan('unit-of-work', (span) => {
      logger.info('inside span');
      span.end();
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(lines[0].span_id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('omits trace fields when no span is active', () => {
    const { lines, stream } = capture();
    const logger = createLogger('info', stream);
    logger.info('outside any span');
    expect(lines[0].trace_id).toBeUndefined();
  });

  it('preserves a valid-shaped (even all-zero) id but scrubs a secret logged under those keys', () => {
    const { lines, stream } = capture();
    const logger = createLogger('info', stream);
    // A valid id shape (all-zero is Luhn-valid) must survive the scrubber unmangled.
    logger.info({ trace_id: '0'.repeat(32), span_id: 'a'.repeat(16) }, 'valid ids');
    expect(lines[0].trace_id).toBe('0'.repeat(32));
    expect(lines[0].span_id).toBe('a'.repeat(16));
    // A secret mis-logged under the exempt key must still be scrubbed (the exemption is shape-gated).
    logger.info({ trace_id: 'Bearer abcdef0123456789token' }, 'secret under key');
    expect(lines[1].trace_id).toBe('[REDACTED]');
  });
});

import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';

import { RedactingSpanExporter } from './span-redaction.js';

// A non-real but pattern-shaped AWS access key id (AWS's own documentation example). Using the
// documented example avoids seeding a plausible live credential into the repo (and never a literal
// JWT, which gitleaks would flag) while still exercising the scrubText AWS pattern.
const AWS_EXAMPLE_KEY = 'AKIAIOSFODNN7EXAMPLE';

// Drive the real export path: span -> SimpleSpanProcessor -> (optional) RedactingSpanExporter ->
// InMemorySpanExporter. The redactor is a drop-in SpanExporter decorator, so omitting it (the
// negative control) feeds the raw span straight to memory and the secrets survive - which is what
// makes the positive assertions non-vacuous.
function exportSpan(wrap: boolean): ReadableSpan {
  const memory = new InMemorySpanExporter();
  const exporter: SpanExporter = wrap ? new RedactingSpanExporter(memory) : memory;
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  const span = provider
    .getTracer('span-redaction-test')
    .startSpan(`GET /download?key=${AWS_EXAMPLE_KEY}`);
  // A secret-family KEY: the value must be redacted wholesale regardless of its content.
  span.setAttribute('db.user.password', 'hunter2');
  // A non-secret KEY whose string VALUE embeds a pattern secret: only the secret run is scrubbed.
  span.setAttribute('url.path', `/download?key=${AWS_EXAMPLE_KEY}&name=report`);
  // A string ARRAY value: each string element is scrubbed independently.
  span.setAttribute('db.statement.params', [AWS_EXAMPLE_KEY, 'ok']);
  // Non-string values carry no secret pattern and must pass through untouched.
  span.setAttribute('http.status_code', 200);
  // A benign string under a benign key must be left exactly as-is (proves we do not blanket-redact).
  span.setAttribute('http.route', '/users/:id');
  span.end();

  const finished = memory.getFinishedSpans();
  expect(finished).toHaveLength(1);
  return finished[0];
}

describe('RedactingSpanExporter', () => {
  const providers: BasicTracerProvider[] = [];
  afterEach(async () => {
    await Promise.all(providers.splice(0).map((p) => p.shutdown()));
  });

  it('redacts secret-family keys, pattern values, and the span name on the export path', () => {
    const span = exportSpan(true);

    // Secret-family KEY -> value redacted wholesale.
    expect(span.attributes['db.user.password']).toBe('[REDACTED]');
    // Pattern secret inside a string VALUE -> only the secret run is replaced.
    expect(span.attributes['url.path']).toBe('/download?key=[REDACTED]&name=report');
    // Each string element of an array value is scrubbed.
    expect(span.attributes['db.statement.params']).toEqual(['[REDACTED]', 'ok']);
    // Non-string value and benign string are untouched.
    expect(span.attributes['http.status_code']).toBe(200);
    expect(span.attributes['http.route']).toBe('/users/:id');
    // The span NAME is pattern-scrubbed too (it bypasses the log sink entirely).
    expect(span.name).toBe('GET /download?key=[REDACTED]');
  });

  it('negative control: without the redactor the same secrets reach the exporter raw', () => {
    const span = exportSpan(false);

    // Every assertion above would hold here only because the redactor ran; unwrapped, the raw
    // secrets are present. If the redactor were a no-op, the positive test would match these.
    expect(span.attributes['db.user.password']).toBe('hunter2');
    expect(span.attributes['url.path']).toBe(`/download?key=${AWS_EXAMPLE_KEY}&name=report`);
    expect(span.attributes['db.statement.params']).toEqual([AWS_EXAMPLE_KEY, 'ok']);
    expect(span.name).toBe(`GET /download?key=${AWS_EXAMPLE_KEY}`);
  });

  it('delegates shutdown and forceFlush to the wrapped exporter', async () => {
    const memory = new InMemorySpanExporter();
    const exporter = new RedactingSpanExporter(memory);
    await expect(exporter.forceFlush()).resolves.toBeUndefined();
    await expect(exporter.shutdown()).resolves.toBeUndefined();
  });

  it('resolves forceFlush when the wrapped exporter has none', async () => {
    const calls: { shutdown: number } = { shutdown: 0 };
    // A minimal delegate without a forceFlush method exercises the fallback branch. The param types
    // are derived from the interface so the test need not name ExportResult (a transitive-only type).
    const bare: SpanExporter = {
      // A method with no params still satisfies the interface; never invoked by this test.
      export(): void {},
      shutdown(): Promise<void> {
        calls.shutdown += 1;
        return Promise.resolve();
      },
    };
    const exporter = new RedactingSpanExporter(bare);
    await expect(exporter.forceFlush()).resolves.toBeUndefined();
    await exporter.shutdown();
    expect(calls.shutdown).toBe(1);
  });
});

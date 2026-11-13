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

// Mimic the OTLP transformer's critical access pattern: it calls span.spanContext() (a PROTOTYPE
// method on the real span) and then reads the readable fields. A redacted span that dropped that
// prototype method (as a plain-object spread would) makes this throw - exactly the failure that
// silently drops every span in the BatchSpanProcessor.
function simulateOtlpTransform(span: ReadableSpan): {
  traceId: string;
  spanId: string;
  name: string;
} {
  const ctx = span.spanContext();
  // Touch the other fields the transformer reads so the redacted view must honor the full contract.
  void span.kind;
  void span.attributes;
  void span.events;
  void span.links;
  void span.startTime;
  void span.endTime;
  void span.status;
  void span.droppedAttributesCount;
  return { traceId: ctx.traceId, spanId: ctx.spanId, name: span.name };
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

  it('keeps the spanContext() prototype method so the OTLP transform survives', () => {
    const memory = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(new RedactingSpanExporter(memory))],
    });
    providers.push(provider);

    const span = provider.getTracer('span-redaction-ctx').startSpan('op');
    // Capture the real context before end; the redacted view must return this exact context.
    const originalCtx = span.spanContext();
    span.end();

    const redacted = memory.getFinishedSpans();
    expect(redacted).toHaveLength(1);
    // A plain-object spread drops `spanContext` (a prototype method, not an own field), so this
    // assertion fails on a spread-regression before calling it even throws.
    expect(typeof redacted[0].spanContext).toBe('function');
    expect(redacted[0].spanContext()).toEqual(originalCtx);
    expect(redacted[0].spanContext().traceId).toBe(originalCtx.traceId);
    expect(redacted[0].spanContext().spanId).toBe(originalCtx.spanId);

    // Drive the transformer-shaped access path end to end; a spread clone throws here.
    const transformed = simulateOtlpTransform(redacted[0]);
    expect(transformed.traceId).toBe(originalCtx.traceId);
    expect(transformed.spanId).toBe(originalCtx.spanId);
    expect(transformed.name).toBe('op');
  });

  it('redacts event attributes and link attributes on the export path', () => {
    const memory = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(new RedactingSpanExporter(memory))],
    });
    providers.push(provider);
    const tracer = provider.getTracer('span-redaction-events');

    // A separate span to link to; the LINK carries a secret-family attribute.
    const upstream = tracer.startSpan('upstream');
    const span = tracer.startSpan('op', {
      links: [{ context: upstream.spanContext(), attributes: { 'db.user.password': 'hunter2' } }],
    });
    // An EVENT whose attributes carry both a secret-family KEY (redacted wholesale) and a benign
    // key whose VALUE embeds a pattern secret (scrubbed in place). This is the recordException /
    // addEvent('auth', ...) leak path that bypasses span.attributes entirely.
    span.addEvent('auth-check', {
      authorization: 'Bearer sk-live-abcdefgh12345678',
      'url.path': `/download?key=${AWS_EXAMPLE_KEY}&name=report`,
    });
    span.end();
    upstream.end();

    const redacted = memory.getFinishedSpans().find((s) => s.name === 'op');
    expect(redacted, 'the op span was not exported').toBeDefined();

    const event = redacted?.events[0];
    expect(event?.name).toBe('auth-check');
    // Secret-family KEY -> value redacted wholesale.
    expect(event?.attributes?.['authorization']).toBe('[REDACTED]');
    // Pattern secret inside a benign VALUE -> only the secret run is replaced.
    expect(event?.attributes?.['url.path']).toBe('/download?key=[REDACTED]&name=report');
    // The known cleartext secrets must be wholly ABSENT from the exported event, and the marker
    // present - a byte-level guard against a regression that forwards event attributes raw.
    const eventJson = JSON.stringify(event?.attributes);
    expect(eventJson).not.toContain(AWS_EXAMPLE_KEY);
    expect(eventJson).not.toContain('sk-live-abcdefgh12345678');
    expect(eventJson).toContain('[REDACTED]');

    // LINK attributes are redacted too; the link's SpanContext is left intact.
    const link = redacted?.links[0];
    expect(link?.attributes?.['db.user.password']).toBe('[REDACTED]');
    expect(link?.context.traceId).toBe(upstream.spanContext().traceId);
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

// Secret redaction for the OTLP span-export path, mirroring the JSON log sink (../logging/redact).
// The pino sink already scrubs log payloads, but exported SPAN attributes (e.g. `url.path`, a
// header stamped onto a span, or the span name itself) bypass that sink entirely and would reach
// the collector in cleartext. This decorator closes that gap: it wraps the real SpanExporter and,
// on the export call (after span end, before the bytes leave the process), rewrites each span's
// attributes with the SAME rules the log sink uses - a secret-family attribute KEY is redacted
// wholesale (isSecretKey) and every string value is scrubbed for secret patterns (scrubText). The
// patterns live in one place (../logging/redact); this file never re-declares them.
import type { Attributes } from '@opentelemetry/api';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

import { isSecretKey, REDACTED, scrubText } from '../logging/redact.js';

// The second argument of SpanExporter.export is a result callback; derive its type from the
// interface so we neither re-declare ExportResult nor import it from a transitive-only package.
type ExportResultCallback = Parameters<SpanExporter['export']>[1];

/**
 * Scrub a single attribute value: strings (and string elements of an array) are pattern-scrubbed;
 * numbers, booleans, and their arrays are returned unchanged (they carry no key to match on). The
 * OTel `AttributeValue` type is `unknown` in this API version, so the value is typed as `unknown`.
 */
function scrubAttributeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return scrubText(value);
  }
  if (Array.isArray(value)) {
    // A homogeneous array per the OTel spec; only string elements can hold a pattern secret.
    return (value as unknown[]).map((element) =>
      typeof element === 'string' ? scrubText(element) : element,
    );
  }
  return value;
}

/**
 * Rewrite an attribute bag: a secret-family KEY redacts its value wholesale, otherwise the value is
 * pattern-scrubbed. Returns a fresh object so the source span's attributes are left untouched.
 */
function redactAttributes(attributes: Attributes): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    out[key] = isSecretKey(key) ? REDACTED : scrubAttributeValue(value);
  }
  return out;
}

/**
 * Return a shallow clone of the span with redacted attributes and a pattern-scrubbed name. The
 * clone is a plain object spread of the ReadableSpan; `spanContext` is an own arrow-function field
 * on the span (not a prototype method), so the spread carries it and downstream exporters keep
 * working. The original span is never mutated.
 */
function redactSpan(span: ReadableSpan): ReadableSpan {
  return {
    ...span,
    name: scrubText(span.name),
    attributes: redactAttributes(span.attributes),
  };
}

/**
 * A SpanExporter decorator that redacts secrets from span attributes (and the span name) before
 * handing the spans to the wrapped exporter. Wrap any real exporter -
 * `new RedactingSpanExporter(new OTLPTraceExporter(...))` - so redaction happens at the export
 * boundary, independent of span-processor ordering. shutdown/forceFlush delegate unchanged.
 */
export class RedactingSpanExporter implements SpanExporter {
  constructor(private readonly delegate: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: ExportResultCallback): void {
    this.delegate.export(spans.map(redactSpan), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush?.() ?? Promise.resolve();
  }
}

// Structured JSON logging (platform.yaml logging: json, leveled, one line per event) via
// pino, with secret redaction matching the other verticals and per-line trace correlation.
//
// Redaction covers every logged field: a secret-family key is redacted wholesale, string
// values are scrubbed for secret patterns, and the message string is scrubbed too. Nested
// objects are descended into (unlike pino's path-based `redact`, which only matches declared
// paths).
import { trace } from '@opentelemetry/api';
import pino, { type DestinationStream, type Logger } from 'pino';

import { redactValue, scrubText } from './redact.js';

const LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);

function normalizeLevel(level: string): string {
  const l = level.trim().toLowerCase();
  if (l === 'warning') {
    return 'warn';
  }
  return LEVELS.has(l) ? l : 'info';
}

/**
 * The trace-correlation mixin: stamps trace_id/span_id onto every record emitted inside an
 * active span, so a log line can be joined to its trace. A no-op outside a span.
 */
function correlationMixin(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (!span) {
    return {};
  }
  const ctx = span.spanContext();
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

/**
 * Build the redacting JSON logger used by this vertical: structured JSON at the given level,
 * with the cross-vertical schema (timestamp/level/message), secret redaction, and trace
 * correlation. Unknown levels fall back to info. An optional destination stream is accepted
 * so tests can capture output; production omits it (pino writes to stdout).
 */
export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level: normalizeLevel(level),
      messageKey: 'message',
      // ISO timestamp under the cross-vertical key name.
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
      formatters: {
        // Emit the string level label (already lowercase) rather than pino's numeric default.
        level: (label) => ({ level: label }),
        // Redact every merged field (nested objects/arrays included), but never the
        // correlation ids: a trace/span id is safe hex, and the value scrubber would otherwise
        // mangle a digit-heavy id (e.g. an all-zero invalid id is Luhn-valid -> [REDACTED]).
        log: (obj) => {
          const { trace_id, span_id, ...rest } = obj;
          const redacted = redactValue(rest) as Record<string, unknown>;
          if (trace_id !== undefined) {
            redacted.trace_id = trace_id;
          }
          if (span_id !== undefined) {
            redacted.span_id = span_id;
          }
          return redacted;
        },
      },
      mixin: correlationMixin,
      hooks: {
        // Scrub secret patterns out of the message string (and any string positional args).
        logMethod(args, method) {
          const scrubbed = args.map((arg) => (typeof arg === 'string' ? scrubText(arg) : arg));
          method.apply(this, scrubbed as Parameters<typeof method>);
        },
      },
    },
    destination as DestinationStream,
  );
}

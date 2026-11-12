// Structured JSON logging (platform.yaml logging: json, leveled, one line per event) via
// pino, with secret redaction matching the other verticals and per-line trace correlation.
//
// Redaction covers every logged field: a secret-family key is redacted wholesale, string
// values are scrubbed for secret patterns, and the message string is scrubbed too. Nested
// objects are descended into (unlike pino's path-based `redact`, which only matches declared
// paths).
import { format } from 'node:util';

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

// Valid OpenTelemetry id shapes (32 / 16 lowercase hex). Only a value with the id shape is
// exempt from scrubbing; anything else under these keys is scrubbed like any other value.
const TRACE_ID_SHAPE = /^[0-9a-f]{32}$/;
const SPAN_ID_SHAPE = /^[0-9a-f]{16}$/;

function preserveIfId(value: unknown, shape: RegExp): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string' && shape.test(value)) {
    return value;
  }
  return redactValue(value);
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
        // Redact every merged field (nested objects/arrays included), but preserve a correlation
        // id that actually has the id shape: a valid trace/span id is safe hex, and the value
        // scrubber would otherwise mangle a digit-heavy id (an all-zero id is Luhn-valid ->
        // [REDACTED]). A value under these keys that is NOT an id (a mis-copied secret, app code
        // reusing the key) is still scrubbed, so the exemption cannot leak a secret.
        log: (obj) => {
          const { trace_id, span_id, ...rest } = obj;
          const redacted = redactValue(rest) as Record<string, unknown>;
          redacted.trace_id = preserveIfId(trace_id, TRACE_ID_SHAPE);
          redacted.span_id = preserveIfId(span_id, SPAN_ID_SHAPE);
          if (redacted.trace_id === undefined) {
            delete redacted.trace_id;
          }
          if (redacted.span_id === undefined) {
            delete redacted.span_id;
          }
          return redacted;
        },
      },
      mixin: correlationMixin,
      hooks: {
        // Scrub secret patterns out of the message. pino interpolates `logger.info(fmt, ...args)`
        // when it serializes, so scrubbing each arg in isolation misses a token split across the
        // format string and its arg (`info('authorization: Bearer %s', token)` - neither piece
        // matches the bearer pattern alone). So when interpolation args are present, pre-format the
        // final message here and scrub that, dropping the args so the token cannot survive in clear.
        logMethod(args, method) {
          // pino's call shapes: (msg, ...interp) or (mergeObj, msg, ...interp).
          const msgIdx = typeof args[0] === 'object' && args[0] !== null ? 1 : 0;
          const msg = args[msgIdx];
          if (typeof msg === 'string' && args.length > msgIdx + 1) {
            // Key-redact every object interpolation arg (`%o`/`%j`) BEFORE formatting, so a
            // `password`/`token` field becomes [REDACTED] just like a merge field; without it
            // util.format would serialise `{ password: 'x' }` verbatim and scrubText (patterns
            // only) would miss it. redactValue is shape-aware (see redact.ts): it key-redacts
            // plain objects, arrays, class instances, Maps and Sets, while preserving an Error's
            // message/stack and a Date's value - so this is safe to apply to any object without
            // either flattening diagnostics to `{}` or leaking a secret-family field.
            const redactedArgs = args
              .slice(msgIdx + 1)
              .map((arg) =>
                arg !== null && (typeof arg === 'object' || typeof arg === 'function')
                  ? redactValue(arg)
                  : arg,
              );
            const message = scrubText(format(msg, ...redactedArgs));
            const next = msgIdx === 1 ? [args[0], message] : [message];
            method.apply(this, next as Parameters<typeof method>);
            return;
          }
          // No interpolation args. Scrub string positionals, and redact an Error or function
          // positional BEFORE pino sees it: pino lifts a bare Error's `.message` to the top-level
          // message key (bypassing both this scrub and the merge-field redactValue in formatters.log),
          // and a function's own props would otherwise print raw. A plain merge object is left for
          // formatters.log, which redacts it AND preserves a valid trace/span id.
          const scrubbed = args.map((arg) => {
            if (typeof arg === 'string') {
              return scrubText(arg);
            }
            if (arg instanceof Error || typeof arg === 'function') {
              return redactValue(arg);
            }
            return arg;
          });
          method.apply(this, scrubbed as Parameters<typeof method>);
        },
      },
    },
    destination as DestinationStream,
  );
}

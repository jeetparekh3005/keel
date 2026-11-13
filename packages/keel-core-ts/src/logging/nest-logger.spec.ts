import type { DestinationStream } from 'pino';
import { describe, expect, it } from 'vitest';

import { createLogger } from './logger.js';
import { createNestLogger, NestLoggerAdapter } from './nest-logger.js';

function capture(): { records: () => Record<string, unknown>[]; stream: DestinationStream } {
  const chunks: string[] = [];
  return {
    records: () =>
      chunks
        .join('')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    stream: { write: (chunk: string) => chunks.push(chunk) },
  };
}

describe('NestLoggerAdapter', () => {
  it('emits a Nest log call as redacted JSON through the pino sink', () => {
    // The key behaviour: Nest's framework/bootstrap logs flow through the same JSON logger and
    // secret redaction as app code, not the default colorized ConsoleLogger. A secret in a
    // bootstrap line must never survive in clear.
    const cap = capture();
    const logger = createNestLogger('info', cap.stream);
    logger.log('connecting with Authorization: Bearer abcdef0123456789secrettoken');
    const [record] = cap.records();
    expect(record.level).toBe('info');
    expect(String(record.message)).not.toContain('abcdef0123456789secrettoken');
    expect(String(record.message)).toContain('[REDACTED]');
  });

  it("carries Nest's context argument as a redacted merge field", () => {
    const cap = capture();
    const logger = createNestLogger('info', cap.stream);
    logger.log('Nest application successfully started', 'NestApplication');
    const [record] = cap.records();
    expect(record.message).toBe('Nest application successfully started');
    expect(record.context).toBe('NestApplication');
  });

  it('maps each Nest level onto the matching pino level', () => {
    const cap = capture();
    const logger = createNestLogger('trace', cap.stream);
    logger.log('a');
    logger.error('b');
    logger.warn('c');
    logger.debug('d');
    logger.verbose('e');
    logger.fatal('f');
    const levels = cap.records().map((r) => r.level);
    expect(levels).toEqual(['info', 'error', 'warn', 'debug', 'trace', 'fatal']);
  });

  it('redacts a secret in an error stack passed alongside the context', () => {
    const cap = capture();
    const logger = createNestLogger('info', cap.stream);
    logger.error('startup failed', 'Bearer abcdef0123456789secrettoken', 'NestApplication');
    const [record] = cap.records();
    expect(record.context).toBe('NestApplication');
    expect(JSON.stringify(record)).not.toContain('abcdef0123456789secrettoken');
    expect(JSON.stringify(record)).toContain('[REDACTED]');
  });

  it('logs a non-string (object) message as a redacted merge field', () => {
    const cap = capture();
    // Exercise the class directly over a captured pino logger (the factory is a thin wrapper).
    const logger = new NestLoggerAdapter(createLogger('info', cap.stream));
    logger.log({ password: 'plaintextpw', service: 'items' });
    const serialized = JSON.stringify(cap.records()[0]);
    expect(serialized).not.toContain('plaintextpw');
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).toContain('items');
  });
});

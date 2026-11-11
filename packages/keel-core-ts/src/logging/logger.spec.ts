import type { DestinationStream } from 'pino';
import { describe, expect, it } from 'vitest';

import { createLogger } from './logger.js';

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

describe('createLogger redaction', () => {
  it('scrubs a bearer token split across the format string and its interpolation arg', () => {
    // pino interpolates when it serializes, so scrubbing each arg alone misses this: neither
    // "authorization: Bearer %s" nor the bare token matches the bearer pattern on its own.
    const cap = capture();
    const logger = createLogger('info', cap.stream);
    logger.info('authorization: Bearer %s', 'abcdef0123456789secrettoken');
    const [record] = cap.records();
    expect(String(record.message)).not.toContain('abcdef0123456789secrettoken');
    expect(String(record.message)).toContain('[REDACTED]');
  });

  it('still scrubs a self-contained secret passed as a bare interpolation arg', () => {
    const cap = capture();
    const logger = createLogger('info', cap.stream);
    logger.info('header=%s', 'Bearer abcdef0123456789secrettoken');
    expect(String(cap.records()[0].message)).toContain('[REDACTED]');
  });

  it('scrubs a plain message with no interpolation args', () => {
    const cap = capture();
    const logger = createLogger('info', cap.stream);
    logger.info('Authorization: Bearer abcdef0123456789secrettoken');
    expect(String(cap.records()[0].message)).toContain('[REDACTED]');
  });
});

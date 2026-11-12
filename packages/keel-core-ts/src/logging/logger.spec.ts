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

  it('preserves an Error interpolation arg (%o) - message and stack survive redaction', () => {
    // Regression: a naive Object.entries rebuild is empty for an Error (message/stack are
    // non-enumerable), which flattened an Error arg to {} and lost the diagnostics of the
    // ubiquitous logger.error('... %o', err). The Error branch now rebuilds a scrubbed Error that
    // keeps message/stack, so these survive.
    const cap = capture();
    const logger = createLogger('info', cap.stream);
    logger.error('operation failed %o', new Error('db connection refused'));
    const message = String(cap.records()[0].message);
    expect(message).toContain('db connection refused');
    expect(message).toContain('Error');
    expect(message).not.toBe('operation failed {}');
  });

  it('key-redacts secret-family fields on a CLASS INSTANCE interpolation arg (not just plain objects)', () => {
    // Regression: gating redaction on "plain object only" let a class instance (e.g. a config
    // DTO, an AxiosError/DB error carrying credential props) pass through to util.format with its
    // secret-family fields in cleartext, because scrubText matches only patterns, not keys.
    class ServiceConfig {
      password = 'plaintextinstancepw';
      apiKey = 'plaintextinstancekey';
      host = 'db.internal';
    }
    const cap = capture();
    const logger = createLogger('info', cap.stream);
    logger.error('config %o', new ServiceConfig());
    const message = String(cap.records()[0].message);
    expect(message).not.toContain('plaintextinstancepw');
    expect(message).not.toContain('plaintextinstancekey');
    expect(message).toContain('[REDACTED]');
    expect(message).toContain('db.internal'); // non-secret field preserved
  });

  it('key-redacts secret-family entries inside a Map / Set interpolation arg', () => {
    const cap = capture();
    const logger = createLogger('info', cap.stream);
    logger.info('m %o', new Map([['password', 'plaintextmapsecret']]));
    logger.info('s %o', new Set(['Bearer abcdef0123456789secrettoken']));
    const out = cap
      .records()
      .map((r) => String(r.message))
      .join('\n');
    expect(out).not.toContain('plaintextmapsecret');
    expect(out).not.toContain('abcdef0123456789secrettoken');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts an error own-property secret while keeping its message/stack', () => {
    // An AxiosError-shaped error: diagnostics on the prototype/non-enumerable fields must survive,
    // but an enumerable own-prop carrying a secret-family value must be redacted.
    const cap = capture();
    const logger = createLogger('info', cap.stream);
    const err = Object.assign(new Error('request failed'), {
      config: { apiKey: 'plaintexterrorkey' },
    });
    logger.error('http %o', err);
    const message = String(cap.records()[0].message);
    expect(message).toContain('request failed');
    expect(message).not.toContain('plaintexterrorkey');
    expect(message).toContain('[REDACTED]');
  });

  it('scrubs a pattern secret in an ERROR logged as a MERGE field (no final scrubText on that path)', () => {
    // Regression: the merge-object path `logger.x({ err }, msg)` runs only redactValue, never a
    // final scrubText, so a bearer/JWT/AWS/PEM secret in the error message or stack must be
    // scrubbed inside redactValue's Error branch or it leaks in cleartext on the idiomatic pino
    // error-logging call. (A bearer token stands in for the pattern family; a literal JWT here
    // would trip the repo's own secret scanner.)
    const cap = capture();
    const logger = createLogger('info', cap.stream);
    const token = 'abcdef0123456789secrettoken';
    logger.error({ err: new Error(`auth failed with Bearer ${token}`) }, 'request failed');
    const line = cap
      .records()
      .map((r) => JSON.stringify(r))
      .join('\n');
    expect(line).not.toContain(token);
    expect(line).toContain('[REDACTED]');
    expect(line).toContain('auth failed with'); // non-secret diagnostic preserved
  });

  it('redacts a secret-family field on an error logged as a merge field, keeping the message', () => {
    const cap = capture();
    const logger = createLogger('info', cap.stream);
    const err = Object.assign(new Error('db write failed'), { apiKey: 'plaintextmergekey' });
    logger.error({ err }, 'op failed');
    const line = cap
      .records()
      .map((r) => JSON.stringify(r))
      .join('\n');
    expect(line).toContain('db write failed');
    expect(line).not.toContain('plaintextmergekey');
    expect(line).toContain('[REDACTED]');
  });

  it('does not crash when an interpolation arg has an own-enumerable getter that throws', () => {
    const cap = capture();
    const logger = createLogger('info', cap.stream);
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'detail', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(() => logger.info('ctx %o', hostile)).not.toThrow();
    expect(String(cap.records()[0].message)).toContain('[unreadable]');
  });

  it('scrubs a bare ERROR positional - pino lifts its message to the top-level message key', () => {
    // logger.error(err) with no string message: pino copies err.message into the top-level message
    // key. That derived message bypasses the merge-field redactValue, so a pattern secret in the
    // error message must be scrubbed before pino sees the Error, or it leaks at message.
    const cap = capture();
    const logger = createLogger('info', cap.stream);
    const token = 'abcdef0123456789secrettoken';
    const err = Object.assign(new Error(`boom Bearer ${token}`), {
      authorization: 'plaintextbarekey',
    });
    logger.error(err);
    const line = cap
      .records()
      .map((r) => JSON.stringify(r))
      .join('\n');
    expect(line).not.toContain(token);
    expect(line).not.toContain('plaintextbarekey');
    expect(line).toContain('[REDACTED]');
  });

  it('redacts a secret-family property attached to a FUNCTION interpolation arg', () => {
    // redactValue short-circuits on non-objects; a function (typeof 'function') carrying a secret
    // own-prop would otherwise be printed verbatim by util.format %o.
    const cap = capture();
    const logger = createLogger('info', cap.stream);
    const fn = function handler(): void {};
    (fn as unknown as Record<string, unknown>).password = 'plaintextfnsecret';
    logger.info('handler %o', fn);
    const message = String(cap.records()[0].message);
    expect(message).not.toContain('plaintextfnsecret');
  });

  it('does not crash when a Proxy with a throwing ownKeys trap is logged (merge and interp)', () => {
    const cap = capture();
    const logger = createLogger('info', cap.stream);
    const hostile = (): unknown =>
      new Proxy(
        { password: 'plaintextproxysecret' },
        {
          ownKeys() {
            throw new Error('trap');
          },
        },
      );
    expect(() => logger.info({ data: hostile() }, 'merge')).not.toThrow();
    expect(() => logger.info('interp %o', hostile())).not.toThrow();
    const out = cap
      .records()
      .map((r) => JSON.stringify(r))
      .join('\n');
    expect(out).not.toContain('plaintextproxysecret');
  });

  it('key-redacts secret-family fields inside an object interpolation arg (%o / %j)', () => {
    // util.format serialises the object verbatim, so pattern-only scrubbing would miss a secret
    // under a secret-family KEY. The interpolation path must apply the same key-based redaction
    // as a merge field (a value whose key is password/token/apiKey -> [REDACTED]).
    const cap = capture();
    const logger = createLogger('info', cap.stream);
    logger.info('ctx %o', { password: 'plaintextvalueone', ok: 1 });
    logger.info('ctx %j', {
      apiKey: 'plaintextvaluetwo',
      nested: { token: 'plaintextvaluethree' },
    });
    const out = cap
      .records()
      .map((r) => String(r.message))
      .join('\n');
    expect(out).not.toContain('plaintextvalueone');
    expect(out).not.toContain('plaintextvaluetwo');
    expect(out).not.toContain('plaintextvaluethree');
    expect(out).toContain('[REDACTED]');
  });
});

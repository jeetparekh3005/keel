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

  it('redacts a secret-family property attached to a RegExp (no toJSON passthrough leak)', () => {
    // A RegExp has no toJSON, so pino serializes its own-enumerable props verbatim. A secret
    // attached to a RegExp must be redacted, while the pattern itself is still shown.
    const cap = capture();
    const logger = createLogger('info', cap.stream);
    const re = /ab+c/i;
    (re as unknown as Record<string, unknown>).password = 'plaintextregexsecret';
    logger.info({ field: re }, 'merge');
    logger.info('interp %o', re);
    const out = cap
      .records()
      .map((r) => JSON.stringify(r))
      .join('\n');
    expect(out).not.toContain('plaintextregexsecret');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('/ab+c/i'); // the pattern is preserved
  });

  it('does not crash when a BigInt is logged via %j or as a merge field', () => {
    // JSON.stringify throws on a BigInt; the %j interpolation path and the merge path must not let
    // that escape the logging call.
    const cap = capture();
    const logger = createLogger('info', cap.stream);
    expect(() => logger.info('ctx %j', { amount: 10n })).not.toThrow();
    expect(() => logger.info('bare %j', 9007199254740993n)).not.toThrow();
    expect(() => logger.info({ balance: 42n }, 'merge')).not.toThrow();
    const out = cap
      .records()
      .map((r) => JSON.stringify(r))
      .join('\n');
    expect(out).toContain('10');
    expect(out).toContain('42');
  });

  it('redacts a secret inside an OBJECT Map KEY (not just the value)', () => {
    // util.format('%o', map) renders Map keys verbatim; an object key carrying a secret-family
    // field must be redacted too, or it leaks even though the value side is handled.
    const cap = capture();
    const logger = createLogger('info', cap.stream);
    logger.info('m %o', new Map([[{ password: 'plaintextkeysecret' }, 'v']]));
    const message = String(cap.records()[0].message);
    expect(message).not.toContain('plaintextkeysecret');
    expect(message).toContain('[REDACTED]');
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
    const hostile = (): object =>
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

  it('does not crash when a MERGE object has an own-enumerable getter that throws', () => {
    // pino's internal mixin-merge (Object.assign) reads the merge object's getters before any
    // formatter runs, so a throwing getter there crashed the call unless the merge object is
    // redacted first in the logMethod hook.
    const cap = capture();
    const logger = createLogger('info', cap.stream);
    const hostile: Record<string, unknown> = { password: 'plaintextmergegetter' };
    Object.defineProperty(hostile, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter fail');
      },
    });
    expect(() => logger.info(hostile, 'thrown getter on merge')).not.toThrow();
    const line = cap
      .records()
      .map((r) => JSON.stringify(r))
      .join('\n');
    expect(line).toContain('thrown getter on merge'); // the line was emitted
    expect(line).not.toContain('plaintextmergegetter');
  });

  it('does not overflow the stack on a pathologically deep nested object', () => {
    const cap = capture();
    const logger = createLogger('info', cap.stream);
    let deep: Record<string, unknown> = { password: 'plaintextdeepsecret' };
    for (let i = 0; i < 5000; i++) {
      deep = { child: deep };
    }
    expect(() => logger.info({ root: deep }, 'very deep')).not.toThrow();
    const line = cap
      .records()
      .map((r) => JSON.stringify(r))
      .join('\n');
    expect(line).toContain('truncated: max depth');
    expect(line).not.toContain('plaintextdeepsecret');
  });

  it('serializes an Error under a NON-err merge key with its message and stack (issue #424)', () => {
    // Regression: `logger.info({ field: err }, 'msg')` rebuilt a real Error whose message/stack are
    // non-enumerable, so pino (which only runs its error serializer on the `err` key) JSON-serialized
    // it to `{}` under any other key and the diagnostics vanished. redactValue now projects an Error
    // under a non-err key to a plain object with ENUMERABLE, already-scrubbed name/message/stack.
    const cap = capture();
    const logger = createLogger('info', cap.stream);
    const token = 'abcdef0123456789secrettoken';
    const err = new Error(`load failed with Bearer ${token}`);
    logger.info({ cause: err }, 'startup');
    const [record] = cap.records();
    const field = record.cause as Record<string, unknown>;
    expect(field).toBeTypeOf('object');
    // Not the pre-fix empty object.
    expect(Object.keys(field).length).toBeGreaterThan(0);
    expect(field.name).toBe('Error');
    expect(String(field.message)).toContain('load failed with');
    expect(typeof field.stack).toBe('string');
    // The pattern secret in message AND stack is scrubbed on this path (no final scrubText).
    const line = JSON.stringify(record);
    expect(line).not.toContain(token);
    expect(String(field.message)).toContain('[REDACTED]');
  });

  it('redacts a secret-family own-prop on an Error under a non-err key, keeping diagnostics', () => {
    // The projection path must keep the Error's own-property key-redaction (and Symbol-key drop /
    // throwing-getter handling) that the rebuilt-Error path had.
    const cap = capture();
    const logger = createLogger('info', cap.stream);
    const err = Object.assign(new Error('token exchange failed'), { apiKey: 'plaintextnonerrkey' });
    logger.info({ detail: err }, 'oauth');
    const [record] = cap.records();
    const field = record.detail as Record<string, unknown>;
    expect(String(field.message)).toContain('token exchange failed');
    expect(field.apiKey).toBe('[REDACTED]');
    expect(JSON.stringify(record)).not.toContain('plaintextnonerrkey');
  });

  it('keeps the err-key Error serialization unchanged (pino error serializer, no #424 regression)', () => {
    // The fix must NOT touch the `err` key: pino's own error serializer still runs there and emits
    // its `type`/message/stack shape (a real Error reaches it), distinct from the plain projection
    // used under other keys. Guards that the key-aware branch leaves the `err` path alone.
    const cap = capture();
    const logger = createLogger('info', cap.stream);
    logger.error({ err: new Error('db connection refused') }, 'request failed');
    const [record] = cap.records();
    const err = record.err as Record<string, unknown>;
    expect(err.type).toBe('Error'); // pino error-serializer shape, not our { name, ... } projection
    expect(String(err.message)).toContain('db connection refused');
    expect(typeof err.stack).toBe('string');
  });

  it('renders a Date under a non-err merge key as its ISO timestamp', () => {
    // Date.toJSON -> ISO means pino serializes a Date under any key correctly; locks the #424 Date
    // case so a future projection change cannot flatten it.
    const cap = capture();
    const logger = createLogger('info', cap.stream);
    logger.info({ when: new Date('2020-01-02T03:04:05.000Z') }, 'event');
    const [record] = cap.records();
    expect(record.when).toBe('2020-01-02T03:04:05.000Z');
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

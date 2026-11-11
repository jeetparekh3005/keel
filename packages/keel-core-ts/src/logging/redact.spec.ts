import { describe, expect, it } from 'vitest';

import { isSecretKey, redactValue, REDACTED, scrubText } from './redact.js';

describe('secret-key detection', () => {
  it('matches secret families case- and separator-insensitively', () => {
    for (const key of [
      'password',
      'API_KEY',
      'x-api-key',
      'Authorization',
      'client_secret',
      'access_token',
      'Cookie',
    ]) {
      expect(isSecretKey(key)).toBe(true);
    }
    for (const key of ['name', 'id', 'limit', 'offset']) {
      expect(isSecretKey(key)).toBe(false);
    }
  });
});

describe('value scrubbing', () => {
  it('scrubs JWTs, AWS keys, bearer tokens, and PEM private keys', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlX2hlcmU';
    expect(scrubText(`token=${jwt}`)).toBe(`token=${REDACTED}`);
    expect(scrubText('key AKIAIOSFODNN7EXAMPLE here')).toBe(`key ${REDACTED} here`);
    expect(scrubText('Authorization: Bearer abcdef0123456789')).toContain(REDACTED);
    // Parity with Go (\s+): a bearer token separated by more than one space still redacts.
    expect(scrubText('Authorization: Bearer  abcdef0123456789')).toContain(REDACTED);
    expect(scrubText('-----BEGIN RSA PRIVATE KEY-----')).toBe(REDACTED);
  });

  it('redacts Luhn-valid card numbers but leaves random digit runs alone', () => {
    expect(scrubText('card 4242 4242 4242 4242 end')).toBe(`card ${REDACTED} end`);
    expect(scrubText('order 1234567890123456 ref')).toContain('1234567890123456');
  });

  it('is not vulnerable to catastrophic backtracking on long adversarial input', () => {
    const adversarial = 'Bearer ' + 'a'.repeat(100000);
    const start = performance.now();
    scrubText(adversarial);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('recursive redaction', () => {
  it('redacts secret-family keys wholesale and scrubs nested string values', () => {
    const redacted = redactValue({
      user: 'alice',
      password: 'hunter2',
      nested: { api_key: 'abc', note: '4242 4242 4242 4242' },
      list: ['plain', 'token=eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl'],
    }) as Record<string, unknown>;

    expect(redacted.user).toBe('alice');
    expect(redacted.password).toBe(REDACTED);
    const nested = redacted.nested as Record<string, unknown>;
    expect(nested.api_key).toBe(REDACTED);
    expect(nested.note).toBe(REDACTED);
    expect((redacted.list as string[])[1]).toContain(REDACTED);
  });

  it('breaks cycles rather than looping', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    const redacted = redactValue(cyclic) as Record<string, unknown>;
    expect(redacted.self).toBe('[Circular]');
  });
});

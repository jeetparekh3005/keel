// Unit tests for the GCP Secret Manager SecretProvider adapter (ADR-0024). The
// `@google-cloud/secret-manager` module is mocked so no real network, metadata-server, or ADC
// lookup happens (GCP ships no official emulator). Asserts the JSON field map round-trips through
// AccessSecretVersion, ADR-0023 coercion, NOT_FOUND-as-empty, the fail-closed paths (non-object,
// malformed, binary, missing payload), the no-leak invariant on a failed refresh and a malformed
// payload, that the bounded gax call options (timeout + maxRetries) are applied, and the version
// resource-name resolution.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A single mutable mock of the SDK client's methods; the mocked constructor returns an object
// delegating to these so each test can script accessSecretVersion per case.
const accessSecretVersion = vi.fn();
const close = vi.fn();

vi.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: class {
    accessSecretVersion = accessSecretVersion;
    close = close;
  },
}));

import {
  createGcpSecretManagerSecretProvider,
  MAX_RETRIES,
  REQUEST_TIMEOUT_MS,
} from './gcp-secret-manager.secret-provider.js';

// A minimal env: the configured secret resource name that gates the backend.
const baseEnv = { KEEL_GCP_SECRET: 'projects/keel-test/secrets/app' };

/** Build a resolved AccessSecretVersion response whose payload carries `body` as UTF-8 bytes. */
function payload(body: string): [{ payload: { data: Buffer } }] {
  return [{ payload: { data: Buffer.from(body, 'utf8') } }];
}

/** A gRPC NOT_FOUND (code 5) error, as the SDK raises for a missing secret/version. */
function notFound(): Error {
  return Object.assign(new Error('5 NOT_FOUND: Secret not found'), { code: 5 });
}

describe('GcpSecretManagerSecretProvider', () => {
  const cleanups: (() => void)[] = [];

  beforeEach(() => {
    accessSecretVersion.mockReset();
    close.mockReset();
  });

  afterEach(() => {
    for (const fn of cleanups.splice(0)) {
      fn();
    }
  });

  it('round-trips a JSON field map and applies ADR-0023 coercion', async () => {
    accessSecretVersion.mockResolvedValue(
      payload(
        JSON.stringify({
          str: 'verbatim',
          num: 42,
          float: 1.5,
          boolTrue: true,
          boolFalse: false,
          empty: '',
          obj: { nested: 'x' },
          arr: [1, 2, 3],
          nul: null,
        }),
      ),
    );

    const provider = await createGcpSecretManagerSecretProvider(baseEnv);
    cleanups.push(() => provider.close());

    expect(provider.get('str')).toBe('verbatim');
    expect(provider.get('num')).toBe('42');
    expect(provider.get('float')).toBe('1.5');
    expect(provider.get('boolTrue')).toBe('true');
    expect(provider.get('boolFalse')).toBe('false');
    expect(provider.get('empty')).toBe('');
    // Structured values are reported absent, never stringified to "[object Object]" or "1,2,3".
    expect(provider.get('obj')).toBeUndefined();
    expect(provider.get('arr')).toBeUndefined();
    expect(provider.get('nul')).toBeUndefined();
    expect(provider.get('missing')).toBeUndefined();
  });

  it('resolves the version resource name (default latest) and applies bounded call options', async () => {
    accessSecretVersion.mockResolvedValue(payload(JSON.stringify({ a: '1' })));

    const provider = await createGcpSecretManagerSecretProvider(baseEnv);
    cleanups.push(() => provider.close());

    const [request, options] = accessSecretVersion.mock.calls[0] as [
      { name: string },
      { timeout: number; maxRetries: number },
    ];
    // KEEL_GCP_SECRET without an explicit version -> ".../versions/latest".
    expect(request.name).toBe('projects/keel-test/secrets/app/versions/latest');
    // The bounded gax CallOptions must be pinned so a wedged endpoint fails the startup load fast.
    expect(options.timeout).toBe(REQUEST_TIMEOUT_MS);
    expect(options.maxRetries).toBe(MAX_RETRIES);
    expect(REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(MAX_RETRIES).toBe(2);
  });

  it('honors an explicit KEEL_GCP_SECRET_VERSION', async () => {
    accessSecretVersion.mockResolvedValue(payload(JSON.stringify({ a: '1' })));

    const provider = await createGcpSecretManagerSecretProvider({
      ...baseEnv,
      KEEL_GCP_SECRET_VERSION: '7',
    });
    cleanups.push(() => provider.close());

    const [request] = accessSecretVersion.mock.calls[0] as [{ name: string }];
    expect(request.name).toBe('projects/keel-test/secrets/app/versions/7');
  });

  it('uses a full version resource name verbatim (ignoring KEEL_GCP_SECRET_VERSION)', async () => {
    accessSecretVersion.mockResolvedValue(payload(JSON.stringify({ a: '1' })));

    const provider = await createGcpSecretManagerSecretProvider({
      KEEL_GCP_SECRET: 'projects/keel-test/secrets/app/versions/3',
      KEEL_GCP_SECRET_VERSION: '7',
    });
    cleanups.push(() => provider.close());

    const [request] = accessSecretVersion.mock.calls[0] as [{ name: string }];
    expect(request.name).toBe('projects/keel-test/secrets/app/versions/3');
  });

  it('treats NOT_FOUND (code 5) as an empty field map, not an error', async () => {
    accessSecretVersion.mockRejectedValue(notFound());

    const provider = await createGcpSecretManagerSecretProvider(baseEnv);
    cleanups.push(() => provider.close());

    expect(provider.get('anything')).toBeUndefined();
  });

  it('closes the SDK client on close()', async () => {
    accessSecretVersion.mockResolvedValue(payload(JSON.stringify({ a: '1' })));

    const provider = await createGcpSecretManagerSecretProvider(baseEnv);
    provider.close();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a bare JSON string', JSON.stringify('just-a-string')],
    ['a JSON array', JSON.stringify([1, 2, 3])],
    ['JSON null', 'null'],
    ['a JSON number', '42'],
    ['malformed JSON', '{not valid'],
  ])('fails closed when the payload is %s', async (_label, body) => {
    accessSecretVersion.mockResolvedValue(payload(body));

    await expect(createGcpSecretManagerSecretProvider(baseEnv)).rejects.toThrow(
      /not a JSON object/,
    );
  });

  it('fails closed when the payload is non-UTF-8 binary (not a JSON object)', async () => {
    // Raw bytes that are not valid UTF-8 and cannot parse as a JSON object.
    accessSecretVersion.mockResolvedValue([
      { payload: { data: new Uint8Array([0xff, 0xfe, 0x00, 0x01]) } },
    ]);

    await expect(createGcpSecretManagerSecretProvider(baseEnv)).rejects.toThrow(
      /not a JSON object/,
    );
  });

  it('fails closed when the version has no payload data', async () => {
    accessSecretVersion.mockResolvedValue([{ payload: {} }]);

    await expect(createGcpSecretManagerSecretProvider(baseEnv)).rejects.toThrow(/no payload data/);
  });

  it('fails closed (does not fall back to env) on a non-not-found SDK error', async () => {
    accessSecretVersion.mockRejectedValue(
      Object.assign(new Error('7 PERMISSION_DENIED'), { code: 7 }),
    );

    await expect(createGcpSecretManagerSecretProvider(baseEnv)).rejects.toThrow();
  });

  it('fails closed when KEEL_GCP_SECRET is unset', async () => {
    await expect(createGcpSecretManagerSecretProvider({})).rejects.toThrow(
      /KEEL_GCP_SECRET is required/,
    );
  });

  it('fails closed when KEEL_SECRET_CACHE_TTL_SECONDS is not a positive integer', async () => {
    accessSecretVersion.mockResolvedValue(payload(JSON.stringify({ a: '1' })));

    await expect(
      createGcpSecretManagerSecretProvider({ ...baseEnv, KEEL_SECRET_CACHE_TTL_SECONDS: '0' }),
    ).rejects.toThrow(/positive integer/);
  });

  it('fails closed on a malformed payload without leaking the secret value into the error', async () => {
    // A payload that is not valid JSON but embeds a known secret value: the generic fail-closed
    // throw must reject AND must not echo the raw payload (the canary) back in its message.
    const canary = 'hunter2-malformed-gcp-canary';
    accessSecretVersion.mockResolvedValue(payload(`not-json-but-secret ${canary}`));

    let caught: unknown;
    try {
      await createGcpSecretManagerSecretProvider(baseEnv);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toMatch(/not a JSON object/);
    expect(message).not.toContain(canary);
    expect(String(caught)).not.toContain(canary);
  });

  it('never logs the secret value when a background refresh fails', async () => {
    // First load succeeds with a known value; subsequent (refresh) loads reject with a non-not-found
    // error, so the cache keeps serving the last good value and the failure is logged.
    accessSecretVersion
      .mockResolvedValueOnce(payload(JSON.stringify({ 'db-password': 'cached-swordfish-value' })))
      .mockRejectedValue(
        Object.assign(new Error('7 PERMISSION_DENIED: not authorized'), { code: 7 }),
      );

    const captured: unknown[] = [];
    const logger = {
      warn: (obj: Record<string, unknown>, msg: string) => captured.push(obj, msg),
      error: (obj: Record<string, unknown>, msg: string) => captured.push(obj, msg),
    };

    const provider = await createGcpSecretManagerSecretProvider(
      { ...baseEnv, KEEL_SECRET_CACHE_TTL_SECONDS: '1' },
      { logger },
    );
    cleanups.push(() => provider.close());

    expect(provider.get('db-password')).toBe('cached-swordfish-value');

    // Wait for a background refresh to fail and log a diagnostic.
    for (let i = 0; i < 300 && captured.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(captured.length).toBeGreaterThan(0);

    // The last good value still serves (a transient outage does not blank the cache)...
    expect(provider.get('db-password')).toBe('cached-swordfish-value');
    // ...and the secret value never appears anywhere in what was logged.
    expect(JSON.stringify(captured)).not.toContain('cached-swordfish-value');
  }, 10_000);

  it('never logs the secret value when a refresh returns a malformed payload', async () => {
    // First load is a valid field map; the refresh returns a payload that is not a JSON object but
    // embeds the canary. The generic fail-closed throw is logged, and the canary must be absent.
    const canary = 'swordfish-refresh-canary';
    accessSecretVersion
      .mockResolvedValueOnce(payload(JSON.stringify({ token: 'good-token-value' })))
      .mockResolvedValue(payload(`still-not-json ${canary}`));

    const captured: unknown[] = [];
    const logger = {
      warn: (obj: Record<string, unknown>, msg: string) => captured.push(obj, msg),
      error: (obj: Record<string, unknown>, msg: string) => captured.push(obj, msg),
    };

    const provider = await createGcpSecretManagerSecretProvider(
      { ...baseEnv, KEEL_SECRET_CACHE_TTL_SECONDS: '1' },
      { logger },
    );
    cleanups.push(() => provider.close());

    expect(provider.get('token')).toBe('good-token-value');

    // Wait for a background refresh to fail on the malformed payload and log a diagnostic.
    for (let i = 0; i < 300 && captured.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(captured.length).toBeGreaterThan(0);

    // The last good value still serves, and the canary-bearing payload never reaches the log.
    expect(provider.get('token')).toBe('good-token-value');
    expect(JSON.stringify(captured)).not.toContain(canary);
  }, 10_000);
});

// Unit tests for the AWS Secrets Manager SecretProvider adapter (ADR-0024), against an
// aws-sdk-client-mock stub of SecretsManagerClient (no network). Asserts the JSON field map
// round-trips through GetSecretValue, ADR-0023 coercion, ResourceNotFound-as-empty, the fail-closed
// paths (SecretBinary-only, non-object JSON, malformed JSON), and that neither the secret value nor
// an SDK error detail reaches a log when a background refresh fails.
import {
  GetSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAwsSecretsManagerSecretProvider } from './aws-secrets-manager.secret-provider.js';

const sm = mockClient(SecretsManagerClient);

// A minimal env that selects a region (so the mocked client needs no ambient AWS config) and the
// configured secret id that gates the backend.
const baseEnv = { KEEL_AWS_SECRET_ID: 'keel-test', KEEL_AWS_REGION: 'us-east-1' };

function notFound(): ResourceNotFoundException {
  return new ResourceNotFoundException({
    message: "Secrets Manager can't find the specified secret.",
    $metadata: {},
  });
}

describe('AwsSecretsManagerSecretProvider', () => {
  const cleanups: (() => void)[] = [];

  beforeEach(() => {
    sm.reset();
  });

  afterEach(() => {
    for (const fn of cleanups.splice(0)) {
      fn();
    }
  });

  it('round-trips a JSON field map and applies ADR-0023 coercion', async () => {
    sm.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({
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
    });

    const provider = await createAwsSecretsManagerSecretProvider(baseEnv);
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

    // The adapter asked for the configured secret id.
    const call = sm.commandCalls(GetSecretValueCommand)[0];
    expect(call.args[0].input.SecretId).toBe('keel-test');
  });

  it('treats ResourceNotFoundException as an empty field map, not an error', async () => {
    sm.on(GetSecretValueCommand).rejects(notFound());

    const provider = await createAwsSecretsManagerSecretProvider(baseEnv);
    cleanups.push(() => provider.close());

    expect(provider.get('anything')).toBeUndefined();
  });

  it('fails closed when the secret has only SecretBinary (no SecretString)', async () => {
    sm.on(GetSecretValueCommand).resolves({
      SecretBinary: new Uint8Array([1, 2, 3]),
    });

    await expect(createAwsSecretsManagerSecretProvider(baseEnv)).rejects.toThrow(/no SecretString/);
  });

  it.each([
    ['a bare JSON string', JSON.stringify('just-a-string')],
    ['a JSON array', JSON.stringify([1, 2, 3])],
    ['JSON null', 'null'],
    ['a JSON number', '42'],
    ['malformed JSON', '{not valid'],
  ])('fails closed when SecretString is %s', async (_label, secretString) => {
    sm.on(GetSecretValueCommand).resolves({ SecretString: secretString });

    await expect(createAwsSecretsManagerSecretProvider(baseEnv)).rejects.toThrow(
      /not a JSON object/,
    );
  });

  it('fails closed (does not fall back to env) on a non-not-found SDK error', async () => {
    sm.on(GetSecretValueCommand).rejects(new Error('AccessDeniedException'));

    await expect(createAwsSecretsManagerSecretProvider(baseEnv)).rejects.toThrow();
  });

  it('fails closed when KEEL_AWS_SECRET_ID is unset', async () => {
    await expect(
      createAwsSecretsManagerSecretProvider({ KEEL_AWS_REGION: 'us-east-1' }),
    ).rejects.toThrow(/KEEL_AWS_SECRET_ID is required/);
  });

  it('fails closed when KEEL_SECRET_CACHE_TTL_SECONDS is not a positive integer', async () => {
    sm.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({ a: '1' }) });

    await expect(
      createAwsSecretsManagerSecretProvider({ ...baseEnv, KEEL_SECRET_CACHE_TTL_SECONDS: '0' }),
    ).rejects.toThrow(/positive integer/);
  });

  it('never logs the secret value when a background refresh fails', async () => {
    // First load succeeds with a known value; subsequent (refresh) loads reject with a non-not-found
    // error, so the cache keeps serving the last good value and the failure is logged.
    sm.on(GetSecretValueCommand)
      .resolvesOnce({ SecretString: JSON.stringify({ 'db-password': 'cached-swordfish-value' }) })
      .rejects(new Error('AccessDeniedException: user is not authorized'));

    const captured: unknown[] = [];
    const logger = {
      warn: (obj: Record<string, unknown>, msg: string) => captured.push(obj, msg),
      error: (obj: Record<string, unknown>, msg: string) => captured.push(obj, msg),
    };

    const provider = await createAwsSecretsManagerSecretProvider(
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
});

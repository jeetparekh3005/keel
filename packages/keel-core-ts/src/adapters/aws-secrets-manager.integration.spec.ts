// AWS Secrets Manager SecretProvider adapter against a real Secrets Manager API (ADR-0024, parity
// with the other verticals' integration tests).
//
// Runs only when KEEL_AWS_SECRET_ID is set (CI points AWS_ENDPOINT_URL_SECRETS_MANAGER at a
// LocalStack container); skipped otherwise so a local `pnpm test` stays green without a secret
// store. Writes a JSON secret over the SDK, then reads it back through the adapter, proving the
// end-to-end round-trip.
import {
  CreateSecretCommand,
  PutSecretValueCommand,
  ResourceExistsException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { afterAll, describe, expect, it } from 'vitest';

import { createAwsSecretsManagerSecretProvider } from './aws-secrets-manager.secret-provider.js';

const secretId = process.env.KEEL_AWS_SECRET_ID;
const region = process.env.KEEL_AWS_REGION ?? process.env.AWS_REGION ?? 'us-east-1';

describe.skipIf(!secretId)('AwsSecretsManagerSecretProvider (real Secrets Manager)', () => {
  const providers: { close: () => void }[] = [];

  afterAll(() => {
    for (const p of providers) {
      p.close();
    }
  });

  it('writes a JSON secret and reads it back through the adapter', async () => {
    const id = secretId as string;
    const expected = `roundtrip-${Date.now()}`;
    const payload = JSON.stringify({ 'api-key-hash': expected, other: 'present' });

    // The SDK honors AWS_ENDPOINT_URL_SECRETS_MANAGER (LocalStack) without a custom-endpoint knob.
    const client = new SecretsManagerClient({ region });
    try {
      await client.send(new CreateSecretCommand({ Name: id, SecretString: payload }));
    } catch (err) {
      if (err instanceof ResourceExistsException) {
        // The secret already exists from a previous run: overwrite its value with a fresh version.
        await client.send(new PutSecretValueCommand({ SecretId: id, SecretString: payload }));
      } else {
        throw err;
      }
    }
    client.destroy();

    const provider = await createAwsSecretsManagerSecretProvider({
      KEEL_AWS_SECRET_ID: id,
      KEEL_AWS_REGION: region,
    });
    providers.push(provider);

    expect(provider.get('api-key-hash')).toBe(expected);
    expect(provider.get('other')).toBe('present');
    expect(provider.get('does-not-exist')).toBeUndefined();
  });
});

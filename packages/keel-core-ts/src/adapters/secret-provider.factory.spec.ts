// Unit tests for the SecretProvider selection factory (ADR-0024 decision 5). The env-fallback and
// OpenBao-selection paths are covered in openbao.secret-provider.spec.ts; this file covers AWS and
// GCP selection and the at-most-one-backend fail-closed rule. No network: SecretsManagerClient is
// stubbed with aws-sdk-client-mock and the GCP SDK module is mocked.
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const accessSecretVersion = vi.fn();
const gcpClose = vi.fn();

vi.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: class {
    accessSecretVersion = accessSecretVersion;
    close = gcpClose;
  },
}));

import { AwsSecretsManagerSecretProvider } from './aws-secrets-manager.secret-provider.js';
import { GcpSecretManagerSecretProvider } from './gcp-secret-manager.secret-provider.js';
import { EnvSecretProvider } from './index.js';
import { secretProviderFromEnv } from './secret-provider.factory.js';

const sm = mockClient(SecretsManagerClient);

describe('secretProviderFromEnv (selection)', () => {
  beforeEach(() => {
    sm.reset();
    accessSecretVersion.mockReset();
    gcpClose.mockReset();
  });

  it('returns the EnvSecretProvider when no backend is gated', async () => {
    const provider = await secretProviderFromEnv({ SOME_SECRET: 'from-env' });
    expect(provider).toBeInstanceOf(EnvSecretProvider);
    expect(provider.get('SOME_SECRET')).toBe('from-env');
  });

  it('selects the AWS provider (fail-closed) when KEEL_AWS_SECRET_ID is set', async () => {
    sm.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ 'db-password': 'swordfish' }),
    });

    const provider = await secretProviderFromEnv({
      KEEL_AWS_SECRET_ID: 'keel-test',
      KEEL_AWS_REGION: 'us-east-1',
      // An env var with the same key must NOT shadow the AWS value (no silent env fallback).
      'db-password': 'env-value',
    });
    expect(provider).toBeInstanceOf(AwsSecretsManagerSecretProvider);
    expect(provider.get('db-password')).toBe('swordfish');
    (provider as AwsSecretsManagerSecretProvider).close();
  });

  it('selects the GCP provider (fail-closed) when KEEL_GCP_SECRET is set', async () => {
    accessSecretVersion.mockResolvedValue([
      { payload: { data: Buffer.from(JSON.stringify({ 'db-password': 'swordfish' }), 'utf8') } },
    ]);

    const provider = await secretProviderFromEnv({
      KEEL_GCP_SECRET: 'projects/keel-test/secrets/app',
      // An env var with the same key must NOT shadow the GCP value (no silent env fallback).
      'db-password': 'env-value',
    });
    expect(provider).toBeInstanceOf(GcpSecretManagerSecretProvider);
    expect(provider.get('db-password')).toBe('swordfish');
    (provider as GcpSecretManagerSecretProvider).close();
  });

  it('fails construction when more than one backend is configured', async () => {
    await expect(
      secretProviderFromEnv({
        KEEL_VAULT_ADDR: 'http://127.0.0.1:1',
        KEEL_AWS_SECRET_ID: 'keel-test',
      }),
    ).rejects.toThrow(/multiple secret backends configured/);
  });

  it('fails construction when AWS and GCP are both configured', async () => {
    await expect(
      secretProviderFromEnv({
        KEEL_AWS_SECRET_ID: 'keel-test',
        KEEL_GCP_SECRET: 'projects/keel-test/secrets/app',
      }),
    ).rejects.toThrow(/multiple secret backends configured/);
  });

  it('ignores whitespace-only gating vars when counting backends', async () => {
    // A whitespace-only KEEL_VAULT_ADDR is treated as unset, so AWS is the single selected backend.
    sm.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({ a: '1' }) });

    const provider = await secretProviderFromEnv({
      KEEL_VAULT_ADDR: '   ',
      KEEL_AWS_SECRET_ID: 'keel-test',
      KEEL_AWS_REGION: 'us-east-1',
    });
    expect(provider).toBeInstanceOf(AwsSecretsManagerSecretProvider);
    (provider as AwsSecretsManagerSecretProvider).close();
  });
});

// GCP Secret Manager SecretProvider adapter against a real Secret Manager API (ADR-0024).
//
// GCP ships no official emulator, so unlike the AWS adapter (LocalStack) this is the one backend
// without a CI-run integration test; its unit coverage is correspondingly thorough
// (gcp-secret-manager.secret-provider.spec.ts). This test runs ONLY where real Application Default
// Credentials and a JSON secret exist:
//   - KEEL_GCP_SECRET must be set (`projects/<p>/secrets/<n>` or `.../versions/<v>`); skipped otherwise.
//   - ADC must resolve (gcloud auth application-default login, Workload Identity, or a metadata
//     server) - the SDK reads them with no keel-managed credentials.
// Optionally assert a specific field round-trips by exporting KEEL_GCP_TEST_FIELD and
// KEEL_GCP_TEST_VALUE for a known key in that secret's JSON payload.
import { afterAll, describe, expect, it } from 'vitest';

import { createGcpSecretManagerSecretProvider } from './gcp-secret-manager.secret-provider.js';

const secret = process.env.KEEL_GCP_SECRET;
const field = process.env.KEEL_GCP_TEST_FIELD;
const value = process.env.KEEL_GCP_TEST_VALUE;

describe.skipIf(!secret)('GcpSecretManagerSecretProvider (real Secret Manager)', () => {
  const providers: { close: () => void }[] = [];

  afterAll(() => {
    for (const p of providers) {
      p.close();
    }
  });

  it('reads the configured secret through the adapter via ADC', async () => {
    const provider = await createGcpSecretManagerSecretProvider(process.env);
    providers.push(provider);

    // An absent key is always undefined (never a throw) once the field map loaded.
    expect(provider.get('definitely-not-a-real-field-xyz')).toBeUndefined();

    // If a known field/value pair was provided, assert the JSON field map round-trips end-to-end.
    if (field !== undefined && value !== undefined) {
      expect(provider.get(field)).toBe(value);
    }
  });
});

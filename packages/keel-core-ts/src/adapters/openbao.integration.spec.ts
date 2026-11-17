// OpenBao SecretProvider adapter against a real server (ADR-0023, v0.7 parity with the other
// verticals' integration tests).
//
// Runs only when KEEL_VAULT_ADDR is set (CI spins up an openbao:2.7.2 dev server); skipped
// otherwise so a local `pnpm test` stays green without a secret store. Writes a KV v2 secret over
// the Vault HTTP API, then reads it back through the adapter, proving the end-to-end round-trip.
import { afterAll, describe, expect, it } from 'vitest';

import { createOpenBaoSecretProvider } from './openbao.secret-provider.js';

const addr = process.env.KEEL_VAULT_ADDR;
const token = process.env.KEEL_VAULT_TOKEN;
const mount = process.env.KEEL_VAULT_MOUNT ?? 'secret';
const path = process.env.KEEL_VAULT_PATH ?? 'keel-test';

describe.skipIf(!addr || !token)('OpenBaoSecretProvider (real OpenBao)', () => {
  const providers: { close: () => void }[] = [];

  afterAll(() => {
    for (const p of providers) {
      p.close();
    }
  });

  it('writes a KV v2 secret and reads it back through the adapter', async () => {
    const base = (addr as string).replace(/\/+$/, '');
    const expected = `roundtrip-${Date.now()}`;
    const writeRes = await fetch(`${base}/v1/${mount}/data/${path}`, {
      method: 'POST',
      headers: { 'X-Vault-Token': token as string, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { 'api-key-hash': expected, other: 'present' } }),
    });
    expect(writeRes.status, await writeRes.text()).toBeLessThan(300);

    const provider = await createOpenBaoSecretProvider({
      KEEL_VAULT_ADDR: addr,
      KEEL_VAULT_TOKEN: token,
      KEEL_VAULT_MOUNT: mount,
      KEEL_VAULT_PATH: path,
    });
    providers.push(provider);

    expect(provider.get('api-key-hash')).toBe(expected);
    expect(provider.get('other')).toBe('present');
    expect(provider.get('does-not-exist')).toBeUndefined();
  });
});

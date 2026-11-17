// Unit tests for the OpenBao SecretProvider adapter (ADR-0023), against an in-process node:http
// mock Vault on 127.0.0.1:0. Asserts request shape (paths, headers, bodies) and that a known secret
// round-trips: token auth, Kubernetes login+read, field-map caching + TTL expiry refetch, 404 as
// empty, 403 re-auth+retry, the X-Vault-Namespace header, and fail-closed on misconfig.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createOpenBaoSecretProvider,
  OpenBaoSecretProvider,
  secretProviderFromEnv,
} from './openbao.secret-provider.js';

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

type Route = (req: CapturedRequest, res: ServerResponse) => void;

interface MockVault {
  url: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function startVault(route: Route): Promise<MockVault> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const captured: CapturedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: await readBody(req),
      };
      requests.push(captured);
      route(captured, res);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function kvData(fields: Record<string, unknown>): unknown {
  // The KV v2 read shape: the field map lives at the `.data.data` JSON pointer.
  return { data: { data: fields, metadata: { version: 1 } } };
}

const dataPath = (p = 'keel-test') => `/v1/secret/data/${p}`;

describe('OpenBaoSecretProvider', () => {
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    for (const fn of cleanups.splice(0)) {
      await fn();
    }
  });

  async function tmpJwt(contents: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'keel-jwt-'));
    const file = join(dir, 'token');
    await writeFile(file, contents);
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return file;
  }

  it('reads a secret with token auth and sends X-Vault-Token', async () => {
    const vault = await startVault((req, res) => {
      if (req.method === 'GET' && req.url === dataPath()) {
        sendJson(res, 200, kvData({ 'api-key-hash': 'sha256:abc', empty: '' }));
        return;
      }
      sendJson(res, 500, { errors: ['unexpected'] });
    });
    cleanups.push(vault.close);

    const provider = await createOpenBaoSecretProvider({
      KEEL_VAULT_ADDR: vault.url,
      KEEL_VAULT_TOKEN: 'root-token',
      KEEL_VAULT_PATH: 'keel-test',
    });
    cleanups.push(() => provider.close());

    expect(provider.get('api-key-hash')).toBe('sha256:abc');
    expect(provider.get('missing')).toBeUndefined();
    expect(provider.get('empty')).toBe('');
    expect(vault.requests[0].headers['x-vault-token']).toBe('root-token');
  });

  it('logs in via Kubernetes then reads, sending {role, jwt} with the jwt from the file', async () => {
    const jwtPath = await tmpJwt('k8s-jwt-contents\n');
    const vault = await startVault((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/auth/kubernetes/login') {
        sendJson(res, 200, { auth: { client_token: 'k8s-client-token', lease_duration: 3600 } });
        return;
      }
      if (req.method === 'GET' && req.url === dataPath()) {
        sendJson(res, 200, kvData({ secret: 'value-from-k8s' }));
        return;
      }
      sendJson(res, 500, { errors: ['unexpected'] });
    });
    cleanups.push(vault.close);

    const provider = await createOpenBaoSecretProvider({
      KEEL_VAULT_ADDR: vault.url,
      KEEL_VAULT_ROLE: 'keel-role',
      KEEL_VAULT_K8S_JWT_PATH: jwtPath,
      KEEL_VAULT_PATH: 'keel-test',
    });
    cleanups.push(() => provider.close());

    expect(provider.get('secret')).toBe('value-from-k8s');
    const login = vault.requests[0];
    expect(login.url).toBe('/v1/auth/kubernetes/login');
    expect(JSON.parse(login.body)).toEqual({ role: 'keel-role', jwt: 'k8s-jwt-contents' });
    // The read carried the token obtained from the login response.
    expect(vault.requests[1].headers['x-vault-token']).toBe('k8s-client-token');
  });

  it('serves repeated gets from cache (two gets, one upstream read)', async () => {
    let reads = 0;
    const vault = await startVault((req, res) => {
      if (req.method === 'GET' && req.url === dataPath()) {
        reads += 1;
        sendJson(res, 200, kvData({ a: '1', b: '2' }));
        return;
      }
      sendJson(res, 500, { errors: ['unexpected'] });
    });
    cleanups.push(vault.close);

    const provider = await createOpenBaoSecretProvider({
      KEEL_VAULT_ADDR: vault.url,
      KEEL_VAULT_TOKEN: 'root-token',
      KEEL_VAULT_PATH: 'keel-test',
    });
    cleanups.push(() => provider.close());

    expect(provider.get('a')).toBe('1');
    expect(provider.get('b')).toBe('2');
    expect(reads).toBe(1);
  });

  it('refetches after the cache TTL expires', async () => {
    let reads = 0;
    const vault = await startVault((req, res) => {
      if (req.method === 'GET' && req.url === dataPath()) {
        reads += 1;
        sendJson(res, 200, kvData({ counter: String(reads) }));
        return;
      }
      sendJson(res, 500, { errors: ['unexpected'] });
    });
    cleanups.push(vault.close);

    // A tiny TTL (50ms) so the background refresh fires promptly without fake timers.
    const provider = await createOpenBaoSecretProvider({
      KEEL_VAULT_ADDR: vault.url,
      KEEL_VAULT_TOKEN: 'root-token',
      KEEL_VAULT_PATH: 'keel-test',
      KEEL_VAULT_CACHE_TTL_SECONDS: '0.05',
    });
    cleanups.push(() => provider.close());

    expect(provider.get('counter')).toBe('1');
    for (let i = 0; i < 100 && reads < 2; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(provider.get('counter')).toBe(String(reads));
  });

  it('treats a 404 at the path as an empty field map, not an error', async () => {
    const vault = await startVault((req, res) => {
      if (req.method === 'GET' && req.url === dataPath()) {
        sendJson(res, 404, { errors: [] });
        return;
      }
      sendJson(res, 500, { errors: ['unexpected'] });
    });
    cleanups.push(vault.close);

    const provider = await createOpenBaoSecretProvider({
      KEEL_VAULT_ADDR: vault.url,
      KEEL_VAULT_TOKEN: 'root-token',
      KEEL_VAULT_PATH: 'keel-test',
    });
    cleanups.push(() => provider.close());

    expect(provider.get('anything')).toBeUndefined();
  });

  it('re-authenticates and retries once on a 403 during read (Kubernetes)', async () => {
    const jwtPath = await tmpJwt('jwt');
    let logins = 0;
    let reads = 0;
    const vault = await startVault((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/auth/kubernetes/login') {
        logins += 1;
        sendJson(res, 200, { auth: { client_token: `token-${logins}`, lease_duration: 3600 } });
        return;
      }
      if (req.method === 'GET' && req.url === dataPath()) {
        reads += 1;
        if (reads === 1) {
          sendJson(res, 403, { errors: ['permission denied'] });
          return;
        }
        sendJson(res, 200, kvData({ secret: 'after-reauth' }));
        return;
      }
      sendJson(res, 500, { errors: ['unexpected'] });
    });
    cleanups.push(vault.close);

    const provider = await createOpenBaoSecretProvider({
      KEEL_VAULT_ADDR: vault.url,
      KEEL_VAULT_ROLE: 'keel-role',
      KEEL_VAULT_K8S_JWT_PATH: jwtPath,
      KEEL_VAULT_PATH: 'keel-test',
    });
    cleanups.push(() => provider.close());

    expect(provider.get('secret')).toBe('after-reauth');
    expect(logins).toBe(2);
    expect(reads).toBe(2);
    // The retried read used the freshly-minted token.
    expect(vault.requests[3].headers['x-vault-token']).toBe('token-2');
  });

  it('sends X-Vault-Namespace when configured', async () => {
    const vault = await startVault((req, res) => {
      if (req.method === 'GET' && req.url === dataPath()) {
        sendJson(res, 200, kvData({ secret: 'ns' }));
        return;
      }
      sendJson(res, 500, { errors: ['unexpected'] });
    });
    cleanups.push(vault.close);

    const provider = await createOpenBaoSecretProvider({
      KEEL_VAULT_ADDR: vault.url,
      KEEL_VAULT_TOKEN: 'root-token',
      KEEL_VAULT_PATH: 'keel-test',
      KEEL_VAULT_NAMESPACE: 'team-a',
    });
    cleanups.push(() => provider.close());

    expect(provider.get('secret')).toBe('ns');
    expect(vault.requests[0].headers['x-vault-namespace']).toBe('team-a');
  });

  it('honors a custom KEEL_VAULT_MOUNT and KEEL_VAULT_PATH in the read URL', async () => {
    const vault = await startVault((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/kv/data/app/prod') {
        sendJson(res, 200, kvData({ secret: 'mounted' }));
        return;
      }
      sendJson(res, 500, { errors: ['unexpected'] });
    });
    cleanups.push(vault.close);

    const provider = await createOpenBaoSecretProvider({
      KEEL_VAULT_ADDR: `${vault.url}/`,
      KEEL_VAULT_TOKEN: 'root-token',
      KEEL_VAULT_MOUNT: 'kv',
      KEEL_VAULT_PATH: 'app/prod',
    });
    cleanups.push(() => provider.close());

    expect(provider.get('secret')).toBe('mounted');
  });

  it('fails closed when KEEL_VAULT_ADDR is set but no auth is configured', async () => {
    await expect(
      createOpenBaoSecretProvider({
        KEEL_VAULT_ADDR: 'http://127.0.0.1:1',
        KEEL_VAULT_PATH: 'keel-test',
      }),
    ).rejects.toThrow(/no auth configured/);
  });

  it('fails closed when KEEL_VAULT_ADDR is set but KEEL_VAULT_PATH is missing', async () => {
    await expect(
      createOpenBaoSecretProvider({
        KEEL_VAULT_ADDR: 'http://127.0.0.1:1',
        KEEL_VAULT_TOKEN: 'root-token',
      }),
    ).rejects.toThrow(/KEEL_VAULT_PATH is required/);
  });

  it('fails loudly (does not fall back to env) when the server is unreachable', async () => {
    await expect(
      createOpenBaoSecretProvider({
        // Port 1 is not listening: the first load must reject rather than serve an empty cache.
        KEEL_VAULT_ADDR: 'http://127.0.0.1:1',
        KEEL_VAULT_TOKEN: 'root-token',
        KEEL_VAULT_PATH: 'keel-test',
      }),
    ).rejects.toThrow();
  });

  describe('secretProviderFromEnv', () => {
    it('returns the EnvSecretProvider when KEEL_VAULT_ADDR is unset', async () => {
      const provider = await secretProviderFromEnv({ SOME_SECRET: 'from-env' });
      expect(provider.get('SOME_SECRET')).toBe('from-env');
      expect(provider.get('absent')).toBeUndefined();
    });

    it('returns the OpenBao provider (fail-closed) when KEEL_VAULT_ADDR is set', async () => {
      const vault = await startVault((req, res) => {
        if (req.method === 'GET' && req.url === dataPath()) {
          sendJson(res, 200, kvData({ 'db-password': 'swordfish' }));
          return;
        }
        sendJson(res, 500, { errors: ['unexpected'] });
      });
      cleanups.push(vault.close);

      const provider = await secretProviderFromEnv({
        KEEL_VAULT_ADDR: vault.url,
        KEEL_VAULT_TOKEN: 'root-token',
        KEEL_VAULT_PATH: 'keel-test',
        // An env var with the same key must NOT shadow the vault value (no silent env fallback).
        'db-password': 'env-value',
      });
      expect(provider.get('db-password')).toBe('swordfish');
      expect(provider).toBeInstanceOf(OpenBaoSecretProvider);
      (provider as OpenBaoSecretProvider).close();
    });
  });
});

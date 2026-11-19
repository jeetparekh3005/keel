// Unit tests for the OpenBao SecretProvider adapter (ADR-0023), against an in-process node:http
// mock Vault on 127.0.0.1:0. Asserts request shape (paths, headers, bodies) and that a known secret
// round-trips: token auth, Kubernetes login+read, field-map caching + TTL expiry refetch, 404 as
// empty, 403 re-auth+retry, the X-Vault-Namespace header, and fail-closed on misconfig. Also covers
// the hardening surface: per-request HTTP timeouts on both paths, the KEEL_VAULT_CACERT node:https
// custom-CA path (with a self-signed CA), proactive lease renewal, ADR-0023 field coercion, the
// positive-integer TTL rule, and that neither the secret value nor the token ever reaches a log.
import { generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import forge from 'node-forge';
import { afterEach, describe, expect, it } from 'vitest';

import { createOpenBaoSecretProvider, OpenBaoSecretProvider } from './openbao.secret-provider.js';
import { secretProviderFromEnv } from './secret-provider.factory.js';

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

// --- In-process PKI for the KEEL_VAULT_CACERT (node:https) tests. RSA keys are generated with Node's
// native crypto and the certificates built/signed with node-forge, so no key is committed (mirrors
// the gRPC TLS tests). The leaf carries a 127.0.0.1 IP SAN so hostname verification passes. ---
interface Pem {
  certPem: string;
  keyPem: string;
}
interface Ca {
  pem: Pem;
  key: forge.pki.rsa.PrivateKey;
  cert: forge.pki.Certificate;
}

function keyPair(): {
  priv: forge.pki.rsa.PrivateKey;
  pub: forge.pki.rsa.PublicKey;
  keyPem: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return {
    priv: forge.pki.privateKeyFromPem(keyPem),
    pub: forge.pki.publicKeyFromPem(pubPem),
    keyPem,
  };
}

function withValidity(cert: forge.pki.Certificate, serial: string): void {
  cert.serialNumber = serial;
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 3_600_000);
}

function makeCa(cn: string): Ca {
  const { priv, pub, keyPem } = keyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = pub;
  withValidity(cert, '01');
  const attrs = [{ name: 'commonName', value: cn }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, digitalSignature: true },
  ]);
  cert.sign(priv, forge.md.sha256.create());
  return { pem: { certPem: forge.pki.certificateToPem(cert), keyPem }, key: priv, cert };
}

function makeLeaf(ca: Ca): Pem {
  const { pub, keyPem } = keyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = pub;
  withValidity(cert, '02');
  cert.setSubject([{ name: 'commonName', value: '127.0.0.1' }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem };
}

async function startHttpsVault(
  route: Route,
  tls: { key: string; cert: string },
): Promise<MockVault> {
  const requests: CapturedRequest[] = [];
  const server = createHttpsServer(tls, (req, res) => {
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
    url: `https://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

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

    // The smallest valid TTL (1s, the positive-integer floor) so the background refresh fires
    // promptly without fake timers.
    const provider = await createOpenBaoSecretProvider({
      KEEL_VAULT_ADDR: vault.url,
      KEEL_VAULT_TOKEN: 'root-token',
      KEEL_VAULT_PATH: 'keel-test',
      KEEL_SECRET_CACHE_TTL_SECONDS: '1',
    });
    cleanups.push(() => provider.close());

    expect(provider.get('counter')).toBe('1');
    // Poll the adapter's own cached value (not the server-side counter) so the assertion cannot race
    // a refresh that has incremented `reads` but not yet stored the new field map.
    let latest = provider.get('counter');
    for (let i = 0; i < 300 && latest === '1'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      latest = provider.get('counter');
    }
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(Number(latest)).toBeGreaterThanOrEqual(2);
  }, 10_000);

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

  it('coerces field values per ADR-0023 (string verbatim, number/boolean canonical, structured absent)', async () => {
    const vault = await startVault((req, res) => {
      if (req.method === 'GET' && req.url === dataPath()) {
        sendJson(
          res,
          200,
          kvData({
            str: 'verbatim',
            num: 42,
            float: 1.5,
            boolTrue: true,
            boolFalse: false,
            obj: { nested: 'x' },
            arr: [1, 2, 3],
            nul: null,
          }),
        );
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

    expect(provider.get('str')).toBe('verbatim');
    expect(provider.get('num')).toBe('42');
    expect(provider.get('float')).toBe('1.5');
    expect(provider.get('boolTrue')).toBe('true');
    expect(provider.get('boolFalse')).toBe('false');
    // Structured values are reported absent, never stringified to "[object Object]" or "1,2,3".
    expect(provider.get('obj')).toBeUndefined();
    expect(provider.get('arr')).toBeUndefined();
    expect(provider.get('nul')).toBeUndefined();
  });

  it.each(['0', '-1', '0.05', '1.5', 'abc', 'NaN'])(
    'fails closed when KEEL_SECRET_CACHE_TTL_SECONDS=%j is not a positive integer',
    async (ttl) => {
      await expect(
        createOpenBaoSecretProvider({
          // Rejected in config resolution before any network call, so the address is never contacted.
          KEEL_VAULT_ADDR: 'http://127.0.0.1:1',
          KEEL_VAULT_TOKEN: 'root-token',
          KEEL_VAULT_PATH: 'keel-test',
          KEEL_SECRET_CACHE_TTL_SECONDS: ttl,
        }),
      ).rejects.toThrow(/positive integer/);
    },
  );

  it('rejects within the timeout when the server never responds (fetch path)', async () => {
    // Accept the socket but never call res.end(): the request hangs until the timeout aborts it.
    const vault = await startVault(() => {});
    cleanups.push(vault.close);

    const start = Date.now();
    await expect(
      createOpenBaoSecretProvider(
        {
          KEEL_VAULT_ADDR: vault.url,
          KEEL_VAULT_TOKEN: 'root-token',
          KEEL_VAULT_PATH: 'keel-test',
        },
        { timeoutMs: 150 },
      ),
    ).rejects.toThrow();
    // The key property: it rejects promptly rather than hanging init forever.
    expect(Date.now() - start).toBeLessThan(2_000);
  }, 10_000);

  it('rejects within the timeout when the custom-CA server never responds (node:https path)', async () => {
    const ca = makeCa('keel-test-ca');
    const leaf = makeLeaf(ca);
    const vault = await startHttpsVault(() => {}, { key: leaf.keyPem, cert: leaf.certPem });
    cleanups.push(vault.close);

    const start = Date.now();
    await expect(
      createOpenBaoSecretProvider(
        {
          KEEL_VAULT_ADDR: vault.url,
          KEEL_VAULT_TOKEN: 'root-token',
          KEEL_VAULT_PATH: 'keel-test',
          KEEL_VAULT_CACERT: ca.pem.certPem,
        },
        { timeoutMs: 150 },
      ),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - start).toBeLessThan(2_000);
  }, 10_000);

  it('round-trips a secret over the KEEL_VAULT_CACERT node:https custom-CA path', async () => {
    const ca = makeCa('keel-test-ca');
    const leaf = makeLeaf(ca);
    const vault = await startHttpsVault(
      (req, res) => {
        if (req.method === 'GET' && req.url === dataPath()) {
          sendJson(res, 200, kvData({ 'api-key-hash': 'sha256:ca' }));
          return;
        }
        sendJson(res, 500, { errors: ['unexpected'] });
      },
      { key: leaf.keyPem, cert: leaf.certPem },
    );
    cleanups.push(vault.close);

    const provider = await createOpenBaoSecretProvider({
      KEEL_VAULT_ADDR: vault.url,
      KEEL_VAULT_TOKEN: 'root-token',
      KEEL_VAULT_PATH: 'keel-test',
      KEEL_VAULT_CACERT: ca.pem.certPem,
    });
    cleanups.push(() => provider.close());

    expect(provider.get('api-key-hash')).toBe('sha256:ca');
    // The read reached the TLS server over the pinned-CA channel and carried the token.
    expect(vault.requests[0].headers['x-vault-token']).toBe('root-token');
  });

  it('fails TLS verification against the self-signed server when KEEL_VAULT_CACERT is absent', async () => {
    const ca = makeCa('keel-test-ca');
    const leaf = makeLeaf(ca);
    const vault = await startHttpsVault(
      (_req, res) => sendJson(res, 200, kvData({ secret: 'unreachable' })),
      { key: leaf.keyPem, cert: leaf.certPem },
    );
    cleanups.push(vault.close);

    // No KEEL_VAULT_CACERT: the global-fetch path verifies against the system trust store, which does
    // not contain this ad-hoc CA, so the connection is refused (verification stays on, fail-closed).
    await expect(
      createOpenBaoSecretProvider({
        KEEL_VAULT_ADDR: vault.url,
        KEEL_VAULT_TOKEN: 'root-token',
        KEEL_VAULT_PATH: 'keel-test',
      }),
    ).rejects.toThrow();
  });

  it('rejects when KEEL_VAULT_CACERT pins a different CA than the server cert (verification stays on)', async () => {
    const serverCa = makeCa('keel-server-ca');
    const leaf = makeLeaf(serverCa);
    const otherCa = makeCa('keel-other-ca');
    const vault = await startHttpsVault(
      (_req, res) => sendJson(res, 200, kvData({ secret: 'unreachable' })),
      { key: leaf.keyPem, cert: leaf.certPem },
    );
    cleanups.push(vault.close);

    // A valid-but-wrong CA must still fail: the node:https path keeps rejectUnauthorized on.
    await expect(
      createOpenBaoSecretProvider({
        KEEL_VAULT_ADDR: vault.url,
        KEEL_VAULT_TOKEN: 'root-token',
        KEEL_VAULT_PATH: 'keel-test',
        KEEL_VAULT_CACERT: otherCa.pem.certPem,
      }),
    ).rejects.toThrow();
  });

  it('proactively re-logs in before a Kubernetes lease expires (ahead of the TTL refresh)', async () => {
    const jwtPath = await tmpJwt('jwt');
    let logins = 0;
    const vault = await startVault((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/auth/kubernetes/login') {
        logins += 1;
        // An 11s lease with the adapter's 10s renew skew means the first background refresh (at the
        // 1s TTL) is already inside the renewal window, so a re-login fires ~10s ahead of expiry.
        sendJson(res, 200, { auth: { client_token: `token-${logins}`, lease_duration: 11 } });
        return;
      }
      if (req.method === 'GET' && req.url === dataPath()) {
        sendJson(res, 200, kvData({ secret: 'leased' }));
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
      KEEL_SECRET_CACHE_TTL_SECONDS: '1',
    });
    cleanups.push(() => provider.close());

    expect(logins).toBe(1);
    const start = Date.now();
    for (let i = 0; i < 300 && logins < 2; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const elapsed = Date.now() - start;
    expect(logins).toBeGreaterThanOrEqual(2);
    // The re-login landed well ahead of the 11s lease expiry (proactive, not post-expiry recovery).
    expect(elapsed).toBeLessThan(5_000);
  }, 10_000);

  it('never logs the secret value or the vault token when a refresh fails', async () => {
    let fail = false;
    const vault = await startVault((req, res) => {
      if (req.method === 'GET' && req.url === dataPath()) {
        if (fail) {
          sendJson(res, 500, { errors: ['boom'] });
          return;
        }
        sendJson(res, 200, kvData({ 'db-password': 'cached-swordfish-value' }));
        return;
      }
      sendJson(res, 500, { errors: ['unexpected'] });
    });
    cleanups.push(vault.close);

    const captured: unknown[] = [];
    const logger = {
      warn: (obj: Record<string, unknown>, msg: string) => captured.push(obj, msg),
      error: (obj: Record<string, unknown>, msg: string) => captured.push(obj, msg),
    };

    const provider = await createOpenBaoSecretProvider(
      {
        KEEL_VAULT_ADDR: vault.url,
        KEEL_VAULT_TOKEN: 'super-secret-vault-token',
        KEEL_VAULT_PATH: 'keel-test',
        KEEL_SECRET_CACHE_TTL_SECONDS: '1',
      },
      { logger },
    );
    cleanups.push(() => provider.close());

    expect(provider.get('db-password')).toBe('cached-swordfish-value');

    // Flip the upstream to 500 and wait for a background refresh to fail and log a diagnostic.
    fail = true;
    for (let i = 0; i < 300 && captured.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(captured.length).toBeGreaterThan(0);

    // The last good value still serves (a transient outage does not blank the cache)...
    expect(provider.get('db-password')).toBe('cached-swordfish-value');
    // ...and neither the secret value nor the token appears anywhere in what was logged.
    const dump = JSON.stringify(captured);
    expect(dump).not.toContain('cached-swordfish-value');
    expect(dump).not.toContain('super-secret-vault-token');
  }, 10_000);

  describe('secretProviderFromEnv', () => {
    it('returns the EnvSecretProvider when KEEL_VAULT_ADDR is unset', async () => {
      const provider = await secretProviderFromEnv({ SOME_SECRET: 'from-env' });
      expect(provider.get('SOME_SECRET')).toBe('from-env');
      expect(provider.get('absent')).toBeUndefined();
    });

    it('treats a whitespace-only KEEL_VAULT_ADDR as unset (EnvSecretProvider)', async () => {
      const provider = await secretProviderFromEnv({
        KEEL_VAULT_ADDR: '   ',
        SOME_SECRET: 'from-env',
      });
      expect(provider).not.toBeInstanceOf(OpenBaoSecretProvider);
      expect(provider.get('SOME_SECRET')).toBe('from-env');
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

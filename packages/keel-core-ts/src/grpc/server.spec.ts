import { Code, ConnectError, type ConnectRouter, createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import forge from 'node-forge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ErrorCategory, isDomainError } from '../domain/errors.js';
import { ItemService } from '../genproto/keel/reference/v1/item_pb.js';
import { InMemorySecretProvider, principal, StubAuthenticator } from '../testkit/index.js';
import { PRINCIPAL } from './context.js';
import { InMemoryItemStore, ITEM_SERVICE_SCOPES, registerItemService } from './item-service.js';
import { createGrpcHandler, createMutualTlsGrpcServer, type GrpcHandler } from './server.js';
import { clientTlsOptions, loadMutualTlsPem, type MutualTlsPem, serverTlsOptions } from './tls.js';

// --- In-process PKI (generated at test time, like the Python test, so no key is committed). ---
// RSA keys are generated with Node's native crypto (fast) and the certificates are built and
// signed with node-forge.

interface Identity {
  certPem: string;
  keyPem: string;
  forgeKey: forge.pki.rsa.PrivateKey;
  forgeCert: forge.pki.Certificate;
}

function forgeKeyPair(): {
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

function baseCert(pub: forge.pki.rsa.PublicKey, serial: string): forge.pki.Certificate {
  const cert = forge.pki.createCertificate();
  cert.publicKey = pub;
  cert.serialNumber = serial;
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 3_600_000);
  return cert;
}

function makeCa(): Identity {
  const { priv, pub, keyPem } = forgeKeyPair();
  const cert = baseCert(pub, '01');
  const attrs = [{ name: 'commonName', value: 'keel-test-ca' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, digitalSignature: true },
  ]);
  cert.sign(priv, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem, forgeKey: priv, forgeCert: cert };
}

function makeLeaf(ca: Identity, cn: string, serial: string, withSan: boolean): Identity {
  const { priv, pub, keyPem } = forgeKeyPair();
  const cert = baseCert(pub, serial);
  cert.setSubject([{ name: 'commonName', value: cn }]);
  cert.setIssuer(ca.forgeCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
    ...(withSan
      ? [
          {
            name: 'subjectAltName',
            altNames: [
              { type: 2, value: 'localhost' },
              { type: 7, ip: '127.0.0.1' },
            ],
          },
        ]
      : []),
  ]);
  cert.sign(ca.forgeKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem, forgeKey: priv, forgeCert: cert };
}

function makeSelfSigned(cn: string): Identity {
  const { priv, pub, keyPem } = forgeKeyPair();
  const cert = baseCert(pub, '09');
  const attrs = [{ name: 'commonName', value: cn }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'basicConstraints', cA: true }]);
  cert.sign(priv, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem, forgeKey: priv, forgeCert: cert };
}

async function listen(
  handler: GrpcHandler,
  pem: MutualTlsPem,
): Promise<{ server: ReturnType<typeof createMutualTlsGrpcServer>; port: number }> {
  const server = createMutualTlsGrpcServer(pem, handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, port };
}

function close(server: ReturnType<typeof createMutualTlsGrpcServer>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function clientFor(port: number, pem: MutualTlsPem) {
  const transport = createGrpcTransport({
    baseUrl: `https://127.0.0.1:${port}`,
    nodeOptions: clientTlsOptions(pem),
  });
  return createClient(ItemService, transport);
}

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

async function codeOf(promise: Promise<unknown>): Promise<Code | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return ConnectError.from(err).code;
  }
}

describe('gRPC server: deny-by-default auth over mTLS', () => {
  let ca: Identity;
  let serverPem: MutualTlsPem;
  let clientPem: MutualTlsPem;
  let server: ReturnType<typeof createMutualTlsGrpcServer>;
  let port: number;

  beforeAll(async () => {
    ca = makeCa();
    const serverLeaf = makeLeaf(ca, 'localhost', '02', true);
    const clientLeaf = makeLeaf(ca, 'keel-client', '03', false);
    serverPem = { rootCa: ca.certPem, cert: serverLeaf.certPem, key: serverLeaf.keyPem };
    clientPem = { rootCa: ca.certPem, cert: clientLeaf.certPem, key: clientLeaf.keyPem };

    const authenticator = new StubAuthenticator({
      reader: principal('svc-reader', 'items:read'),
      writer: principal('svc-writer', 'items:read', 'items:write'),
      noscope: principal('svc-noscope'),
    });
    const store = new InMemoryItemStore();
    const handler = createGrpcHandler({
      authenticator,
      requiredScopes: ITEM_SERVICE_SCOPES,
      routes: (router: ConnectRouter) => registerItemService(router, store),
    });
    ({ server, port } = await listen(handler, serverPem));
  }, 60_000);

  afterAll(async () => {
    await close(server);
  });

  it('rejects a call with no token as UNAUTHENTICATED', async () => {
    const client = clientFor(port, clientPem);
    expect(await codeOf(client.listItems({}))).toBe(Code.Unauthenticated);
  });

  it('rejects an unknown token as UNAUTHENTICATED', async () => {
    const client = clientFor(port, clientPem);
    expect(await codeOf(client.getItem({ id: 'x' }, bearer('bogus')))).toBe(Code.Unauthenticated);
  });

  it('rejects a valid token lacking the method scope as PERMISSION_DENIED', async () => {
    const client = clientFor(port, clientPem);
    // reader holds items:read but CreateItem requires items:write.
    expect(await codeOf(client.createItem({ name: 'nope' }, bearer('reader')))).toBe(
      Code.PermissionDenied,
    );
    // noscope holds nothing, so even a read is denied.
    expect(await codeOf(client.getItem({ id: 'x' }, bearer('noscope')))).toBe(
      Code.PermissionDenied,
    );
  });

  it('serves the payload for a valid token with the required scope', async () => {
    const client = clientFor(port, clientPem);
    const created = await client.createItem({ name: 'widget' }, bearer('writer'));
    expect(created.item?.name).toBe('widget');
    expect(created.item?.id).toMatch(/[0-9a-f-]{36}/);

    const fetched = await client.getItem({ id: created.item?.id ?? '' }, bearer('reader'));
    expect(fetched.item?.name).toBe('widget');

    const listed = await client.listItems({}, bearer('reader'));
    expect(listed.items.map((i) => i.name)).toContain('widget');
  });

  it('maps a domain NotFound to gRPC NOT_FOUND', async () => {
    const client = clientFor(port, clientPem);
    expect(await codeOf(client.getItem({ id: 'missing' }, bearer('reader')))).toBe(Code.NotFound);
  });

  it('rejects an untrusted client certificate at the mTLS handshake', async () => {
    const untrusted = makeSelfSigned('attacker');
    // The client trusts the server (rootCa) but presents a cert the server's CA did not sign.
    const untrustedPem: MutualTlsPem = {
      rootCa: ca.certPem,
      cert: untrusted.certPem,
      key: untrusted.keyPem,
    };
    const client = clientFor(port, untrustedPem);
    // Even with a valid token, the call never reaches auth: the TLS handshake fails first.
    await expect(client.listItems({}, bearer('writer'))).rejects.toThrow();
  });
});

describe('gRPC server: Principal is exposed to the handler', () => {
  let server: ReturnType<typeof createMutualTlsGrpcServer>;
  let port: number;
  let pem: MutualTlsPem;

  beforeAll(async () => {
    const ca = makeCa();
    const serverLeaf = makeLeaf(ca, 'localhost', '04', true);
    pem = { rootCa: ca.certPem, cert: serverLeaf.certPem, key: serverLeaf.keyPem };

    const authenticator = new StubAuthenticator({ reader: principal('svc-reader', 'items:read') });
    const handler = createGrpcHandler({
      authenticator,
      requiredScopes: ITEM_SERVICE_SCOPES,
      // A custom ItemService whose GetItem echoes the authenticated principal's subject, proving
      // the interceptor published it on the handler context (the gRPC analogue of Python's WhoAmI).
      routes: (router: ConnectRouter) =>
        router.service(ItemService, {
          getItem(_req, ctx) {
            const caller = ctx.values.get(PRINCIPAL);
            return { item: { id: _req.id, name: caller?.subject ?? 'anonymous' } };
          },
        }),
    });
    ({ server, port } = await listen(handler, pem));
  }, 60_000);

  afterAll(async () => {
    await close(server);
  });

  it('gives the handler the verified Principal', async () => {
    const client = clientFor(port, pem);
    const res = await client.getItem({ id: '1' }, bearer('reader'));
    expect(res.item?.name).toBe('svc-reader');
  });
});

describe('gRPC server: OpenTelemetry instrumentation', () => {
  let provider: BasicTracerProvider;
  let exporter: InMemorySpanExporter;
  let server: ReturnType<typeof createMutualTlsGrpcServer>;
  let port: number;
  let pem: MutualTlsPem;

  beforeAll(async () => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);

    const ca = makeCa();
    const serverLeaf = makeLeaf(ca, 'localhost', '05', true);
    pem = { rootCa: ca.certPem, cert: serverLeaf.certPem, key: serverLeaf.keyPem };
    const authenticator = new StubAuthenticator({ reader: principal('svc-reader', 'items:read') });
    const store = new InMemoryItemStore();
    const handler = createGrpcHandler({
      authenticator,
      requiredScopes: ITEM_SERVICE_SCOPES,
      routes: (router: ConnectRouter) => registerItemService(router, store),
    });
    ({ server, port } = await listen(handler, pem));
  }, 60_000);

  afterAll(async () => {
    await close(server);
    await provider.shutdown();
    context.disable();
    trace.disable();
  });

  it('emits a SERVER span named for the gRPC method', async () => {
    const client = clientFor(port, pem);
    await client.listItems({}, bearer('reader'));
    const span = exporter.getFinishedSpans().find((s) => s.name.includes('ItemService/ListItems'));
    expect(span, 'no gRPC server span was exported').toBeDefined();
    expect(span?.attributes['rpc.system']).toBe('grpc');
    expect(span?.attributes['rpc.method']).toBe('ListItems');
  });
});

describe('mTLS credential builders', () => {
  it('loads PEM material from the SecretProvider', () => {
    const secrets = new InMemorySecretProvider({
      'grpc.tls.ca': 'ca-pem',
      'grpc.tls.cert': 'cert-pem',
      'grpc.tls.key': 'key-pem',
    });
    const pem = loadMutualTlsPem(secrets, {
      rootCa: 'grpc.tls.ca',
      cert: 'grpc.tls.cert',
      key: 'grpc.tls.key',
    });
    expect(pem).toEqual({ rootCa: 'ca-pem', cert: 'cert-pem', key: 'key-pem' });
  });

  it('fails with an Unavailable DomainError when a secret is missing', () => {
    const secrets = new InMemorySecretProvider({ 'grpc.tls.ca': 'ca-pem' });
    try {
      loadMutualTlsPem(secrets, {
        rootCa: 'grpc.tls.ca',
        cert: 'grpc.tls.cert',
        key: 'grpc.tls.key',
      });
      expect.fail('expected a DomainError');
    } catch (err) {
      expect(isDomainError(err)).toBe(true);
      expect(isDomainError(err) && err.category).toBe(ErrorCategory.Unavailable);
    }
  });

  it('requires + verifies the client cert on the server and presents one on the client', () => {
    const pem: MutualTlsPem = { rootCa: 'ca', cert: 'c', key: 'k' };
    const srv = serverTlsOptions(pem);
    expect(srv.requestCert).toBe(true);
    expect(srv.rejectUnauthorized).toBe(true);
    expect(srv.ca).toBe('ca');
    const cli = clientTlsOptions(pem);
    expect(cli.cert).toBe('c');
    expect(cli.rejectUnauthorized).toBe(true);
  });
});

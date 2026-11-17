// OpenBao (Vault KV v2) SecretProvider adapter (ADR-0023), refactored onto the shared caching core
// (ADR-0024 decision 3). The SecretProvider port's `get` is synchronous in every vertical and Node
// cannot do synchronous HTTP, so `get()` must never perform I/O: the loader authenticates and loads
// the KV v2 field map into memory once at init (awaited by the async factory below), then the core
// serves `get()` synchronously from that cache and re-invokes the loader every TTL; a transient
// outage keeps serving the last good field map.
//
// The identical Vault HTTP API serves OpenBao and HashiCorp Vault, so this one adapter covers
// either endpoint. Token and Kubernetes auth only (ADR-0023); no vault SDK dependency - the client
// is a few `fetch` calls over the global fetch (Node 24+). `KEEL_VAULT_CACERT` is honored via a
// node:https request (global fetch cannot take a custom CA without the undici Agent, which Node does
// not expose as an importable module).
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';

import { createLogger } from '../logging/logger.js';
import {
  asRecord,
  CachingSecretProvider,
  resolveCacheTtlMs,
  type SecretLoader,
  type SecretProviderLogger,
  trimmed,
} from './caching-secret-provider.js';

export type { SecretProviderLogger };

/** Optional construction seams (a logger for refresh diagnostics); all have production defaults. */
export interface OpenBaoOptions {
  logger?: SecretProviderLogger;
  /**
   * Hard per-request HTTP timeout in milliseconds (default {@link DEFAULT_TIMEOUT_MS}). Bounds both
   * request paths so a wedged OpenBao that accepts the socket but never responds cannot hang startup
   * forever; a request that exceeds it rejects (fail-closed). Primarily a test seam.
   */
  timeoutMs?: number;
}

/** Resolved, validated OpenBao configuration (the `KEEL_VAULT_*` surface from ADR-0023). */
interface OpenBaoConfig {
  addr: string;
  token?: string;
  role?: string;
  k8sMount: string;
  k8sJwtPath: string;
  mount: string;
  path: string;
  namespace?: string;
  cacert?: string;
  ttlMs: number;
  timeoutMs: number;
}

const DEFAULT_K8S_MOUNT = 'kubernetes';
const DEFAULT_K8S_JWT_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const DEFAULT_MOUNT = 'secret';
// Hard per-request HTTP timeout: a wedged OpenBao that never replies must not hang startup forever.
const DEFAULT_TIMEOUT_MS = 10_000;
// Re-login this many ms before a Kubernetes lease expires, so a refresh never races the expiry.
const LEASE_RENEW_SKEW_MS = 10_000;

/**
 * Resolve and validate the `KEEL_VAULT_*` environment into a config. Fail-closed (ADR-0023): with
 * `KEEL_VAULT_ADDR` set, a missing path or missing auth throws here rather than falling back to the
 * environment. The cache TTL comes from the shared `KEEL_SECRET_CACHE_TTL_SECONDS` (ADR-0024).
 */
function resolveConfig(env: NodeJS.ProcessEnv): OpenBaoConfig {
  const addr = trimmed(env['KEEL_VAULT_ADDR']);
  if (addr === undefined) {
    throw new Error('OpenBaoSecretProvider: KEEL_VAULT_ADDR is required');
  }
  const path = trimmed(env['KEEL_VAULT_PATH']);
  if (path === undefined) {
    throw new Error('OpenBaoSecretProvider: KEEL_VAULT_PATH is required');
  }
  const token = trimmed(env['KEEL_VAULT_TOKEN']);
  const role = trimmed(env['KEEL_VAULT_ROLE']);
  if (token === undefined && role === undefined) {
    throw new Error(
      'OpenBaoSecretProvider: no auth configured (set KEEL_VAULT_TOKEN or KEEL_VAULT_ROLE)',
    );
  }
  return {
    addr: addr.replace(/\/+$/, ''),
    token,
    role,
    k8sMount: trimmed(env['KEEL_VAULT_K8S_MOUNT']) ?? DEFAULT_K8S_MOUNT,
    k8sJwtPath: trimmed(env['KEEL_VAULT_K8S_JWT_PATH']) ?? DEFAULT_K8S_JWT_PATH,
    mount: trimmed(env['KEEL_VAULT_MOUNT']) ?? DEFAULT_MOUNT,
    path,
    namespace: trimmed(env['KEEL_VAULT_NAMESPACE']),
    cacert: trimmed(env['KEEL_VAULT_CACERT']),
    ttlMs: resolveCacheTtlMs(env),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

interface HttpResponse {
  status: number;
  body: string;
}

/**
 * Perform one HTTP request. Uses the global `fetch` by default; when a CA PEM is supplied and the
 * target is https, uses node:https so `KEEL_VAULT_CACERT` can pin TLS verification (global fetch
 * offers no custom-CA hook without the undici Agent, which Node does not expose).
 */
async function httpRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | undefined,
  caPem: string | undefined,
  timeoutMs: number,
): Promise<HttpResponse> {
  const target = new URL(url);
  if (caPem !== undefined && target.protocol === 'https:') {
    return httpsWithCa(method, target, headers, body, caPem, timeoutMs);
  }
  // A hard deadline on the whole request: a wedged OpenBao that accepts the socket but never
  // responds aborts here rather than hanging init forever. AbortSignal.timeout fires a TimeoutError
  // (no token/secret in its message).
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, body: await res.text() };
}

function httpsWithCa(
  method: string,
  url: URL,
  headers: Record<string, string>,
  body: string | undefined,
  caPem: string,
  timeoutMs: number,
): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    // `timeout` arms a socket inactivity timer; node:https does not abort on its own, so on the
    // 'timeout' event we destroy the request, which surfaces as an 'error' and rejects below. The
    // message is deliberately generic (never echoes the token or any secret).
    const req = httpsRequest(url, { method, headers, ca: caPem, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('timeout', () => {
      req.destroy(new Error('OpenBaoSecretProvider: request timed out'));
    });
    req.on('error', reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The OpenBao {@link SecretLoader}: authenticates (static token or Kubernetes login), reads the KV v2
 * path, and returns the field map. Holds the token and Kubernetes lease across calls so the shared
 * cache core can re-invoke it every TTL. Proactively re-logs in before a near-expiry lease and
 * re-authenticates once on a 401/403 (ADR-0023).
 */
class OpenBaoLoader implements SecretLoader {
  readonly label = 'openbao';
  private readonly config: OpenBaoConfig;
  private token: string | undefined;
  // Epoch ms when a Kubernetes lease expires (0 = no lease / static token, never proactively renew).
  private leaseExpiresAt = 0;

  constructor(config: OpenBaoConfig) {
    this.config = config;
  }

  async load(): Promise<Record<string, unknown>> {
    if (this.token === undefined) {
      // First load: authenticate before the initial read.
      await this.authenticate();
    } else if (this.needsLeaseRenewal()) {
      // A background refresh inside the Kubernetes lease renewal window: re-login proactively so a
      // read never races the lease expiry.
      await this.authenticate();
    }
    return this.readFieldMap();
  }

  private needsLeaseRenewal(): boolean {
    return (
      this.config.role !== undefined &&
      this.leaseExpiresAt > 0 &&
      Date.now() >= this.leaseExpiresAt - LEASE_RENEW_SKEW_MS
    );
  }

  private baseHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.token !== undefined) {
      headers['X-Vault-Token'] = this.token;
    }
    if (this.config.namespace !== undefined) {
      headers['X-Vault-Namespace'] = this.config.namespace;
    }
    return headers;
  }

  /** Resolve a client token per ADR-0023: static token verbatim, else Kubernetes login. */
  private async authenticate(): Promise<void> {
    if (this.config.token !== undefined) {
      this.token = this.config.token;
      this.leaseExpiresAt = 0;
      return;
    }
    // role is guaranteed by resolveConfig when token is absent.
    const jwt = (await readFile(this.config.k8sJwtPath, 'utf8')).trim();
    const url = `${this.config.addr}/v1/auth/${this.config.k8sMount}/login`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.namespace !== undefined) {
      headers['X-Vault-Namespace'] = this.config.namespace;
    }
    const res = await httpRequest(
      'POST',
      url,
      headers,
      JSON.stringify({ role: this.config.role, jwt }),
      this.config.cacert,
      this.config.timeoutMs,
    );
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`OpenBaoSecretProvider: Kubernetes login failed (HTTP ${res.status})`);
    }
    const auth = asRecord(asRecord(parseJson(res.body))?.['auth']);
    const clientToken = auth?.['client_token'];
    if (typeof clientToken !== 'string' || clientToken.length === 0) {
      throw new Error('OpenBaoSecretProvider: Kubernetes login response had no client_token');
    }
    this.token = clientToken;
    const lease = auth?.['lease_duration'];
    this.leaseExpiresAt = typeof lease === 'number' && lease > 0 ? Date.now() + lease * 1000 : 0;
  }

  /** Read the KV v2 path into a field map, re-authenticating once on 401/403 (ADR-0023). */
  private async readFieldMap(): Promise<Record<string, unknown>> {
    let res = await this.readPath();
    if (res.status === 401 || res.status === 403) {
      // The token was rejected (expired lease, rotated token). Re-login and retry once; a static
      // token cannot be renewed, so a second rejection surfaces as an error below.
      await this.authenticate();
      res = await this.readPath();
    }
    if (res.status === 404) {
      // No secret at the path: an empty field map, every get() is absent - the same as an empty env.
      return {};
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `OpenBaoSecretProvider: read ${this.config.path} failed (HTTP ${res.status})`,
      );
    }
    const data = asRecord(asRecord(parseJson(res.body))?.['data'])?.['data'];
    return asRecord(data) ?? {};
  }

  private readPath(): Promise<HttpResponse> {
    const url = `${this.config.addr}/v1/${this.config.mount}/data/${this.config.path}`;
    return httpRequest(
      'GET',
      url,
      this.baseHeaders(),
      undefined,
      this.config.cacert,
      this.config.timeoutMs,
    );
  }
}

/**
 * Static KV v2 SecretProvider backed by OpenBao/Vault (ADR-0023), over the shared caching core
 * (ADR-0024). Construct via {@link createOpenBaoSecretProvider}, which awaits the first field-map
 * load before the provider is used; `get()` then reads synchronously from the in-memory cache and
 * performs no I/O.
 */
export class OpenBaoSecretProvider extends CachingSecretProvider {
  constructor(config: OpenBaoConfig, logger: SecretProviderLogger) {
    super(new OpenBaoLoader(config), { ttlMs: config.ttlMs, logger });
  }
}

async function resolveCaPem(config: OpenBaoConfig): Promise<OpenBaoConfig> {
  if (config.cacert === undefined || config.cacert.includes('-----BEGIN')) {
    return config;
  }
  // A path rather than an inline PEM: read the certificate file.
  const cacert = await readFile(config.cacert, 'utf8');
  return { ...config, cacert };
}

/**
 * Async factory for the OpenBao provider (ADR-0023): authenticate, load the KV v2 field map, and
 * await that first load so the returned provider's synchronous `get()` reads a warm cache. A
 * misconfiguration or an unreachable/denying server rejects here (fail-closed), never falling back
 * to the environment. Call `close()` on the returned provider at shutdown.
 */
export async function createOpenBaoSecretProvider(
  env: NodeJS.ProcessEnv = process.env,
  options: OpenBaoOptions = {},
): Promise<OpenBaoSecretProvider> {
  const resolved = await resolveCaPem(resolveConfig(env));
  const config: OpenBaoConfig =
    options.timeoutMs !== undefined ? { ...resolved, timeoutMs: options.timeoutMs } : resolved;
  const logger = options.logger ?? createLogger('info');
  const provider = new OpenBaoSecretProvider(config, logger);
  await provider.init();
  return provider;
}

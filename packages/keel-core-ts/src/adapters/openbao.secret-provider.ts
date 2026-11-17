// OpenBao (Vault KV v2) SecretProvider adapter (ADR-0023). The SecretProvider port's `get` is
// synchronous in every vertical and Node cannot do synchronous HTTP, so `get()` must never perform
// I/O: the adapter authenticates and loads the KV v2 field map into memory once at init (awaited by
// the async factory below), then serves `get()` synchronously from that cache. A background refresh
// re-reads the path every TTL; a transient outage keeps serving the last good field map.
//
// The identical Vault HTTP API serves OpenBao and HashiCorp Vault, so this one adapter covers
// either endpoint. Token and Kubernetes auth only (ADR-0023); no vault SDK dependency - the client
// is a few `fetch` calls over the global fetch (Node 24+). `KEEL_VAULT_CACERT` is honored via a
// node:https request (global fetch cannot take a custom CA without the undici Agent, which Node does
// not expose as an importable module).
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';

import { createLogger } from '../logging/logger.js';
import type { SecretProvider } from '../ports/index.js';
import { EnvSecretProvider } from './index.js';

/** Minimal structured logger surface used for refresh diagnostics (pino's Logger satisfies it). */
export interface SecretProviderLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** Optional construction seams (a logger for refresh diagnostics); all have production defaults. */
export interface OpenBaoOptions {
  logger?: SecretProviderLogger;
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
}

const DEFAULT_K8S_MOUNT = 'kubernetes';
const DEFAULT_K8S_JWT_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const DEFAULT_MOUNT = 'secret';
const DEFAULT_TTL_SECONDS = 60;
// Re-login this many ms before a Kubernetes lease expires, so a refresh never races the expiry.
const LEASE_RENEW_SKEW_MS = 10_000;

function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Resolve and validate the `KEEL_VAULT_*` environment into a config. Fail-closed (ADR-0023): with
 * `KEEL_VAULT_ADDR` set, a missing path or missing auth throws here rather than falling back to the
 * environment.
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
  const ttlRaw = trimmed(env['KEEL_VAULT_CACHE_TTL_SECONDS']);
  const ttlSeconds = ttlRaw !== undefined ? Number(ttlRaw) : DEFAULT_TTL_SECONDS;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(
      'OpenBaoSecretProvider: KEEL_VAULT_CACHE_TTL_SECONDS must be a positive number',
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
    ttlMs: Math.round(ttlSeconds * 1000),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
): Promise<HttpResponse> {
  const target = new URL(url);
  if (caPem !== undefined && target.protocol === 'https:') {
    return httpsWithCa(method, target, headers, body, caPem);
  }
  const res = await fetch(url, { method, headers, body });
  return { status: res.status, body: await res.text() };
}

function httpsWithCa(
  method: string,
  url: URL,
  headers: Record<string, string>,
  body: string | undefined,
  caPem: string,
): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    const req = httpsRequest(url, { method, headers, ca: caPem }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

/**
 * Static KV v2 SecretProvider backed by OpenBao/Vault (ADR-0023). Construct via
 * {@link createOpenBaoSecretProvider}, which awaits the first field-map load before the provider is
 * used; `get()` then reads synchronously from the in-memory cache and performs no I/O.
 */
export class OpenBaoSecretProvider implements SecretProvider {
  private readonly config: OpenBaoConfig;
  private readonly logger: SecretProviderLogger;
  private fields: Record<string, unknown> = {};
  private token: string | undefined;
  // Epoch ms when a Kubernetes lease expires (0 = no lease / static token, never proactively renew).
  private leaseExpiresAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(config: OpenBaoConfig, logger: SecretProviderLogger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Authenticate and load the field map once, then start the background TTL refresh. Awaited by the
   * factory so the provider is fully warmed before first use; a load failure rejects (fail-closed).
   */
  async init(): Promise<void> {
    await this.authenticate();
    await this.load();
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.config.ttlMs);
    // Do not keep the event loop (and thus the process) alive just for the refresh ticker.
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  get(key: string): string | undefined {
    const value = this.fields[key];
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    return undefined;
  }

  /** Stop the background refresh. Idempotent; call at shutdown so the process can exit cleanly. */
  close(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Alias for {@link close}, for callers that dispose resources by convention. */
  dispose(): void {
    this.close();
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

  /** Read the KV v2 path into the cache, re-authenticating once on 401/403 (ADR-0023). */
  private async load(): Promise<void> {
    let res = await this.readPath();
    if (res.status === 401 || res.status === 403) {
      // The token was rejected (expired lease, rotated token). Re-login and retry once; a static
      // token cannot be renewed, so a second rejection surfaces as an error below.
      await this.authenticate();
      res = await this.readPath();
    }
    if (res.status === 404) {
      // No secret at the path: an empty field map, every get() is absent - the same as an empty env.
      this.fields = {};
      return;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `OpenBaoSecretProvider: read ${this.config.path} failed (HTTP ${res.status})`,
      );
    }
    const data = asRecord(asRecord(parseJson(res.body))?.['data'])?.['data'];
    this.fields = asRecord(data) ?? {};
  }

  private readPath(): Promise<HttpResponse> {
    const url = `${this.config.addr}/v1/${this.config.mount}/data/${this.config.path}`;
    return httpRequest('GET', url, this.baseHeaders(), undefined, this.config.cacert);
  }

  /**
   * Background refresh: proactively re-login a near-expiry Kubernetes lease, then reload. On failure
   * the last good field map continues to serve and the error is logged (a transient outage does not
   * take the service down).
   */
  private async refresh(): Promise<void> {
    try {
      if (
        this.config.role !== undefined &&
        this.leaseExpiresAt > 0 &&
        Date.now() >= this.leaseExpiresAt - LEASE_RENEW_SKEW_MS
      ) {
        await this.authenticate();
      }
      await this.load();
    } catch (err) {
      this.logger.warn(
        { path: this.config.path, err: err instanceof Error ? err.message : String(err) },
        'OpenBao secret refresh failed; serving last good field map',
      );
    }
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
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
  const config = await resolveCaPem(resolveConfig(env));
  const logger = options.logger ?? createLogger('info');
  const provider = new OpenBaoSecretProvider(config, logger);
  await provider.init();
  return provider;
}

/**
 * Select the SecretProvider from the environment (ADR-0023 gating): the OpenBao provider when
 * `KEEL_VAULT_ADDR` is set (fail-closed), otherwise the dev `EnvSecretProvider`. The SECRET_PROVIDER
 * DI token is bound by the service composition root; this factory is what that root calls.
 */
export async function secretProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: OpenBaoOptions = {},
): Promise<SecretProvider> {
  if (trimmed(env['KEEL_VAULT_ADDR']) !== undefined) {
    return createOpenBaoSecretProvider(env, options);
  }
  return new EnvSecretProvider(env);
}

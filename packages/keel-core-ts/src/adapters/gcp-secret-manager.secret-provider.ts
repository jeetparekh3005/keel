// GCP Secret Manager SecretProvider adapter (ADR-0024), over the shared caching core. A single
// configured secret (`KEEL_GCP_SECRET`) holds a JSON object; `get(name)` returns field `name`
// coerced per ADR-0023. The loader calls the official `@google-cloud/secret-manager`
// (AccessSecretVersion) rather than hand-rolling OAuth2 - ADR-0024 decision 1 deliberately reverses
// the ADR-0023 thin-client rule because the SDK is exactly what resolves Application Default
// Credentials (env, Workload Identity, metadata server) correctly. No keel-managed credentials: ADC
// supplies them.
import { createLogger } from '../logging/logger.js';
import {
  asRecord,
  CachingSecretProvider,
  resolveCacheTtlMs,
  type SecretLoader,
  type SecretProviderLogger,
  trimmed,
} from './caching-secret-provider.js';

// Bound a wedged or unreachable Secret Manager endpoint (or a degraded ADC/metadata lookup) so the
// eager startup load - the factory below awaits the first AccessSecretVersion - cannot hang forever.
// This mirrors the AWS adapter's bounded-client rule: `timeout` caps the per-call deadline and
// `maxRetries` caps SDK retries so a persistent failure fails fast (fail-closed) instead of
// multiplying the deadline. Passed as gax CallOptions on every AccessSecretVersion call.
export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_RETRIES = 2;

/**
 * The gax `CallOptions` subset the loader pins on every AccessSecretVersion call: a hard per-call
 * timeout and a retry cap. The real `SecretManagerServiceClient` accepts a superset (full
 * `CallOptions`), so it satisfies {@link GcpSecretAccessor}.
 */
export interface GcpCallOptions {
  timeout: number;
  maxRetries: number;
}

/**
 * The narrow seam over `@google-cloud/secret-manager`'s `SecretManagerServiceClient` that the loader
 * needs: access one secret version with bounded call options, and close the gRPC channel at
 * shutdown. The real client structurally satisfies this; unit tests inject a hermetic mock so no
 * network, metadata-server, or ADC lookup happens.
 */
export interface GcpSecretAccessor {
  accessSecretVersion(
    request: { name: string },
    options: GcpCallOptions,
  ): Promise<
    [{ payload?: { data?: Uint8Array | Buffer | string | null } | null } | undefined, ...unknown[]]
  >;
  close?(): Promise<void> | void;
}

/** Optional construction seams (a logger for refresh diagnostics); all have production defaults. */
export interface GcpSecretManagerOptions {
  logger?: SecretProviderLogger;
}

/** Resolved, validated GCP Secret Manager configuration (the `KEEL_GCP_*` surface from ADR-0024). */
interface GcpConfig {
  // The fully-qualified secret version resource name (`projects/<p>/secrets/<n>/versions/<v>`).
  versionName: string;
  ttlMs: number;
}

// gRPC NOT_FOUND status code (google.rpc.Code.NOT_FOUND) - no such secret/version.
const GRPC_NOT_FOUND = 5;

/**
 * Resolve the `KEEL_GCP_*` environment into a config. `KEEL_GCP_SECRET` gates the backend: either a
 * secret resource name (`projects/<p>/secrets/<n>`), to which `KEEL_GCP_SECRET_VERSION` (default
 * `latest`) is appended, or a full version resource name (`.../versions/<v>`), used verbatim. The
 * cache TTL comes from the shared `KEEL_SECRET_CACHE_TTL_SECONDS`.
 */
function resolveConfig(env: NodeJS.ProcessEnv): GcpConfig {
  const secret = trimmed(env['KEEL_GCP_SECRET']);
  if (secret === undefined) {
    throw new Error('GcpSecretManagerSecretProvider: KEEL_GCP_SECRET is required');
  }
  // Already a version resource name -> use as-is; otherwise trim any trailing slash(es) before
  // appending the (defaulted) version so a `KEEL_GCP_SECRET` like `projects/p/secrets/app/` cannot
  // yield a malformed `.../app//versions/latest` that GCP rejects (parity with Go and Rust).
  const versionName = secret.includes('/versions/')
    ? secret
    : `${secret.replace(/\/+$/, '')}/versions/${trimmed(env['KEEL_GCP_SECRET_VERSION']) ?? 'latest'}`;
  return { versionName, ttlMs: resolveCacheTtlMs(env) };
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** Decode the payload bytes to a UTF-8 string; a string payload (REST transport) passes through. */
function decodePayload(data: Uint8Array | Buffer | string | null | undefined): string | undefined {
  if (data === null || data === undefined) {
    return undefined;
  }
  if (typeof data === 'string') {
    return data;
  }
  return Buffer.from(data).toString('utf8');
}

/**
 * The GCP Secret Manager {@link SecretLoader}: `AccessSecretVersion`, decode `payload.data` (UTF-8),
 * then parse it as a JSON object into the field map (ADR-0023 coercion applied later by the core).
 * Unlike OpenBao this loader carries no token-lease logic - the SDK refreshes credentials internally
 * and the core simply re-invokes it every TTL. Fail-closed (ADR-0024): a missing payload or a
 * non-object/malformed/binary JSON payload throws (without echoing the payload), since a secret
 * meant to back `get(name)` must be a JSON object of fields; a `NOT_FOUND` (code 5) returns an empty
 * map (all absent), mirroring Vault's 404-as-empty.
 */
class GcpSecretManagerLoader implements SecretLoader {
  readonly label = 'gcp-secret-manager';
  private readonly client: GcpSecretAccessor;
  private readonly versionName: string;

  constructor(client: GcpSecretAccessor, versionName: string) {
    this.client = client;
    this.versionName = versionName;
  }

  async load(): Promise<Record<string, unknown>> {
    let payloadData: Uint8Array | Buffer | string | null | undefined;
    try {
      const [response] = await this.client.accessSecretVersion(
        { name: this.versionName },
        { timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES },
      );
      payloadData = response?.payload?.data;
    } catch (err) {
      if (
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: unknown }).code === GRPC_NOT_FOUND
      ) {
        // No such secret/version: an empty field map, every get() absent - the same as Vault's 404.
        return {};
      }
      throw err;
    }
    const body = decodePayload(payloadData);
    if (body === undefined) {
      // A version with no payload data has nothing to parse into a field map (fail-closed).
      throw new Error('GcpSecretManagerSecretProvider: secret version has no payload data');
    }
    const fields = asRecord(parseJson(body));
    if (fields === undefined) {
      // Not a JSON object (a bare scalar, array, null, malformed, or non-UTF-8 binary): a secret
      // meant to back get(name) must be a JSON object of fields. The payload is never echoed.
      throw new Error(
        'GcpSecretManagerSecretProvider: secret payload is not a JSON object of fields',
      );
    }
    return fields;
  }
}

/**
 * JSON-field-map SecretProvider backed by GCP Secret Manager (ADR-0024), over the shared caching
 * core. Construct via {@link createGcpSecretManagerSecretProvider}, which awaits the first load so
 * `get()` reads a warm cache and performs no I/O. `close()` stops the refresh ticker and closes the
 * SDK's gRPC channel so the process can exit cleanly.
 */
export class GcpSecretManagerSecretProvider extends CachingSecretProvider {
  private readonly client: GcpSecretAccessor;

  constructor(
    client: GcpSecretAccessor,
    versionName: string,
    ttlMs: number,
    logger: SecretProviderLogger,
  ) {
    super(new GcpSecretManagerLoader(client, versionName), { ttlMs, logger });
    this.client = client;
  }

  override close(): void {
    super.close();
    // The gRPC client keeps channels (and the event loop) alive until closed. Fire-and-forget; a
    // close error is irrelevant at shutdown.
    void this.client.close?.();
  }
}

/**
 * Async factory for the GCP Secret Manager provider (ADR-0024): build the SDK client (ADC credential
 * chain), load the field map, and await that first load so the returned provider's synchronous
 * `get()` reads a warm cache. An auth failure, permission denial, or malformed payload rejects here
 * (fail-closed), never falling back to the environment. Call `close()` on the returned provider at
 * shutdown.
 */
export async function createGcpSecretManagerSecretProvider(
  env: NodeJS.ProcessEnv = process.env,
  options: GcpSecretManagerOptions = {},
): Promise<GcpSecretManagerSecretProvider> {
  const config = resolveConfig(env);
  // Dynamic import so the GCP SDK is only loaded when this backend is actually selected, keeping its
  // gRPC/metadata machinery out of a service that never uses it.
  const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
  const client: GcpSecretAccessor = new SecretManagerServiceClient();
  const logger = options.logger ?? createLogger('info');
  const provider = new GcpSecretManagerSecretProvider(
    client,
    config.versionName,
    config.ttlMs,
    logger,
  );
  await provider.init();
  return provider;
}

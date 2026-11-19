// AWS Secrets Manager SecretProvider adapter (ADR-0024), over the shared caching core. A single
// configured secret (`KEEL_AWS_SECRET_ID`) holds a JSON object; `get(name)` returns field `name`
// coerced per ADR-0023. The loader calls the official `@aws-sdk/client-secrets-manager`
// (GetSecretValue) rather than hand-rolling SigV4 - ADR-0024 decision 1 deliberately reverses the
// ADR-0023 thin-client rule because the SDK is exactly what signs requests and resolves the IRSA /
// instance-profile / SSO credential chain correctly. The SDK honors `AWS_ENDPOINT_URL_SECRETS_MANAGER`
// (LocalStack in dev/CI), so no custom-endpoint knob is exposed. No keel-managed credentials: the
// default AWS provider chain supplies them.
import {
  GetSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { NodeHttpHandler } from '@smithy/node-http-handler';

import { createLogger } from '../logging/logger.js';
import {
  asRecord,
  CachingSecretProvider,
  resolveCacheTtlMs,
  type SecretLoader,
  type SecretProviderLogger,
  trimmed,
} from './caching-secret-provider.js';

// Bound a wedged or unreachable Secrets Manager endpoint so the eager startup load - the factory
// below awaits the first GetSecretValue - cannot hang forever. This mirrors ADR-0023's hard-HTTP-
// timeout rule as applied to the OpenBao adapter: connectionTimeout bounds the TCP/TLS connect,
// requestTimeout bounds time-to-first-byte, and maxAttempts caps SDK retries so a persistent failure
// fails fast (fail-closed) instead of multiplying the deadline.
const CONNECTION_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_ATTEMPTS = 2;

/** Optional construction seams (a logger for refresh diagnostics); all have production defaults. */
export interface AwsSecretsManagerOptions {
  logger?: SecretProviderLogger;
}

/** Resolved, validated AWS Secrets Manager configuration (the `KEEL_AWS_*` surface from ADR-0024). */
interface AwsConfig {
  secretId: string;
  region?: string;
  ttlMs: number;
}

/**
 * Resolve the `KEEL_AWS_*` environment into a config. `KEEL_AWS_SECRET_ID` gates the backend (a
 * secret name or ARN); `KEEL_AWS_REGION` is optional (else the SDK's own region resolution). The
 * cache TTL comes from the shared `KEEL_SECRET_CACHE_TTL_SECONDS`.
 */
function resolveConfig(env: NodeJS.ProcessEnv): AwsConfig {
  const secretId = trimmed(env['KEEL_AWS_SECRET_ID']);
  if (secretId === undefined) {
    throw new Error('AwsSecretsManagerSecretProvider: KEEL_AWS_SECRET_ID is required');
  }
  return {
    secretId,
    region: trimmed(env['KEEL_AWS_REGION']),
    ttlMs: resolveCacheTtlMs(env),
  };
}

/**
 * The AWS Secrets Manager {@link SecretLoader}: `GetSecretValue`, then parse `SecretString` as a JSON
 * object into the field map (ADR-0023 coercion applied later by the core). Unlike OpenBao this loader
 * carries no token-lease logic - the SDK refreshes credentials internally and the core simply
 * re-invokes it every TTL. Fail-closed (ADR-0024): a `SecretBinary`-only secret or a non-object JSON
 * payload throws, since a secret meant to back `get(name)` must be a JSON object of fields; a
 * `ResourceNotFoundException` returns an empty map (all absent), mirroring Vault's 404-as-empty.
 */
class AwsSecretsManagerLoader implements SecretLoader {
  readonly label = 'aws-secrets-manager';
  private readonly client: SecretsManagerClient;
  private readonly secretId: string;

  constructor(client: SecretsManagerClient, secretId: string) {
    this.client = client;
    this.secretId = secretId;
  }

  async load(): Promise<Record<string, unknown>> {
    let secretString: string | undefined;
    try {
      const res = await this.client.send(new GetSecretValueCommand({ SecretId: this.secretId }));
      secretString = res.SecretString;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) {
        // No such secret: an empty field map, every get() is absent - the same as Vault's 404.
        return {};
      }
      throw err;
    }
    if (secretString === undefined) {
      // A SecretBinary-only secret has no string payload to parse into a field map (fail-closed).
      throw new Error(
        'AwsSecretsManagerSecretProvider: secret has no SecretString (SecretBinary is not supported)',
      );
    }
    const fields = asRecord(parseJson(secretString));
    if (fields === undefined) {
      // The payload is not a JSON object (a bare scalar, array, null, or malformed): a secret meant
      // to back get(name) must be a JSON object of fields.
      throw new Error(
        'AwsSecretsManagerSecretProvider: SecretString is not a JSON object of fields',
      );
    }
    return fields;
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * JSON-field-map SecretProvider backed by AWS Secrets Manager (ADR-0024), over the shared caching
 * core. Construct via {@link createAwsSecretsManagerSecretProvider}, which awaits the first load so
 * `get()` reads a warm cache and performs no I/O.
 */
export class AwsSecretsManagerSecretProvider extends CachingSecretProvider {
  constructor(
    client: SecretsManagerClient,
    secretId: string,
    ttlMs: number,
    logger: SecretProviderLogger,
  ) {
    super(new AwsSecretsManagerLoader(client, secretId), { ttlMs, logger });
  }
}

/**
 * Async factory for the AWS Secrets Manager provider (ADR-0024): build the SDK client (region from
 * `KEEL_AWS_REGION` or the SDK default; default credential chain), load the field map, and await
 * that first load so the returned provider's synchronous `get()` reads a warm cache. An auth
 * failure, permission denial, or malformed payload rejects here (fail-closed), never falling back to
 * the environment. Call `close()` on the returned provider at shutdown.
 */
export async function createAwsSecretsManagerSecretProvider(
  env: NodeJS.ProcessEnv = process.env,
  options: AwsSecretsManagerOptions = {},
): Promise<AwsSecretsManagerSecretProvider> {
  const config = resolveConfig(env);
  // region undefined -> let the SDK resolve it (env, shared config, instance metadata). The bounded
  // request handler and capped retries keep an unreachable endpoint from hanging the awaited first load.
  const client = new SecretsManagerClient({
    ...(config.region !== undefined ? { region: config.region } : {}),
    requestHandler: new NodeHttpHandler({
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
    }),
    maxAttempts: MAX_ATTEMPTS,
  });
  const logger = options.logger ?? createLogger('info');
  const provider = new AwsSecretsManagerSecretProvider(
    client,
    config.secretId,
    config.ttlMs,
    logger,
  );
  await provider.init();
  return provider;
}

import { csvList, loadConfig } from '@keel/core';
import { z } from 'zod';

/**
 * The typed, KEEL_-prefixed service configuration (platform.yaml config: typed, fail-fast).
 * Secure by default: environment defaults to production. Mirrors the Go vertical's
 * ReferenceConfig.
 */
export const referenceConfigSchema = z.object({
  SERVICE_NAME: z.string().default('reference-service-nest'),
  VERSION: z.string().default('0.0.0'),
  ENVIRONMENT: z.string().default('production'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().default('postgres://localhost/keel'),
  OIDC_ISSUER: z.string().default(''),
  OIDC_AUDIENCE: z.string().default(''),
  OIDC_JWKS_URI: z.string().default(''),
  OTLP_ENDPOINT: z.string().default(''),
  PORT: z.coerce.number().default(8000),
  MAX_BODY_BYTES: z.coerce.number().default(1024 * 1024),
  CORS_ALLOW_ORIGINS: csvList(),
});

export type ReferenceConfig = z.infer<typeof referenceConfigSchema>;

/** DI token for the loaded service configuration. */
export const REFERENCE_CONFIG = Symbol('reference.Config');

/** Load ReferenceConfig from the KEEL_-prefixed environment (fail-fast). */
export function loadReferenceConfig(env?: NodeJS.ProcessEnv): ReferenceConfig {
  return loadConfig(referenceConfigSchema, env);
}

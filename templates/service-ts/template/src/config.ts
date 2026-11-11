import { csvList, loadConfig } from '@keel/core';
import { z } from 'zod';

/**
 * The typed, KEEL_-prefixed service configuration (platform.yaml config: typed, fail-fast).
 * Secure by default: environment defaults to production. Mirrors the Go vertical's
 * ServiceConfig.
 */
export const serviceConfigSchema = z.object({
  SERVICE_NAME: z.string().default('@< service_slug >@'),
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

export type ServiceConfig = z.infer<typeof serviceConfigSchema>;

/** DI token for the loaded service configuration. */
export const SERVICE_CONFIG = Symbol('service.Config');

/** Load ServiceConfig from the KEEL_-prefixed environment (fail-fast). */
export function loadServiceConfig(env?: NodeJS.ProcessEnv): ServiceConfig {
  return loadConfig(serviceConfigSchema, env);
}

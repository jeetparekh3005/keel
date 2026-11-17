// SecretProvider selection (ADR-0024 decision 5). The composition root calls this async factory to
// bind the SECRET_PROVIDER DI token. At most one backend may be gated: `KEEL_VAULT_ADDR` (OpenBao),
// `KEEL_AWS_SECRET_ID` (AWS Secrets Manager). More than one set is an ambiguous misconfiguration
// that fails construction (fail-closed); none set -> the dev `EnvSecretProvider`.
import type { SecretProvider } from '../ports/index.js';
import {
  type AwsSecretsManagerOptions,
  createAwsSecretsManagerSecretProvider,
} from './aws-secrets-manager.secret-provider.js';
import { trimmed } from './caching-secret-provider.js';
import { EnvSecretProvider } from './index.js';
import { createOpenBaoSecretProvider, type OpenBaoOptions } from './openbao.secret-provider.js';

/** Construction seams passed through to whichever backend is selected. */
export type SecretProviderFromEnvOptions = OpenBaoOptions & AwsSecretsManagerOptions;

/**
 * Select the SecretProvider from the environment (ADR-0024 gating). Exactly one of the gating vars
 * selects its backend (fail-closed); two or more reject ("multiple secret backends configured");
 * none selects the environment-backed dev provider. The SECRET_PROVIDER DI token is bound by the
 * service composition root; this factory is what that root calls.
 */
export async function secretProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: SecretProviderFromEnvOptions = {},
): Promise<SecretProvider> {
  const vault = trimmed(env['KEEL_VAULT_ADDR']);
  const aws = trimmed(env['KEEL_AWS_SECRET_ID']);
  const configured = [vault, aws].filter((v) => v !== undefined);
  if (configured.length > 1) {
    throw new Error(
      'secretProviderFromEnv: multiple secret backends configured (set at most one of KEEL_VAULT_ADDR, KEEL_AWS_SECRET_ID)',
    );
  }
  if (vault !== undefined) {
    return createOpenBaoSecretProvider(env, options);
  }
  if (aws !== undefined) {
    return createAwsSecretsManagerSecretProvider(env, options);
  }
  return new EnvSecretProvider(env);
}

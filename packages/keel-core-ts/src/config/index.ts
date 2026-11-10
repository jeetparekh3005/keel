// Typed, KEEL_-prefixed, 12-factor configuration (platform.yaml config: typed, fail-fast).
// A zod schema is the single source of truth for the shape and coercion; a missing required
// value or a type error fails fast with an Internal DomainError (detail is server-side only).
// Secret access is a separate concern (the SecretProvider port); config loads only the
// non-secret typed values.
import { z } from 'zod';

import { DomainError, ErrorCategory } from '../domain/errors.js';

/**
 * Parse the KEEL_-prefixed environment into the schema's type. Every `KEEL_FOO` variable is
 * exposed to the schema under the key `FOO` (the prefix is stripped), mirroring the Go
 * vertical's `env:"FOO"` tags. Fails fast: an invalid or missing required value throws an
 * Internal DomainError whose detail is logged server-side, never returned to a client.
 */
export function loadConfig<T>(schema: z.ZodType<T>, env: NodeJS.ProcessEnv = process.env): T {
  const raw: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('KEEL_') && value !== undefined) {
      raw[key.slice('KEEL_'.length)] = value;
    }
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new DomainError(ErrorCategory.Internal, `config: ${issues}`);
  }
  return result.data;
}

/**
 * A comma-separated environment value parsed into a trimmed, non-empty string list. Empty or
 * unset yields []. Used for list-valued config such as CORS allow-origins (deny-by-default
 * when empty), matching the Go vertical's `envSeparator:","`.
 */
export function csvList(): z.ZodType<string[]> {
  return z
    .string()
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    );
}

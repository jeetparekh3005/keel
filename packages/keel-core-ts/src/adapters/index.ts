// Production implementations of the driven ports: a system clock and an environment-backed
// secret provider (the dev adapter; production uses a real secret manager, ADR-0007).
import type { Clock, SecretProvider } from '../ports/index.js';

/** The real wall clock. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Reads secrets from environment variables. */
export class EnvSecretProvider implements SecretProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  get(key: string): string | undefined {
    const value = this.env[key];
    return value !== undefined && value !== '' ? value : undefined;
  }
}

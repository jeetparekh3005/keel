// In-memory fakes for the driven ports plus, via the ../conformance subpackage, the
// behavioral contract suite a service runs against its own app. Shipped so every vertical can
// test by contract (ADR-0009 Tier 1).
import { type Authenticator, Principal } from '../auth/principal.js';
import { DomainError, ErrorCategory } from '../domain/errors.js';
import type { Clock, SecretProvider } from '../ports/index.js';

/** A Clock frozen at a fixed instant. */
export class FrozenClock implements Clock {
  constructor(private readonly instant: Date) {}

  now(): Date {
    return this.instant;
  }
}

/** A map-backed SecretProvider. */
export class InMemorySecretProvider implements SecretProvider {
  constructor(private readonly secrets: Record<string, string> = {}) {}

  get(key: string): string | undefined {
    return this.secrets[key];
  }
}

/** Maps known tokens to principals; anything else is rejected. For wiring tests without an IdP. */
export class StubAuthenticator implements Authenticator {
  constructor(private readonly principals: Record<string, Principal> = {}) {}

  authenticate(credential: string): Promise<Principal> {
    const principal = this.principals[credential];
    if (!principal) {
      return Promise.reject(new DomainError(ErrorCategory.Unauthenticated, 'invalid token'));
    }
    return Promise.resolve(principal);
  }
}

/** Build a test principal with the given subject and scopes. */
export function principal(subject: string, ...scopes: string[]): Principal {
  return new Principal(subject, scopes);
}

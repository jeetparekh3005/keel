// The authentication/authorization port and its OIDC adapter plus the deny-by-default guard.
// A verified caller becomes a Principal; routes enforce scopes. Mirrors the Go auth package.

/** An authenticated caller: a subject plus the scopes and roles it holds. */
export class Principal {
  readonly scopes: ReadonlySet<string>;
  readonly roles: ReadonlySet<string>;

  constructor(
    readonly subject: string,
    scopes: Iterable<string> = [],
    roles: Iterable<string> = [],
  ) {
    this.scopes = new Set(scopes);
    this.roles = new Set(roles);
  }

  /** Whether the principal holds every scope in required. */
  hasScopes(...required: string[]): boolean {
    return required.every((scope) => this.scopes.has(scope));
  }

  /** Whether the principal holds role. */
  hasRole(role: string): boolean {
    return this.roles.has(role);
  }
}

/**
 * Verifies an opaque or bearer credential and returns the Principal. Implementations throw a
 * DomainError: Unauthenticated (401) for a bad/expired token, Unavailable (503) when the key
 * source cannot be reached.
 */
export interface Authenticator {
  authenticate(credential: string): Promise<Principal>;
}

/** DI token for the Authenticator port (verifies the bearer JWT path). */
export const AUTHENTICATOR = Symbol('keel.Authenticator');

/**
 * DI token for the optional Authenticator that verifies an X-API-Key credential. When a service
 * configures one, the guard routes an X-API-Key request to it; otherwise only the bearer path is
 * available. Kept distinct from AUTHENTICATOR so the two credential kinds verify independently.
 */
export const API_KEY_AUTHENTICATOR = Symbol('keel.ApiKeyAuthenticator');

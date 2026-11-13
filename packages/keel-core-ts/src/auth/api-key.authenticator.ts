import { createHash } from 'node:crypto';

import { DomainError, ErrorCategory } from '../domain/errors.js';
import { type Authenticator, Principal } from './principal.js';

/**
 * Return the SHA-256 hex digest used to store and look up an API key. Keys are kept hashed
 * (never plaintext) so a memory disclosure does not leak usable credentials; the presented key
 * is hashed and looked up. Mirrors the Python vertical's hash_api_key (ADR-0006).
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * An Authenticator backed by a fixed set of SHA-256 API-key hashes mapped to principals.
 * Verifies an opaque X-API-Key credential by hashing it and looking up the principal; an
 * unknown key is Unauthenticated (401). The verified Principal then flows through the same
 * deny-by-default guard and @Scopes checks as a bearer JWT. Keys/hashes should come from the
 * SecretProvider, not source. The TypeScript mirror of the Python ApiKeyAuthenticator.
 */
export class ApiKeyAuthenticator implements Authenticator {
  private readonly byHash: ReadonlyMap<string, Principal>;

  /** Initialize from a mapping of SHA-256 key hex digests to principals. */
  constructor(keyHashes: Record<string, Principal>) {
    this.byHash = new Map(Object.entries(keyHashes));
  }

  /**
   * Build from plaintext keys, hashing each immediately so no plaintext key is retained
   * (prefer sourcing hashes from secrets). Mirrors the Python from_keys classmethod.
   */
  static fromKeys(keys: Record<string, Principal>): ApiKeyAuthenticator {
    const hashed: Record<string, Principal> = {};
    for (const [key, principal] of Object.entries(keys)) {
      hashed[hashApiKey(key)] = principal;
    }
    return new ApiKeyAuthenticator(hashed);
  }

  /**
   * Return the principal for the presented API key, or reject with Unauthenticated (401) on a
   * miss. Lookup is by SHA-256 digest; because the key is high-entropy, the hashed lookup is
   * not a practical timing oracle for the key's contents.
   */
  authenticate(credential: string): Promise<Principal> {
    const principal = this.byHash.get(hashApiKey(credential));
    if (!principal) {
      return Promise.reject(new DomainError(ErrorCategory.Unauthenticated, 'invalid api key'));
    }
    return Promise.resolve(principal);
  }
}

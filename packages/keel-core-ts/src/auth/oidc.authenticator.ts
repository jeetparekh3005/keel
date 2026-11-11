import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

import { DomainError, ErrorCategory } from '../domain/errors.js';
import { type Authenticator, Principal } from './principal.js';

/**
 * Verifies RS256 bearer JWTs against an issuer's JWKS. The underlying jose RemoteJWKSet
 * fetches, caches, and refreshes the JWKS natively (including on an unknown kid), so
 * signing-key rotation is tolerated without a restart.
 */
export class OidcAuthenticator implements Authenticator {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    private readonly issuer: string,
    private readonly audience: string,
    jwksUri: string,
  ) {
    this.jwks = createRemoteJWKSet(new URL(jwksUri));
  }

  async authenticate(credential: string): Promise<Principal> {
    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(credential, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ['RS256'],
        // Require an expiry: a validly-signed token with no exp must not be accepted forever.
        requiredClaims: ['exp'],
      });
      payload = verified.payload;
    } catch (err) {
      throw classifyVerifyError(err);
    }

    const scopes = new Set<string>();
    for (const scope of splitScope(payload['scope'])) {
      scopes.add(scope);
    }
    for (const scope of parseScp(payload['scp'])) {
      scopes.add(scope);
    }

    const roles = new Set<string>();
    for (const role of asStringArray(payload['roles'])) {
      roles.add(role);
    }
    const realmAccess = payload['realm_access'];
    if (realmAccess && typeof realmAccess === 'object') {
      for (const role of asStringArray((realmAccess as Record<string, unknown>)['roles'])) {
        roles.add(role);
      }
    }

    return new Principal(payload.sub ?? '', scopes, roles);
  }
}

/** A space-delimited `scope` string split into tokens. */
function splitScope(value: unknown): string[] {
  return typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : [];
}

/**
 * `scp` as either a JSON array of strings (most IdPs) or a single space-delimited string
 * (Microsoft Entra / Azure AD).
 */
function parseScp(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value === 'string') {
    return value.split(/\s+/).filter(Boolean);
  }
  return [];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * Map a jose verification failure to the right domain category: a key-source outage (network
 * failure or timeout fetching the JWKS) is Unavailable (503); anything else (bad signature,
 * expired, wrong iss/aud, unknown kid) is Unauthenticated (401).
 */
const KEY_SOURCE_OUTAGE_CODES = new Set([
  'ERR_JWKS_TIMEOUT', // jose timed out fetching the JWKS
  'ERR_JOSE_GENERIC', // jose's catch-all: a non-200 JWKS response or unparsable body
  'ERR_JWKS_INVALID', // the JWKS document itself is malformed
]);

function classifyVerifyError(err: unknown): DomainError {
  const code = (err as { code?: string } | undefined)?.code;
  // A key-source outage (timeout, non-200/unparsable JWKS, a raw fetch TypeError with no jose
  // code) is Unavailable: the caller's token may be perfectly valid, so do not report 401 and
  // make clients discard good credentials. Everything else (bad signature, expired, missing
  // exp, wrong iss/aud, unknown kid) is a genuine auth failure.
  if (
    (code !== undefined && KEY_SOURCE_OUTAGE_CODES.has(code)) ||
    (code === undefined && err instanceof TypeError)
  ) {
    return new DomainError(ErrorCategory.Unavailable, 'signing-key source unavailable');
  }
  return new DomainError(ErrorCategory.Unauthenticated, 'invalid token');
}

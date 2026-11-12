// OidcAuthenticator against a real Keycloak (epic #419, v0.6 parity with the Python vertical's
// tests/test_keycloak_integration.py).
//
// Runs only when KEEL_KEYCLOAK_URL is set (CI imports deploy/keycloak/realm.json into a Keycloak
// container); skipped otherwise so a local `pnpm test` stays green without Keycloak. Mints a real
// service-account token via client_credentials and verifies it against the live JWKS through the
// real jose createRemoteJWKSet remote fetch (no stub, no checked-in JWT).

import { describe, expect, it } from 'vitest';

import { OidcAuthenticator } from './oidc.authenticator.js';

const keycloakUrl = process.env.KEEL_KEYCLOAK_URL;
const realm = process.env.KEEL_KEYCLOAK_REALM ?? 'keel';
const clientId = process.env.KEEL_KEYCLOAK_CLIENT_ID ?? 'keel-api';
const clientSecret = process.env.KEEL_KEYCLOAK_CLIENT_SECRET ?? 'test-secret';
const audience = process.env.KEEL_OIDC_AUDIENCE ?? 'keel-api';

function realmBase(): string {
  return `${keycloakUrl}/realms/${realm}`;
}

interface TokenResponse {
  access_token: string;
}

/** Mint a real service-account access token from Keycloak's token endpoint. */
async function mintToken(): Promise<string> {
  const resp = await fetch(`${realmBase()}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!resp.ok) {
    throw new Error(`token endpoint returned ${resp.status}: ${await resp.text()}`);
  }
  const body = (await resp.json()) as TokenResponse;
  return body.access_token;
}

/** Decode a JWT payload (base64url) without verifying - used only to cross-check the Principal. */
function decodePayload(token: string): Record<string, unknown> {
  const segment = token.split('.')[1];
  if (segment === undefined) {
    throw new Error('token is not a JWT');
  }
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe.skipIf(!keycloakUrl)('OidcAuthenticator (live Keycloak JWKS)', () => {
  it('verifies a real service-account token against the live JWKS', async () => {
    const token = await mintToken();

    // The real authenticator: issuer/audience matching the realm, JWKS fetched live by jose.
    const authenticator = new OidcAuthenticator(
      realmBase(),
      audience,
      `${realmBase()}/protocol/openid-connect/certs`,
    );

    const principal = await authenticator.authenticate(token);

    // Subject is the service-account user id; cross-check against the raw token's sub claim.
    const payload = decodePayload(token);
    expect(principal.subject).toBeTruthy();
    expect(principal.subject).toBe(payload['sub']);

    // The authenticator only returns a Principal when iss/aud matched the live token, so these
    // assert the real claims flowed through verification rather than being stubbed.
    expect(payload['iss']).toBe(realmBase());
    const aud = payload['aud'];
    const audiences = Array.isArray(aud) ? aud : [aud];
    expect(audiences).toContain(audience);

    // Every scope on the raw token must be reflected on the Principal.
    const rawScope = payload['scope'];
    const scopes = typeof rawScope === 'string' ? rawScope.split(/\s+/).filter(Boolean) : [];
    for (const scope of scopes) {
      expect(principal.scopes.has(scope)).toBe(true);
    }
  });

  it('rejects a tampered token against the live JWKS', async () => {
    const token = await mintToken();
    // Tamper the PAYLOAD segment so the RS256 signature (computed over header.payload) no longer
    // matches. Flipping the LAST signature character is unreliable: base64url's final char carries
    // padding bits, so some flips decode to the identical signature bytes and the token still
    // verifies (a flaky false pass). Changing a payload byte always invalidates the signature.
    const [header, payload, signature] = token.split('.');
    const flip = (c: string): string => (c === 'A' ? 'B' : 'A');
    const tampered = `${header}.${flip(payload.charAt(0)) + payload.slice(1)}.${signature}`;

    const authenticator = new OidcAuthenticator(
      realmBase(),
      audience,
      `${realmBase()}/protocol/openid-connect/certs`,
    );

    await expect(authenticator.authenticate(tampered)).rejects.toThrow();
  });
});

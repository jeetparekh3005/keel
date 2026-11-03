"""OIDC / JWT authenticator adapter (platform.yaml auth; ADR-0006).

Verifies a Bearer JWT against the issuer's signing key (JWKS in production),
checks issuer/audience/expiry, and maps claims to a Principal. Any failure
raises Unauthenticated; the domain never sees a raw token.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

import jwt

from keel_core.domain.errors import Unauthenticated
from keel_core.ports.auth import Principal

KeyResolver = Callable[[str], "str | bytes | jwt.PyJWK"]


def _scopes(claims: dict[str, object]) -> frozenset[str]:
    scope = claims.get("scope")
    if isinstance(scope, str):
        return frozenset(scope.split())
    scp = claims.get("scp")
    if isinstance(scp, list):
        return frozenset(str(item) for item in scp)
    return frozenset()


def _roles(claims: dict[str, object]) -> frozenset[str]:
    roles = claims.get("roles")
    if isinstance(roles, list):
        return frozenset(str(item) for item in roles)
    realm_access = claims.get("realm_access")
    if isinstance(realm_access, dict):
        realm_roles = realm_access.get("roles")
        if isinstance(realm_roles, list):
            return frozenset(str(item) for item in realm_roles)
    return frozenset()


class OIDCAuthenticator:
    """Validates OIDC JWTs and maps them to a Principal."""

    def __init__(
        self,
        *,
        issuer: str,
        audience: str,
        key_resolver: KeyResolver,
        algorithms: Sequence[str] = ("RS256",),
    ) -> None:
        """Configure issuer/audience, a signing-key resolver, and allowed algorithms."""
        self._issuer = issuer
        self._audience = audience
        self._key_resolver = key_resolver
        self._algorithms = list(algorithms)

    def authenticate(self, credential: str) -> Principal:
        """Verify ``credential`` (a JWT) and return the Principal, else raise Unauthenticated."""
        try:
            key = self._key_resolver(credential)
            claims: dict[str, object] = jwt.decode(
                credential,
                key,
                algorithms=self._algorithms,
                audience=self._audience,
                issuer=self._issuer,
                options={"require": ["exp", "iss", "aud", "sub"]},
            )
        except jwt.InvalidTokenError as exc:
            msg = "invalid token"
            raise Unauthenticated(msg) from exc
        subject = claims.get("sub")
        if not isinstance(subject, str):
            msg = "token missing subject"
            raise Unauthenticated(msg)
        return Principal(subject=subject, scopes=_scopes(claims), roles=_roles(claims))

    @classmethod
    def from_jwks(cls, *, jwks_uri: str, issuer: str, audience: str) -> OIDCAuthenticator:
        """Build an authenticator that fetches signing keys from a JWKS endpoint."""
        client = jwt.PyJWKClient(jwks_uri)

        def resolver(token: str) -> jwt.PyJWK:
            return client.get_signing_key_from_jwt(token)

        return cls(issuer=issuer, audience=audience, key_resolver=resolver)

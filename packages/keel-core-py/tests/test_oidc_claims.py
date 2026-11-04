"""OIDC claim-shape mapping for real IdPs (audit #65: scp / realm_access untested)."""

from datetime import UTC, datetime, timedelta

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from keel_core.adapters.outbound.auth import OIDCAuthenticator

_ISSUER = "https://issuer.example"
_AUDIENCE = "keel-api"

_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PRIVATE_PEM = _key.private_bytes(
    serialization.Encoding.PEM,
    serialization.PrivateFormat.PKCS8,
    serialization.NoEncryption(),
)
_PUBLIC_PEM = _key.public_key().public_bytes(
    serialization.Encoding.PEM,
    serialization.PublicFormat.SubjectPublicKeyInfo,
)


def _token(**extra: object) -> str:
    claims: dict[str, object] = {
        "sub": "user-1",
        "iss": _ISSUER,
        "aud": _AUDIENCE,
        "exp": datetime.now(UTC) + timedelta(hours=1),
    }
    claims.update(extra)
    return jwt.encode(claims, _PRIVATE_PEM, algorithm="RS256")


def _authenticator() -> OIDCAuthenticator:
    return OIDCAuthenticator(
        issuer=_ISSUER,
        audience=_AUDIENCE,
        key_resolver=lambda _: _PUBLIC_PEM,
    )


def test_scp_list_claim_maps_to_scopes() -> None:
    # Azure AD / v2 emits scopes as the `scp` array, not the space-delimited `scope`.
    principal = _authenticator().authenticate(_token(scp=["orders:read", "orders:write"]))
    assert principal.scopes == frozenset({"orders:read", "orders:write"})


def test_realm_access_roles_claim_maps_to_roles() -> None:
    # Keycloak nests roles under realm_access.roles.
    principal = _authenticator().authenticate(_token(realm_access={"roles": ["ops", "admin"]}))
    assert principal.roles == frozenset({"ops", "admin"})


def test_absent_scope_and_role_claims_yield_empty_sets() -> None:
    principal = _authenticator().authenticate(_token())
    assert principal.scopes == frozenset()
    assert principal.roles == frozenset()

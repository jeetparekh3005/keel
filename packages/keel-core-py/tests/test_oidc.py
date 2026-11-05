from datetime import UTC, datetime, timedelta

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from keel_core.adapters.outbound.auth import OIDCAuthenticator
from keel_core.domain.errors import Unauthenticated, Unavailable

_ISSUER = "https://issuer.example"
_AUDIENCE = "keel-api"


def _keypair():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    public_pem = key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return private_pem, public_pem


_PRIVATE_PEM, _PUBLIC_PEM = _keypair()
_OTHER_PRIVATE_PEM, _ = _keypair()


def _token(private_pem=_PRIVATE_PEM, **overrides):
    claims = {
        "sub": "user-1",
        "iss": _ISSUER,
        "aud": _AUDIENCE,
        "exp": datetime.now(UTC) + timedelta(hours=1),
        "scope": "orders:read orders:write",
        "roles": ["admin"],
    }
    claims.update(overrides)
    return jwt.encode(claims, private_pem, algorithm="RS256")


def _authenticator():
    return OIDCAuthenticator(
        issuer=_ISSUER,
        audience=_AUDIENCE,
        key_resolver=lambda _: _PUBLIC_PEM,
    )


def test_valid_token_yields_principal():
    principal = _authenticator().authenticate(_token())
    assert principal.subject == "user-1"
    assert "orders:read" in principal.scopes
    assert "admin" in principal.roles


def test_expired_token_is_rejected():
    expired = _token(exp=datetime.now(UTC) - timedelta(hours=1))
    with pytest.raises(Unauthenticated):
        _authenticator().authenticate(expired)


def test_wrong_audience_is_rejected():
    with pytest.raises(Unauthenticated):
        _authenticator().authenticate(_token(aud="someone-else"))


def test_wrong_issuer_is_rejected():
    with pytest.raises(Unauthenticated):
        _authenticator().authenticate(_token(iss="https://evil.example"))


def test_bad_signature_is_rejected():
    forged = _token(private_pem=_OTHER_PRIVATE_PEM)
    with pytest.raises(Unauthenticated):
        _authenticator().authenticate(forged)


def test_garbage_token_is_rejected():
    with pytest.raises(Unauthenticated):
        _authenticator().authenticate("not-a-jwt")


def test_unknown_kid_is_unauthenticated_not_500():
    # PyJWKClientError (e.g. a kid absent from the JWKS) is not an InvalidTokenError;
    # it must map to Unauthenticated (401), not escape as an unhandled 500.
    def resolver(_: str) -> str:
        raise jwt.PyJWKClientError("no matching kid")

    auth = OIDCAuthenticator(issuer=_ISSUER, audience=_AUDIENCE, key_resolver=resolver)
    with pytest.raises(Unauthenticated):
        auth.authenticate(_token())


def test_jwks_endpoint_unreachable_is_unavailable():
    # A JWKS fetch failure is a dependency outage: 503 (retryable), not 401 or 500.
    def resolver(_: str) -> str:
        raise jwt.PyJWKClientConnectionError("jwks endpoint down")

    auth = OIDCAuthenticator(issuer=_ISSUER, audience=_AUDIENCE, key_resolver=resolver)
    with pytest.raises(Unavailable):
        auth.authenticate(_token())


def test_clock_skew_within_leeway_is_accepted():
    # A token that expired 30s ago is accepted under the default 60s leeway.
    recently_expired = _token(exp=datetime.now(UTC) - timedelta(seconds=30))
    principal = _authenticator().authenticate(recently_expired)
    assert principal.subject == "user-1"


def test_from_jwks_rejects_plaintext_http():
    with pytest.raises(ValueError, match="https"):
        OIDCAuthenticator.from_jwks(
            jwks_uri="http://issuer.example/jwks", issuer=_ISSUER, audience=_AUDIENCE
        )

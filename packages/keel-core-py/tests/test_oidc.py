from datetime import UTC, datetime, timedelta

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from keel_core.adapters.outbound.auth import OIDCAuthenticator
from keel_core.domain.errors import Unauthenticated

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

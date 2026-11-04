"""API-key authenticator + its X-API-Key HTTP flow (audit #25)."""

import hashlib

import httpx
import pytest
from fastapi import Depends
from httpx import ASGITransport

from keel_core.adapters.inbound.http import create_app, require_scopes
from keel_core.adapters.outbound.auth import ApiKeyAuthenticator, hash_api_key
from keel_core.domain.errors import Unauthenticated
from keel_core.ports.auth import Principal


def _authenticator() -> ApiKeyAuthenticator:
    return ApiKeyAuthenticator.from_keys(
        {"secret-key": Principal(subject="svc", scopes=frozenset({"items:read"}))},
    )


def test_valid_key_yields_principal() -> None:
    principal = _authenticator().authenticate("secret-key")
    assert principal.subject == "svc"
    assert "items:read" in principal.scopes


def test_invalid_key_is_rejected() -> None:
    with pytest.raises(Unauthenticated):
        _authenticator().authenticate("wrong")


def test_hash_api_key_is_sha256_hex() -> None:
    assert hash_api_key("k") == hashlib.sha256(b"k").hexdigest()


def test_constructs_from_prehashed_keys() -> None:
    auth = ApiKeyAuthenticator({hash_api_key("abc"): Principal(subject="u")})
    assert auth.authenticate("abc").subject == "u"


async def test_api_key_authenticates_over_http_via_x_api_key() -> None:
    app = create_app(service="t", version="0", authenticator=_authenticator())

    @app.get("/data", dependencies=[Depends(require_scopes("items:read"))])
    async def _data() -> dict[str, bool]:
        return {"ok": True}

    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        assert (await client.get("/data", headers={"x-api-key": "secret-key"})).status_code == 200
        assert (await client.get("/data", headers={"x-api-key": "bad"})).status_code == 401
        assert (await client.get("/data")).status_code == 401

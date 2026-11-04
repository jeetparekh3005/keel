"""Default-deny CORS policy (audit #33)."""

import httpx
import pytest
from httpx import ASGITransport

from keel_core.adapters.inbound.http import create_app
from keel_core.testkit.fakes import StubAuthenticator

_ALLOWED = "https://app.example"


def _app(**kwargs: object) -> object:
    return create_app(service="t", version="0", authenticator=StubAuthenticator({}), **kwargs)


async def _origin_header(app: object, origin: str) -> str | None:
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/healthz", headers={"origin": origin})
    return resp.headers.get("access-control-allow-origin")


async def test_no_cors_by_default_denies_cross_origin() -> None:
    # No origins configured -> no CORS middleware -> no allow-origin header.
    assert await _origin_header(_app(), _ALLOWED) is None


async def test_allowed_origin_is_reflected() -> None:
    app = _app(cors_allow_origins=[_ALLOWED])
    assert await _origin_header(app, _ALLOWED) == _ALLOWED


async def test_disallowed_origin_is_not_reflected() -> None:
    app = _app(cors_allow_origins=[_ALLOWED])
    assert await _origin_header(app, "https://evil.example") is None


def test_wildcard_with_credentials_is_rejected() -> None:
    with pytest.raises(ValueError, match="wildcard"):
        _app(cors_allow_origins=["*"], cors_allow_credentials=True)

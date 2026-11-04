"""Opt-in per-instance rate limiting (audit #71)."""

import httpx
from httpx import ASGITransport

from keel_core.adapters.inbound.http import create_app
from keel_core.testkit.fakes import StubAuthenticator


def _app() -> object:
    # 2 requests per 60s: the third within the window is rejected.
    return create_app(
        service="t",
        version="0",
        authenticator=StubAuthenticator({}),
        rate_limit=(2, 60.0),
    )


async def test_rate_limit_allows_then_blocks() -> None:
    transport = ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        assert (await client.get("/healthz")).status_code == 200
        assert (await client.get("/healthz")).status_code == 200
        blocked = await client.get("/healthz")
    assert blocked.status_code == 429
    assert blocked.headers["content-type"].startswith("application/problem+json")
    assert "retry-after" in blocked.headers
    assert blocked.json()["type"] == "urn:keel:error:rate_limited"


async def test_no_limit_by_default() -> None:
    app = create_app(service="t", version="0", authenticator=StubAuthenticator({}))
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        for _ in range(5):
            assert (await client.get("/healthz")).status_code == 200

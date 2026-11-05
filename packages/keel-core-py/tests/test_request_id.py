"""x-request-id propagation is bounded and validated (review #173)."""

import re

import httpx
from httpx import ASGITransport

from keel_core.adapters.inbound.http import create_app
from keel_core.testkit.fakes import StubAuthenticator


def _app() -> object:
    return create_app(service="t", version="0", authenticator=StubAuthenticator({}))


async def _request_id_for(sent: str) -> str:
    transport = ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
        response = await client.get("/healthz", headers={"x-request-id": sent})
    return response.headers["x-request-id"]


async def test_valid_request_id_is_propagated() -> None:
    assert await _request_id_for("abc-123_ID.1") == "abc-123_ID.1"


async def test_malformed_request_id_is_replaced_with_a_fresh_one() -> None:
    returned = await _request_id_for("bad id with spaces and <>")
    assert returned != "bad id with spaces and <>"
    assert re.fullmatch(r"[0-9a-f]{32}", returned)  # a fresh uuid hex


async def test_oversized_request_id_is_replaced() -> None:
    returned = await _request_id_for("a" * 200)
    assert returned != "a" * 200
    assert re.fullmatch(r"[0-9a-f]{32}", returned)

"""Opt-in per-instance rate limiting (audit #71, hardened #122)."""

import httpx
from httpx import ASGITransport

from keel_core.adapters.inbound.http import RateLimitMiddleware, create_app
from keel_core.testkit.fakes import StubAuthenticator


async def _noop_app(scope: object, receive: object, send) -> None:
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": b""})


def _scope(xff: str | None = None) -> dict:
    headers = [(b"x-forwarded-for", xff.encode())] if xff else []
    return {"type": "http", "path": "/x", "headers": headers, "client": ("10.0.0.1", 1234)}


class _Capture:
    def __init__(self) -> None:
        self.status: int | None = None

    async def __call__(self, message: dict) -> None:
        if message["type"] == "http.response.start":
            self.status = message["status"]


def _app() -> object:
    # 2 requests per 60s: the third within the window is rejected.
    return create_app(
        service="t",
        version="0",
        authenticator=StubAuthenticator({}),
        rate_limit=(2, 60.0),
    )


def test_client_key_uses_rightmost_forwarded_hop() -> None:
    # The leftmost XFF entries are client-spoofable; key on the rightmost hop
    # (what the trusted proxy observed) so the limiter cannot be bypassed.
    mw = RateLimitMiddleware(_noop_app, max_requests=1, window_seconds=60.0)
    key = mw._client_key(_scope("1.1.1.1, 2.2.2.2, 3.3.3.3"))  # noqa: SLF001
    assert key == "3.3.3.3"


def test_trust_forwarded_false_ignores_spoofable_xff() -> None:
    # Fail-closed mode (direct exposure): X-Forwarded-For is untrusted, so a client
    # cannot mint a fresh bucket by varying it. The key is the real peer.
    mw = RateLimitMiddleware(_noop_app, max_requests=1, window_seconds=60.0, trust_forwarded=False)
    key_a = mw._client_key(_scope("1.1.1.1"))  # noqa: SLF001
    key_b = mw._client_key(_scope("9.9.9.9"))  # noqa: SLF001
    assert key_a == key_b == "10.0.0.1"


async def test_create_app_rate_limiter_does_not_trust_forwarded_by_default() -> None:
    # create_app wires the limiter fail-closed: two requests with different spoofed XFF
    # from the same peer share one bucket, so the second is limited.
    app = create_app(
        service="t",
        version="0",
        authenticator=StubAuthenticator({}),
        rate_limit=(1, 60.0),
    )
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        first = await client.get("/healthz", headers={"x-forwarded-for": "1.1.1.1"})
        second = await client.get("/healthz", headers={"x-forwarded-for": "9.9.9.9"})
    assert first.status_code == 200
    assert second.status_code == 429


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


async def test_forwarded_for_keys_clients_separately() -> None:
    # Behind a proxy, each original client is limited independently (not collapsed
    # to the proxy IP). Limit is 1/window.
    mw = RateLimitMiddleware(_noop_app, max_requests=1, window_seconds=60)
    for expected in (200, 429):  # same client A exhausts its single token
        cap = _Capture()
        await mw(_scope(xff="1.1.1.1"), None, cap)
        assert cap.status == expected
    cap = _Capture()  # client B is independent
    await mw(_scope(xff="2.2.2.2"), None, cap)
    assert cap.status == 200


async def test_client_state_is_lru_bounded() -> None:
    mw = RateLimitMiddleware(_noop_app, max_requests=5, window_seconds=60, max_clients=2)
    for i in range(10):  # 10 distinct clients, cap is 2
        await mw(_scope(xff=f"10.0.0.{i}"), None, _Capture())
    assert len(mw._buckets) <= 2  # noqa: SLF001  (asserting the memory bound)

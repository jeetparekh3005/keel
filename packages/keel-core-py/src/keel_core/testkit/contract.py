"""Reusable contract-conformance checks a service runs against its own running app.

Services import these in their test suite and point them at an in-process client
to prove they honor the platform contract (health endpoints, problem+json errors).
Typed structurally so the test kit carries no HTTP-client dependency.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Protocol

_PROBLEM_CONTENT_TYPE = "application/problem+json"
_PROBLEM_FIELDS = ("type", "title", "status")

# platform.yaml http.security_headers.emitted (always-on, keel-core edge).
_SECURITY_HEADERS = (
    "content-security-policy",
    "x-content-type-options",
    "x-frame-options",
    "referrer-policy",
    "permissions-policy",
)

# platform.yaml logging.required_fields.
REQUIRED_LOG_FIELDS = (
    "timestamp",
    "level",
    "message",
    "service",
    "version",
    "trace_id",
    "span_id",
)


class ContractResponse(Protocol):
    """Minimal response shape (httpx.Response and Starlette TestClient both satisfy it)."""

    @property
    def status_code(self) -> int:
        """HTTP status code."""
        ...

    @property
    def headers(self) -> Mapping[str, str]:
        """Response headers."""
        ...

    def json(self) -> object:
        """Parsed JSON body."""
        ...


class ContractClient(Protocol):
    """Minimal async client shape used by the conformance checks."""

    async def get(self, url: str) -> ContractResponse:
        """Issue a GET."""
        ...


async def assert_liveness_ok(client: ContractClient) -> None:
    """The service exposes a 200 liveness endpoint at /healthz."""
    response = await client.get("/healthz")
    assert response.status_code == 200, "liveness (/healthz) must return 200"


async def assert_readiness_present(client: ContractClient) -> None:
    """The service exposes /readyz returning 200 (ready) or 503 (not ready)."""
    response = await client.get("/readyz")
    assert response.status_code in (200, 503), "readiness (/readyz) must return 200 or 503"


def assert_problem_response(response: ContractResponse, *, status: int) -> None:
    """The response is an RFC 9457 problem+json with the expected status and fields."""
    assert response.status_code == status, f"expected status {status}"
    content_type = response.headers["content-type"]
    assert content_type.startswith(_PROBLEM_CONTENT_TYPE), "errors must be problem+json"
    body = response.json()
    assert isinstance(body, dict)
    for field in _PROBLEM_FIELDS:
        assert field in body, f"problem+json missing '{field}'"


def assert_security_headers(response: ContractResponse) -> None:
    """Every response carries the always-on edge security headers (platform.yaml http)."""
    for header in _SECURITY_HEADERS:
        assert header in response.headers, f"missing security header '{header}'"
    assert response.headers["x-content-type-options"] == "nosniff"


def assert_no_cors_by_default(response: ContractResponse) -> None:
    """CORS is deny-by-default: no Access-Control-Allow-Origin unless origins are configured."""
    assert "access-control-allow-origin" not in response.headers, (
        "CORS must be deny-by-default (no Access-Control-Allow-Origin without configured origins)"
    )


async def assert_denies_anonymous(client: ContractClient, path: str) -> None:
    """A protected route denies an unauthenticated caller (deny-by-default, 401)."""
    response = await client.get(path)
    assert response.status_code == 401, (
        f"{path} must deny anonymous access with 401 (got {response.status_code})"
    )


def assert_log_record(record: Mapping[str, object]) -> None:
    """A log record carries every field the logging contract requires."""
    for field in REQUIRED_LOG_FIELDS:
        assert field in record, f"log record missing required field '{field}'"

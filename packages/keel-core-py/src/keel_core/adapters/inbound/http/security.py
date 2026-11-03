"""Deny-by-default authentication dependency bound to an Authenticator (ADR-0006)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from fastapi import Request

from keel_core.domain.errors import Unauthenticated

if TYPE_CHECKING:
    from keel_core.ports.auth import Authenticator, Principal

_BEARER_PREFIX = "bearer "


def _extract_credential(request: Request) -> str:
    authorization = request.headers.get("authorization")
    if authorization and authorization.lower().startswith(_BEARER_PREFIX):
        return authorization[len(_BEARER_PREFIX) :]
    api_key = request.headers.get("x-api-key")
    if api_key:
        return api_key
    msg = "missing credential"
    raise Unauthenticated(msg)


def principal_dependency(
    authenticator: Authenticator,
) -> Callable[[Request], Awaitable[Principal]]:
    """Build a FastAPI dependency that resolves the verified Principal or raises 401."""

    async def dependency(request: Request) -> Principal:
        return authenticator.authenticate(_extract_credential(request))

    return dependency

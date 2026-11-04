"""Authentication + authorization dependencies bound to an Authenticator (ADR-0006).

- `principal_dependency` / `authenticated` - verify the caller (deny-by-default).
- `require_scopes` / `require_roles` - authorize, raising `Forbidden` (403) on failure.

The authenticator is read from `app.state.authenticator` (set by `create_app`), so the
same scope/role dependencies work for any service without re-binding.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, cast

from fastapi import Request
from starlette.concurrency import run_in_threadpool

from keel_core.domain.errors import Forbidden, Unauthenticated

if TYPE_CHECKING:
    from keel_core.ports.auth import Authenticator, Principal

_BEARER_PREFIX = "bearer "

PrincipalDependency = Callable[[Request], Awaitable["Principal"]]


def _mark_auth(dependency: PrincipalDependency) -> PrincipalDependency:
    """Tag a dependency as auth-enforcing so the route-auth conformance check can find it."""
    dependency.__keel_auth__ = True  # type: ignore[attr-defined]
    return dependency


def _extract_credential(request: Request) -> str:
    # Bearer JWT or an API key (X-API-Key); the configured Authenticator decides
    # how to verify whichever credential is presented. mTLS is transport-level.
    authorization = request.headers.get("authorization")
    if authorization and authorization.lower().startswith(_BEARER_PREFIX):
        return authorization[len(_BEARER_PREFIX) :]
    api_key = request.headers.get("x-api-key")
    if api_key:
        return api_key
    msg = "missing bearer or api-key credential"
    raise Unauthenticated(msg)


async def _authenticate(request: Request) -> Principal:
    # Verify off the event loop: JWKS fetch + RSA verify are blocking/CPU-bound.
    authenticator = cast("Authenticator", request.app.state.authenticator)
    credential = _extract_credential(request)
    return await run_in_threadpool(authenticator.authenticate, credential)


def principal_dependency(authenticator: Authenticator) -> PrincipalDependency:
    """Build a dependency that resolves the verified Principal or raises 401.

    Bound to a specific authenticator; the app factory also stores the authenticator
    on ``app.state`` so `require_scopes`/`require_roles` work standalone.
    """

    async def dependency(request: Request) -> Principal:
        credential = _extract_credential(request)
        return await run_in_threadpool(authenticator.authenticate, credential)

    return _mark_auth(dependency)


def require_scopes(*required: str) -> PrincipalDependency:
    """Dependency that authenticates then requires all of ``required`` scopes (else 403)."""

    async def dependency(request: Request) -> Principal:
        principal = await _authenticate(request)
        if not set(required).issubset(principal.scopes):
            msg = "insufficient scope"
            raise Forbidden(msg)
        return principal

    return _mark_auth(dependency)


def require_roles(*required: str) -> PrincipalDependency:
    """Dependency that authenticates then requires all of ``required`` roles (else 403)."""

    async def dependency(request: Request) -> Principal:
        principal = await _authenticate(request)
        if not set(required).issubset(principal.roles):
            msg = "insufficient role"
            raise Forbidden(msg)
        return principal

    return _mark_auth(dependency)

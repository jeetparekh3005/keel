"""Authentication + authorization dependencies bound to an Authenticator (ADR-0006).

- `principal_dependency` / `authenticated` — verify the caller (deny-by-default).
- `require_scopes` / `require_roles` — authorize, raising `Forbidden` (403) on failure.

The authenticator is read from `app.state.authenticator` (set by `create_app`), so the
same scope/role dependencies work for any service without re-binding.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, cast

from fastapi import Request

from keel_core.domain.errors import Forbidden, Unauthenticated

if TYPE_CHECKING:
    from keel_core.ports.auth import Authenticator, Principal

_BEARER_PREFIX = "bearer "

PrincipalDependency = Callable[[Request], Awaitable["Principal"]]


def _extract_credential(request: Request) -> str:
    # Only Bearer JWT today; api_key/mTLS are planned (see docs/STATUS.md).
    authorization = request.headers.get("authorization")
    if authorization and authorization.lower().startswith(_BEARER_PREFIX):
        return authorization[len(_BEARER_PREFIX) :]
    msg = "missing bearer credential"
    raise Unauthenticated(msg)


async def _authenticate(request: Request) -> Principal:
    authenticator = cast("Authenticator", request.app.state.authenticator)
    return authenticator.authenticate(_extract_credential(request))


def principal_dependency(authenticator: Authenticator) -> PrincipalDependency:
    """Build a dependency that resolves the verified Principal or raises 401.

    Bound to a specific authenticator; the app factory also stores the authenticator
    on ``app.state`` so `require_scopes`/`require_roles` work standalone.
    """

    async def dependency(request: Request) -> Principal:
        return authenticator.authenticate(_extract_credential(request))

    return dependency


def require_scopes(*required: str) -> PrincipalDependency:
    """Dependency that authenticates then requires all of ``required`` scopes (else 403)."""

    async def dependency(request: Request) -> Principal:
        principal = await _authenticate(request)
        if not set(required).issubset(principal.scopes):
            msg = "insufficient scope"
            raise Forbidden(msg)
        return principal

    return dependency


def require_roles(*required: str) -> PrincipalDependency:
    """Dependency that authenticates then requires all of ``required`` roles (else 403)."""

    async def dependency(request: Request) -> Principal:
        principal = await _authenticate(request)
        if not set(required).issubset(principal.roles):
            msg = "insufficient role"
            raise Forbidden(msg)
        return principal

    return dependency

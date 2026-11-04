"""Deny-by-default auth on the gRPC plane (audit #64)."""

import grpc
import pytest

from keel_core.adapters.inbound.rpc.server import AuthInterceptor, create_server
from keel_core.ports.auth import Principal
from keel_core.testkit.fakes import StubAuthenticator


class _Details:
    def __init__(self, method, metadata):
        self.method = method
        self.invocation_metadata = metadata


class _AbortError(Exception):
    pass


class _FakeContext:
    def __init__(self):
        self.code = None
        self.details = None

    async def abort(self, code, details):
        self.code = code
        self.details = details
        raise _AbortError


async def _continuation(_details):
    return "HANDLER"  # sentinel: the real handler was reached


def _interceptor(**kwargs):
    return AuthInterceptor(StubAuthenticator({"good": Principal(subject="u")}), **kwargs)


async def _assert_denied(handler) -> None:
    assert handler != "HANDLER"
    context = _FakeContext()
    with pytest.raises(_AbortError):
        await handler.unary_unary(None, context)
    assert context.code == grpc.StatusCode.UNAUTHENTICATED


async def test_valid_token_reaches_handler():
    handler = await _interceptor().intercept_service(
        _continuation, _Details("/svc/Method", (("authorization", "Bearer good"),))
    )
    assert handler == "HANDLER"


async def test_missing_token_is_unauthenticated():
    handler = await _interceptor().intercept_service(_continuation, _Details("/svc/Method", ()))
    await _assert_denied(handler)


async def test_invalid_token_is_unauthenticated():
    handler = await _interceptor().intercept_service(
        _continuation, _Details("/svc/Method", (("authorization", "Bearer nope"),))
    )
    await _assert_denied(handler)


async def test_non_bearer_authorization_is_unauthenticated():
    handler = await _interceptor().intercept_service(
        _continuation, _Details("/svc/Method", (("authorization", "Basic abc"),))
    )
    await _assert_denied(handler)


async def test_exempt_method_bypasses_auth():
    interceptor = AuthInterceptor(StubAuthenticator({}), exempt=frozenset({"/health/Check"}))
    handler = await interceptor.intercept_service(_continuation, _Details("/health/Check", ()))
    assert handler == "HANDLER"


async def test_create_server_requires_authenticator_and_builds():
    assert create_server(StubAuthenticator({})) is not None

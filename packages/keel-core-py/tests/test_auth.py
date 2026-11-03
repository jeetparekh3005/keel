import pytest

from keel_core.domain.errors import Unauthenticated
from keel_core.ports.auth import Principal
from keel_core.testkit.fakes import StubAuthenticator


def test_stub_authenticator_returns_mapped_principal():
    principal = Principal(subject="u1", scopes=frozenset({"orders:read"}))
    auth = StubAuthenticator({"good-token": principal})
    assert auth.authenticate("good-token") == principal


def test_stub_authenticator_rejects_unknown_credential():
    auth = StubAuthenticator({})
    with pytest.raises(Unauthenticated):
        auth.authenticate("nope")

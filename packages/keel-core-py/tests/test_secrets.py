import pytest

from keel_core.adapters.outbound.secrets import EnvSecretProvider


def test_get_returns_value():
    provider = EnvSecretProvider(environ={"KEEL_SECRET_DB_PASSWORD": "s3cret"})
    assert provider.get("db_password") == "s3cret"


def test_get_optional_missing_returns_none():
    assert EnvSecretProvider(environ={}).get_optional("nope") is None


def test_get_missing_raises_keyerror():
    with pytest.raises(KeyError):
        EnvSecretProvider(environ={}).get("nope")


def test_custom_prefix():
    provider = EnvSecretProvider(prefix="APP_", environ={"APP_TOKEN": "t"})
    assert provider.get("token") == "t"

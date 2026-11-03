import pytest
from pydantic import ValidationError

from keel_core.config import BaseServiceConfig


def test_loads_from_env_with_prefix(monkeypatch):
    monkeypatch.setenv("KEEL_SERVICE_NAME", "orders")
    monkeypatch.setenv("KEEL_ENVIRONMENT", "prod")
    config = BaseServiceConfig()
    assert config.service_name == "orders"
    assert config.environment == "prod"
    assert config.version == "0.0.0"  # default


def test_missing_required_field_fails_fast(monkeypatch):
    monkeypatch.delenv("KEEL_SERVICE_NAME", raising=False)
    with pytest.raises(ValidationError):
        BaseServiceConfig(_env_file=None)


def test_unknown_field_is_rejected(monkeypatch):
    monkeypatch.setenv("KEEL_SERVICE_NAME", "orders")
    with pytest.raises(ValidationError):
        BaseServiceConfig(nonsense="x")


def test_config_is_immutable(monkeypatch):
    monkeypatch.setenv("KEEL_SERVICE_NAME", "orders")
    config = BaseServiceConfig()
    with pytest.raises(ValidationError):
        config.service_name = "changed"

"""ADR-0010 port-coverage check: every driven port in the contract has an adapter."""

import importlib
from pathlib import Path

import yaml

_ROOT = Path(__file__).resolve().parents[3]
_CONTRACT = _ROOT / "platform.yaml"

# Each driven port -> (module, attribute) that realizes it in keel-core.
_PORT_IMPLEMENTATIONS = {
    "Repository": ("keel_core.adapters.outbound.persistence", "SqlAlchemyRepository"),
    "Authenticator": ("keel_core.adapters.outbound.auth", "OIDCAuthenticator"),
    "Logger": ("keel_core.adapters.outbound.logging", "StructuredLogger"),
    "Tracer": ("keel_core.adapters.outbound.telemetry", "configure_tracing"),
    "Meter": ("keel_core.adapters.outbound.telemetry", "configure_metrics"),
    "ConfigLoader": ("keel_core.config", "BaseServiceConfig"),
    "SecretProvider": ("keel_core.adapters.outbound.secrets", "EnvSecretProvider"),
    "Clock": ("keel_core.adapters.outbound.clock", "SystemClock"),
    "ServiceClient": ("keel_core.adapters.outbound.rpc", "create_channel"),
    "MessagePublisher": ("keel_core.adapters.outbound.messaging", "InMemoryMessageBus"),
}


def test_every_driven_port_has_a_registered_adapter():
    contract = yaml.safe_load(_CONTRACT.read_text())
    for port in contract["spec"]["ports"]["driven"]:
        assert port in _PORT_IMPLEMENTATIONS, f"no adapter mapping for driven port {port!r}"
        module_name, attribute = _PORT_IMPLEMENTATIONS[port]
        module = importlib.import_module(module_name)
        assert hasattr(module, attribute), f"{module_name}.{attribute} missing for port {port!r}"

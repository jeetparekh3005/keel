import json
from pathlib import Path

import jsonschema
import yaml

_ROOT = Path(__file__).resolve().parents[3]
_CONTRACT = _ROOT / "platform.yaml"
_SCHEMA = _ROOT / "schemas" / "platform-contract.schema.json"

_EXPECTED_DRIVEN_PORTS = {
    "Repository",
    "Authenticator",
    "Logger",
    "Tracer",
    "Meter",
    "ConfigLoader",
    "SecretProvider",
    "Clock",
    "ServiceClient",
    "MessagePublisher",
}


def test_platform_yaml_matches_schema():
    contract = yaml.safe_load(_CONTRACT.read_text())
    schema = json.loads(_SCHEMA.read_text())
    jsonschema.validate(contract, schema)


def test_driven_ports_do_not_drift():
    contract = yaml.safe_load(_CONTRACT.read_text())
    driven = set(contract["spec"]["ports"]["driven"])
    assert driven == _EXPECTED_DRIVEN_PORTS

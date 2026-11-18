"""GcpSecretManagerSecretProvider against a real Secret Manager (ADR-0024).

GCP has no official Secret Manager emulator, so this test runs only where real
Application Default Credentials and an existing JSON secret are present: it is gated on
KEEL_GCP_SECRET and skipped otherwise, including in CI. The adapter's unit tests
(test_gcp_secrets.py) carry the behavioral coverage; this test proves the live ADC +
AccessSecretVersion path end to end when a developer points it at a real secret.

The secret named by KEEL_GCP_SECRET must already exist and hold a JSON object; this test
only reads (no create/write), to avoid mutating a real project.
"""

from __future__ import annotations

import json
import os

import pytest

from keel_core.adapters.outbound.secrets import GcpSecretManagerSecretProvider

_SECRET = os.environ.get("KEEL_GCP_SECRET")
_VERSION = os.environ.get("KEEL_GCP_SECRET_VERSION", "latest")
# Optional: a JSON object the operator expects the secret to contain, so the read can be
# asserted against known values. Absent -> only prove the secret loads and a field is read.
_EXPECTED = os.environ.get("KEEL_GCP_SECRET_EXPECTED_JSON")

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(_SECRET is None, reason="KEEL_GCP_SECRET not set (no GCP emulator)"),
]


def test_reads_a_real_secret_manager_secret() -> None:
    assert _SECRET is not None
    with GcpSecretManagerSecretProvider(
        secret=_SECRET, version=_VERSION, start_refresh=False
    ) as provider:
        if _EXPECTED is not None:
            for key, value in json.loads(_EXPECTED).items():
                assert provider.get(key) == value
        assert provider.get_optional("this-field-should-not-exist") is None

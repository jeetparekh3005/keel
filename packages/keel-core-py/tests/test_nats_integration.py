"""NATS JetStream adapter against a real server (audit #26/#34).

Runs only when KEEL_NATS_URL is set (CI spins up a NATS JetStream container);
skipped otherwise. Holds the NATS adapter to the same contract as InMemory.
"""

import os

import pytest

pytest.importorskip("nats")

from keel_core.adapters.outbound.messaging.nats import NatsMessageBus
from keel_core.testkit.messaging import assert_pubsub_roundtrip

_NATS_URL = os.environ.get("KEEL_NATS_URL")

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(_NATS_URL is None, reason="KEEL_NATS_URL not set"),
]


async def test_nats_bus_satisfies_the_contract():
    bus = NatsMessageBus(_NATS_URL, stream="keel-test", subjects=["keel.test.>"])
    await bus.connect()
    try:
        await assert_pubsub_roundtrip(bus, subject="keel.test.events")
    finally:
        await bus.close()

"""RabbitMQ adapter against a real broker (ADR-0025).

Runs only when KEEL_RABBITMQ_URL is set (CI spins up a RabbitMQ container);
skipped otherwise. Holds the RabbitMQ adapter to the same contract as InMemory.
"""

import os

import pytest

pytest.importorskip("aio_pika")

from keel_core.adapters.outbound.messaging.rabbitmq import RabbitMqMessageBus
from keel_core.testkit.messaging import assert_pubsub_roundtrip

_RABBITMQ_URL = os.environ.get("KEEL_RABBITMQ_URL")

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(_RABBITMQ_URL is None, reason="KEEL_RABBITMQ_URL not set"),
]


async def test_rabbitmq_bus_satisfies_the_contract():
    bus = RabbitMqMessageBus(_RABBITMQ_URL, queue="keel-test", subjects=["keel.test.#"])
    await bus.connect()
    try:
        await assert_pubsub_roundtrip(bus, subject="keel.test.events")
    finally:
        await bus.close()


async def test_rabbitmq_bus_propagates_trace_context_end_to_end():
    # Proves traceparent continuity over a real broker: the consumer handler must run
    # under a context whose trace_id matches the producer's active span. A distinct queue
    # and subject root keep this round-trip from stealing the other test's message (two
    # consumers on one queue share deliveries round-robin).
    bus = RabbitMqMessageBus(_RABBITMQ_URL, queue="keel-trace", subjects=["keeltrace.#"])
    await bus.connect()
    try:
        await assert_pubsub_roundtrip(bus, subject="keeltrace.events", check_trace=True)
    finally:
        await bus.close()

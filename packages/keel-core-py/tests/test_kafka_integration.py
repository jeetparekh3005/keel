"""Kafka adapter against a real broker (ADR-0025).

Runs only when KEEL_KAFKA_BROKERS is set (CI starts an apache/kafka KRaft container); skipped
otherwise, matching the NATS and RabbitMQ round-trips' honest gating. The first test exercises a
full publish -> subscribe round-trip and asserts the payload and custom headers arrive intact and
that the W3C trace context propagates (the handler's trace_id equals the producer's). The second
proves the poison-record contract end-to-end: a record whose handler always fails is re-produced
through the retry topic and lands on the dead-letter topic at the cap rather than looping forever.
A unique subject (hence topic + consumer group) per run keeps a rerun from reading a prior run's
committed offsets.
"""

import asyncio
import os
import time

import pytest

pytest.importorskip("aiokafka")

from aiokafka import AIOKafkaConsumer

from keel_core.adapters.outbound.messaging.kafka import (
    _DLQ_SUFFIX,
    KafkaMessageBus,
    topic_name,
)
from keel_core.ports.messaging import InboundMessage
from keel_core.testkit.messaging import assert_pubsub_roundtrip

_KAFKA_BROKERS = os.environ.get("KEEL_KAFKA_BROKERS")

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(_KAFKA_BROKERS is None, reason="KEEL_KAFKA_BROKERS not set"),
]


def _brokers() -> list[str]:
    return [b.strip() for b in (_KAFKA_BROKERS or "").split(",") if b.strip()]


def _unique_subject(prefix: str) -> str:
    # A nanosecond stamp gives each run a fresh topic + group, so it does not read a previous
    # run's committed offsets.
    return f"{prefix}.{time.time_ns()}"


async def test_kafka_bus_delivers_payload_and_propagates_trace_context() -> None:
    subject = _unique_subject("keel.test.roundtrip")
    bus = KafkaMessageBus(_brokers(), topics=[subject], group_id=topic_name(subject))
    await bus.connect()
    try:
        # A generous timeout absorbs the consumer-group join/rebalance a fresh group pays once.
        await assert_pubsub_roundtrip(bus, subject=subject, timeout=60, check_trace=True)
    finally:
        await bus.close()


async def test_kafka_poison_record_dead_letters_end_to_end() -> None:
    subject = _unique_subject("keel.test.poison")
    # max_deliver 3 keeps the round-trip short; the contract is the same at 5.
    bus = KafkaMessageBus(_brokers(), topics=[subject], group_id=topic_name(subject), max_deliver=3)
    await bus.connect()

    async def failing(_: InboundMessage) -> None:
        msg = "poison handler"
        raise ValueError(msg)

    try:
        await bus.subscribe(subject, failing)
        await bus.publish(subject, b"poison")

        # A separate consumer reads the dead-letter topic; the poison record must land there with
        # its original payload, proving it was neither looped forever nor dropped.
        dlq_topic = topic_name(subject) + _DLQ_SUFFIX
        reader = AIOKafkaConsumer(
            dlq_topic,
            bootstrap_servers=_brokers(),
            group_id=topic_name(subject) + ".dlqreader",
            enable_auto_commit=False,
            auto_offset_reset="earliest",
        )
        await reader.start()
        try:
            found = await asyncio.wait_for(_await_poison(reader), timeout=90)
            assert found, f"poison record never reached the dead-letter topic {dlq_topic}"
        finally:
            await reader.stop()
    finally:
        await bus.close()


async def _await_poison(consumer: AIOKafkaConsumer) -> bool:
    async for message in consumer:
        if message.value == b"poison":
            return True
    return False

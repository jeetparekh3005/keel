"""MessageBus selection from the environment (ADR-0025 section 3).

At most one of ``KEEL_NATS_URL`` / ``KEEL_KAFKA_BROKERS`` / ``KEEL_RABBITMQ_URL`` may be set
(each non-empty after trimming); two or more is an ambiguous misconfiguration that fails
construction. None set selects the dev ``InMemoryMessageBus``. Selection is fail-closed:
once a broker is gated there is no silent fall-through to the in-memory bus. This mirrors the
``SecretProvider`` at-most-one selector (ADR-0024).
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

from keel_core.adapters.outbound.messaging.memory import InMemoryMessageBus

if TYPE_CHECKING:
    from collections.abc import Mapping

    from keel_core.adapters.outbound.messaging.kafka import KafkaMessageBus
    from keel_core.adapters.outbound.messaging.nats import NatsMessageBus
    from keel_core.adapters.outbound.messaging.rabbitmq import RabbitMqMessageBus

_NATS_URL = "KEEL_NATS_URL"
_KAFKA_BROKERS = "KEEL_KAFKA_BROKERS"
_RABBITMQ_URL = "KEEL_RABBITMQ_URL"


def _split(value: str | None) -> list[str]:
    """Parse a comma-separated env value into a trimmed, empty-free list."""
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


def message_bus_from_env(
    environ: Mapping[str, str] = os.environ,
) -> InMemoryMessageBus | NatsMessageBus | KafkaMessageBus | RabbitMqMessageBus:
    """Select the message bus from the environment (ADR-0025 fail-closed selection).

    Counts the gating vars ``KEEL_NATS_URL``, ``KEEL_KAFKA_BROKERS`` and ``KEEL_RABBITMQ_URL``
    (non-empty after trimming). More than one -> fail construction ("multiple message bus
    backends configured"). None -> ``InMemoryMessageBus`` (the dev default). Exactly one ->
    that adapter, built from the env keys it documents; if the selected broker's optional
    client extra is not installed the import failure surfaces as a clear "backend not installed"
    error rather than a bare ``ImportError`` from deep in the adapter module.
    """
    nats_url = (environ.get(_NATS_URL) or "").strip()
    kafka_brokers = (environ.get(_KAFKA_BROKERS) or "").strip()
    rabbitmq_url = (environ.get(_RABBITMQ_URL) or "").strip()

    gating = (
        (_NATS_URL, nats_url),
        (_KAFKA_BROKERS, kafka_brokers),
        (_RABBITMQ_URL, rabbitmq_url),
    )
    configured = [name for name, value in gating if value]
    if len(configured) > 1:
        msg = (
            "multiple message bus backends configured: set at most one of "
            "KEEL_NATS_URL, KEEL_KAFKA_BROKERS, KEEL_RABBITMQ_URL"
        )
        raise ValueError(msg)
    if not configured:
        return InMemoryMessageBus()

    if nats_url:
        return _build_nats(nats_url, environ)
    if kafka_brokers:
        return _build_kafka(kafka_brokers, environ)
    return _build_rabbitmq(rabbitmq_url, environ)


def _build_nats(url: str, environ: Mapping[str, str]) -> NatsMessageBus:
    """Construct the NATS adapter from ``KEEL_NATS_STREAM`` / ``KEEL_NATS_SUBJECTS``."""
    try:
        # Lazy import so selecting another backend (or the in-memory default) never requires
        # the optional nats-py `nats` extra.
        from keel_core.adapters.outbound.messaging.nats import NatsMessageBus
    except ImportError as exc:
        msg = (
            "NATS message bus backend selected (KEEL_NATS_URL) but not installed: "
            "install the keel-core[nats] extra"
        )
        raise ImportError(msg) from exc

    return NatsMessageBus(
        url,
        stream=(environ.get("KEEL_NATS_STREAM") or "").strip() or "keel",
        subjects=_split(environ.get("KEEL_NATS_SUBJECTS")) or ["keel.>"],
    )


def _build_kafka(brokers: str, environ: Mapping[str, str]) -> KafkaMessageBus:
    """Construct the Kafka adapter from ``KEEL_KAFKA_TOPICS`` / ``GROUP_ID`` / ``DLQ_TOPIC``."""
    try:
        # Lazy import so selecting another backend never requires the optional aiokafka extra.
        from keel_core.adapters.outbound.messaging.kafka import KafkaMessageBus
    except ImportError as exc:
        msg = (
            "Kafka message bus backend selected (KEEL_KAFKA_BROKERS) but not installed: "
            "install the keel-core[kafka] extra"
        )
        raise ImportError(msg) from exc

    return KafkaMessageBus(
        _split(brokers),
        topics=_split(environ.get("KEEL_KAFKA_TOPICS")) or ["keel"],
        group_id=(environ.get("KEEL_KAFKA_GROUP_ID") or "").strip() or "keel",
        dlq_topic=(environ.get("KEEL_KAFKA_DLQ_TOPIC") or "").strip() or None,
    )


def _build_rabbitmq(url: str, environ: Mapping[str, str]) -> RabbitMqMessageBus:
    """Construct the RabbitMQ adapter from ``KEEL_RABBITMQ_EXCHANGE`` / ``QUEUE`` / ``DLX``."""
    try:
        # Lazy import so selecting another backend never requires the optional aio-pika extra.
        from keel_core.adapters.outbound.messaging.rabbitmq import RabbitMqMessageBus
    except ImportError as exc:
        msg = (
            "RabbitMQ message bus backend selected (KEEL_RABBITMQ_URL) but not installed: "
            "install the keel-core[rabbitmq] extra"
        )
        raise ImportError(msg) from exc

    return RabbitMqMessageBus(
        url,
        exchange=(environ.get("KEEL_RABBITMQ_EXCHANGE") or "").strip() or "keel",
        queue=(environ.get("KEEL_RABBITMQ_QUEUE") or "").strip() or "keel",
        subjects=_split(environ.get("KEEL_RABBITMQ_SUBJECTS")) or ["keel.#"],
        dlx=(environ.get("KEEL_RABBITMQ_DLX") or "").strip() or "keel.dlx",
    )

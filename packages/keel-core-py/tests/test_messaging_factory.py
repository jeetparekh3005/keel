"""Fail-closed message bus selection tests (ADR-0025 section 3).

Mirrors the SecretProvider selector tests (test_aws_secrets.py's selection block): more than
one gating var fails closed; each single var selects the right adapter TYPE; none yields the
in-memory dev default. Construction is broker-free - the adapters connect only in connect(),
never in __init__ - so these assert the selected type (and the missing-extra failure) without
touching a live broker.
"""

from __future__ import annotations

import sys

import pytest

from keel_core.adapters.outbound.messaging import InMemoryMessageBus, message_bus_from_env
from keel_core.adapters.outbound.messaging.kafka import KafkaMessageBus
from keel_core.adapters.outbound.messaging.nats import NatsMessageBus
from keel_core.adapters.outbound.messaging.rabbitmq import RabbitMqMessageBus


def test_selection_rejects_multiple_backends() -> None:
    with pytest.raises(ValueError, match="multiple message bus backends configured"):
        message_bus_from_env(
            environ={
                "KEEL_NATS_URL": "nats://127.0.0.1:4222",
                "KEEL_KAFKA_BROKERS": "127.0.0.1:9092",
            }
        )


def test_selection_rejects_all_three_backends() -> None:
    with pytest.raises(ValueError, match="at most one of"):
        message_bus_from_env(
            environ={
                "KEEL_NATS_URL": "nats://127.0.0.1:4222",
                "KEEL_KAFKA_BROKERS": "127.0.0.1:9092",
                "KEEL_RABBITMQ_URL": "amqp://127.0.0.1:5672",
            }
        )


def test_selection_defaults_to_in_memory_when_unset() -> None:
    bus = message_bus_from_env(environ={"UNRELATED": "value"})
    assert isinstance(bus, InMemoryMessageBus)


def test_selection_ignores_whitespace_only_gating_vars() -> None:
    bus = message_bus_from_env(
        environ={"KEEL_NATS_URL": "   ", "KEEL_KAFKA_BROKERS": "\t", "KEEL_RABBITMQ_URL": "\n"}
    )
    assert isinstance(bus, InMemoryMessageBus)


def test_factory_builds_nats_when_url_set() -> None:
    bus = message_bus_from_env(
        environ={
            "KEEL_NATS_URL": "nats://127.0.0.1:4222",
            "KEEL_NATS_STREAM": "orders",
            "KEEL_NATS_SUBJECTS": "orders.>",
        }
    )
    assert isinstance(bus, NatsMessageBus)
    assert not isinstance(bus, InMemoryMessageBus)


def test_factory_builds_kafka_when_brokers_set() -> None:
    bus = message_bus_from_env(
        environ={
            "KEEL_KAFKA_BROKERS": "127.0.0.1:9092,127.0.0.1:9093",
            "KEEL_KAFKA_TOPICS": "orders",
            "KEEL_KAFKA_GROUP_ID": "orders-svc",
            "KEEL_KAFKA_DLQ_TOPIC": "orders.dead",
        }
    )
    assert isinstance(bus, KafkaMessageBus)


def test_factory_builds_rabbitmq_when_url_set() -> None:
    bus = message_bus_from_env(
        environ={
            "KEEL_RABBITMQ_URL": "amqp://127.0.0.1:5672",
            "KEEL_RABBITMQ_EXCHANGE": "orders",
            "KEEL_RABBITMQ_QUEUE": "orders-svc",
            "KEEL_RABBITMQ_DLX": "orders.dlx",
        }
    )
    assert isinstance(bus, RabbitMqMessageBus)


def test_factory_reports_kafka_backend_not_installed(monkeypatch: pytest.MonkeyPatch) -> None:
    # Simulate the optional aiokafka extra being absent: a None entry in sys.modules makes
    # `import aiokafka` raise ImportError, and dropping the cached adapter module forces the
    # factory's lazy import to re-execute (and fail) rather than reuse the already-loaded one.
    monkeypatch.setitem(sys.modules, "aiokafka", None)
    monkeypatch.delitem(sys.modules, "keel_core.adapters.outbound.messaging.kafka", raising=False)
    with pytest.raises(ImportError, match=r"keel-core\[kafka\]"):
        message_bus_from_env(environ={"KEEL_KAFKA_BROKERS": "127.0.0.1:9092"})


def test_factory_reports_rabbitmq_backend_not_installed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "aio_pika", None)
    monkeypatch.delitem(
        sys.modules, "keel_core.adapters.outbound.messaging.rabbitmq", raising=False
    )
    with pytest.raises(ImportError, match=r"keel-core\[rabbitmq\]"):
        message_bus_from_env(environ={"KEEL_RABBITMQ_URL": "amqp://127.0.0.1:5672"})


def test_factory_reports_nats_backend_not_installed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "nats", None)
    monkeypatch.delitem(sys.modules, "keel_core.adapters.outbound.messaging.nats", raising=False)
    with pytest.raises(ImportError, match=r"keel-core\[nats\]"):
        message_bus_from_env(environ={"KEEL_NATS_URL": "nats://127.0.0.1:4222"})

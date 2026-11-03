"""Message bus adapters (in-memory default; NATS/Kafka/RabbitMQ behind the port, ADR-0012)."""

from keel_core.adapters.outbound.messaging.memory import InMemoryMessageBus

__all__ = ["InMemoryMessageBus"]

"""Message bus adapters (in-memory default; NATS/Kafka/RabbitMQ behind the port, ADR-0012).

``message_bus_from_env`` selects among them fail-closed from the environment (ADR-0025).
Importing this package stays broker-free: the factory imports the optional NATS/Kafka/RabbitMQ
clients lazily, only when their backend is actually selected.
"""

from keel_core.adapters.outbound.messaging.factory import message_bus_from_env
from keel_core.adapters.outbound.messaging.memory import InMemoryMessageBus

__all__ = ["InMemoryMessageBus", "message_bus_from_env"]

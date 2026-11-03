"""In-memory MessageBus (dev/test default).

Dispatches synchronously to subscribers in-process. Trace context is injected
into message headers on publish and re-attached around each handler, so handler
spans and logs correlate to the publisher's trace — the same way a real broker
adapter (NATS/Kafka/RabbitMQ) must behave.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping

from opentelemetry import context as otel_context
from opentelemetry import propagate

from keel_core.ports.messaging import InboundMessage, MessageHandler


class InMemoryMessageBus:
    """A process-local MessageBus for development and tests."""

    def __init__(self) -> None:
        """Create an empty bus."""
        self._subscribers: defaultdict[str, list[MessageHandler]] = defaultdict(list)

    async def subscribe(self, subject: str, handler: MessageHandler) -> None:
        """Register ``handler`` for ``subject``."""
        self._subscribers[subject].append(handler)

    async def publish(
        self, subject: str, payload: bytes, *, headers: Mapping[str, str] | None = None
    ) -> None:
        """Deliver ``payload`` to every subscriber of ``subject``, propagating trace context."""
        carrier: dict[str, str] = dict(headers or {})
        propagate.inject(carrier)
        message = InboundMessage(subject=subject, payload=payload, headers=carrier)
        for handler in list(self._subscribers.get(subject, [])):
            token = otel_context.attach(propagate.extract(carrier))
            try:
                await handler(message)
            finally:
                otel_context.detach(token)

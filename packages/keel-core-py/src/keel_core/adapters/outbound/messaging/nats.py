"""NATS JetStream MessageBus adapter (ADR-0012; keel-core[nats] extra).

Implements the MessageBus port over NATS JetStream. Trace context is injected
into message headers on publish and re-attached around each handler, so handler
spans/logs correlate to the publisher's trace, matching InMemoryMessageBus.
Import from this module directly (it requires the optional nats-py dependency).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import nats
from nats.js.errors import BadRequestError
from opentelemetry import context as otel_context
from opentelemetry import propagate

from keel_core.ports.messaging import InboundMessage, MessageHandler


class NatsMessageBus:
    """A MessageBus backed by NATS JetStream for durable at-least-once delivery."""

    def __init__(self, url: str, *, stream: str, subjects: Sequence[str]) -> None:
        """Configure the server URL and the JetStream stream/subjects to bind."""
        self._url = url
        self._stream = stream
        self._subjects = list(subjects)
        self._nc: Any = None  # nats.NATS connection
        self._js: Any = None  # nats JetStreamContext

    async def connect(self) -> None:
        """Connect and ensure the JetStream stream exists for the configured subjects."""
        self._nc = await nats.connect(self._url)
        self._js = self._nc.jetstream()
        try:
            await self._js.add_stream(name=self._stream, subjects=self._subjects)
        except BadRequestError:
            # Stream already exists (possibly with the same config) — reconcile subjects.
            await self._js.update_stream(name=self._stream, subjects=self._subjects)

    async def publish(
        self, subject: str, payload: bytes, *, headers: Mapping[str, str] | None = None
    ) -> None:
        """Publish ``payload`` to ``subject``, injecting trace context into headers."""
        if self._js is None:
            msg = "NatsMessageBus.connect() must be called before publish()"
            raise RuntimeError(msg)
        carrier: dict[str, str] = dict(headers or {})
        propagate.inject(carrier)
        await self._js.publish(subject, payload, headers=carrier)

    async def subscribe(self, subject: str, handler: MessageHandler) -> None:
        """Deliver messages on ``subject`` to ``handler``, re-attaching trace context."""
        if self._js is None:
            msg = "NatsMessageBus.connect() must be called before subscribe()"
            raise RuntimeError(msg)

        async def _callback(message: Any) -> None:  # noqa: ANN401  # nats Msg is stub-less
            headers = dict(message.headers or {})
            inbound = InboundMessage(
                subject=message.subject,
                payload=message.data,
                headers=headers,
            )
            token = otel_context.attach(propagate.extract(headers))
            try:
                await handler(inbound)
                await message.ack()
            finally:
                otel_context.detach(token)

        await self._js.subscribe(subject, cb=_callback)

    async def close(self) -> None:
        """Drain and close the connection (call at shutdown)."""
        if self._nc is not None:
            await self._nc.drain()
            self._nc = None
            self._js = None

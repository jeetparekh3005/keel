"""NATS JetStream MessageBus adapter (ADR-0012; keel-core[nats] extra).

Implements the MessageBus port over NATS JetStream with durable, explicit-ack
at-least-once delivery. Trace context is injected into message headers on
publish and re-attached around each handler, matching InMemoryMessageBus. On
handler failure the message is nak'd (redelivered) until `max_deliver`, then
term'd and logged at error so a poison message neither loops forever nor is
dropped silently. Import from this module directly (it requires the optional
nats-py dependency).
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Any

import nats
import structlog
from nats.js.api import ConsumerConfig
from nats.js.errors import BadRequestError
from opentelemetry import context as otel_context
from opentelemetry import propagate

from keel_core.ports.messaging import InboundMessage, MessageHandler

if TYPE_CHECKING:
    from keel_core.ports.logging import Logger

_DURABLE_SAFE = re.compile(r"[^A-Za-z0-9_]")


class NatsMessageBus:
    """A MessageBus backed by NATS JetStream for durable at-least-once delivery."""

    def __init__(
        self,
        url: str,
        *,
        stream: str,
        subjects: Sequence[str],
        max_deliver: int = 5,
        ack_wait: float = 30.0,
        max_ack_pending: int = 256,
        logger: Logger | None = None,
    ) -> None:
        """Configure the server URL, the JetStream stream/subjects, and delivery policy.

        ``ack_wait`` (seconds) must exceed the worst-case handler latency, or the
        server redelivers a still-in-flight message and processes it twice.
        ``max_ack_pending`` bounds unacked in-flight messages. ``logger`` records
        redelivery/termination decisions; it defaults to a structlog logger so a
        terminated (dead-lettered) message is never dropped without a trace.
        """
        self._url = url
        self._stream = stream
        self._subjects = list(subjects)
        self._max_deliver = max_deliver
        self._ack_wait = ack_wait
        self._max_ack_pending = max_ack_pending
        self._logger: Logger = logger or structlog.get_logger("keel.messaging")
        self._nc: Any = None  # nats.NATS connection
        self._js: Any = None  # nats JetStreamContext

    async def connect(self) -> None:
        """Connect and ensure the JetStream stream exists for the configured subjects."""
        self._nc = await nats.connect(self._url)
        self._js = self._nc.jetstream()
        try:
            await self._js.add_stream(name=self._stream, subjects=self._subjects)
        except BadRequestError:
            # Stream already exists (possibly with the same config) - reconcile subjects.
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

    async def _dispatch(self, message: Any, handler: MessageHandler) -> None:  # noqa: ANN401
        """Run ``handler`` with trace context; ack on success, nak/term on failure."""
        headers = dict(message.headers or {})
        inbound = InboundMessage(subject=message.subject, payload=message.data, headers=headers)
        token = otel_context.attach(propagate.extract(headers))
        try:
            try:
                await handler(inbound)
            except Exception:  # one bad handler must not kill the subscription
                # Redeliver until the cap, then terminate. Always log the control-plane
                # decision: terminate means the message is dead-lettered (dropped from
                # redelivery), which must never be silent. (The handler still owns its
                # own domain error logging/tracing.)
                num_delivered = message.metadata.num_delivered
                if num_delivered >= self._max_deliver:
                    # exception() captures the handler traceback that made this a poison
                    # message - the key diagnostic for a dead-letter.
                    self._logger.exception(
                        "message terminated after exhausting delivery attempts",
                        subject=message.subject,
                        stream=self._stream,
                        num_delivered=num_delivered,
                        max_deliver=self._max_deliver,
                    )
                    await self._control(message.term, "term", message.subject)
                else:
                    self._logger.warning(
                        "message handler failed; scheduling redelivery",
                        subject=message.subject,
                        num_delivered=num_delivered,
                    )
                    await self._control(message.nak, "nak", message.subject)
                return
            await self._control(message.ack, "ack", message.subject)
        finally:
            otel_context.detach(token)

    async def _control(self, op: Any, name: str, subject: str) -> None:  # noqa: ANN401
        """Run an ack/nak/term call, logging (not raising) a control-plane failure."""
        try:
            await op()
        except Exception:
            # A failed ack/nak/term would otherwise vanish; surface it so redelivery
            # or duplicate-processing anomalies are diagnosable.
            self._logger.exception("jetstream control call failed", op=name, subject=subject)

    async def subscribe(self, subject: str, handler: MessageHandler) -> None:
        """Deliver messages on ``subject`` to ``handler`` via a durable, explicit-ack consumer."""
        if self._js is None:
            msg = "NatsMessageBus.connect() must be called before subscribe()"
            raise RuntimeError(msg)

        async def _callback(message: Any) -> None:  # noqa: ANN401  # nats Msg is stub-less
            await self._dispatch(message, handler)

        durable = "keel_" + _DURABLE_SAFE.sub("_", subject)
        await self._js.subscribe(
            subject,
            cb=_callback,
            durable=durable,
            manual_ack=True,
            config=ConsumerConfig(
                max_deliver=self._max_deliver,
                ack_wait=self._ack_wait,
                max_ack_pending=self._max_ack_pending,
            ),
        )

    async def close(self) -> None:
        """Drain and close the connection (call at shutdown)."""
        if self._nc is not None:
            await self._nc.drain()
            self._nc = None
            self._js = None

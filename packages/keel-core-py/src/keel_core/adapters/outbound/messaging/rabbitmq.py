"""RabbitMQ MessageBus adapter (ADR-0025; keel-core[rabbitmq] extra).

Implements the MessageBus port over a RabbitMQ topic exchange with durable,
manual-ack at-least-once delivery, matching the NATS JetStream adapter's
contract. ``subject`` is the routing key; a durable queue bound to the configured
subjects is consumed with manual ack and a bounded prefetch (the maxAckPending
analog). Trace context is injected into AMQP headers on publish and re-attached
around each handler. On handler failure the message is nack'd (requeued) until
``max_deliver``, then dead-lettered to a separate exchange and logged at error so
a poison message neither loops forever nor is dropped silently. Import from this
module directly (it requires the optional aio-pika dependency).
"""

from __future__ import annotations

import enum
from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Any

import aio_pika
import structlog
from aio_pika import ExchangeType
from opentelemetry import context as otel_context
from opentelemetry import propagate

from keel_core.ports.messaging import InboundMessage, MessageHandler

if TYPE_CHECKING:
    from aio_pika.abc import (
        AbstractIncomingMessage,
        AbstractRobustChannel,
        AbstractRobustConnection,
        AbstractRobustExchange,
        AbstractRobustQueue,
    )

    from keel_core.ports.logging import Logger


class Disposition(enum.Enum):
    """The fate of a delivered message, decided purely from outcome + delivery count."""

    ACK = "ack"
    REDELIVER = "redeliver"
    DEAD_LETTER = "dead_letter"


def disposition(handler_ok: bool, num_delivered: int, max_deliver: int) -> Disposition:  # noqa: FBT001
    """Decide a message's fate from the handler outcome and delivery count.

    Pure, so the poison-handling policy is unit-testable without a broker: ack on
    success regardless of count; redeliver on failure under the cap; dead-letter at
    or over it. Mirrors the Rust/NATS adapters' disposition function exactly.
    """
    if handler_ok:
        return Disposition.ACK
    if num_delivered >= max_deliver:
        return Disposition.DEAD_LETTER
    return Disposition.REDELIVER


def _num_delivered(headers: Mapping[str, Any]) -> int:
    """Derive a 1-based delivery count from AMQP headers.

    Quorum queues expose ``x-delivery-count``: the number of prior redelivery
    attempts, 0 on first delivery, so num_delivered is that plus one (matching
    the NATS ``metadata.num_delivered`` contract the disposition compares against).
    Non-quorum queues carry no native count, so a keel-owned ``keel-delivery-count``
    header is the portable 1-based fallback. Absent both, this is the first delivery.
    """
    native = headers.get("x-delivery-count")
    if native is not None:
        return int(native) + 1
    portable = headers.get("keel-delivery-count")
    if portable is not None:
        return int(portable)
    return 1


def _decode_headers(headers: Mapping[str, Any] | None) -> dict[str, str]:
    """Coerce AMQP header values (str/bytes/int/...) to the port's str->str map."""
    decoded: dict[str, str] = {}
    for key, value in (headers or {}).items():
        decoded[key] = value.decode() if isinstance(value, bytes) else str(value)
    return decoded


class RabbitMqMessageBus:
    """A MessageBus backed by a RabbitMQ topic exchange for at-least-once delivery."""

    def __init__(
        self,
        url: str,
        *,
        exchange: str = "keel",
        queue: str = "keel",
        subjects: Sequence[str] = ("keel.#",),
        dlx: str = "keel.dlx",
        max_deliver: int = 5,
        prefetch: int = 256,
        logger: Logger | None = None,
    ) -> None:
        """Configure the broker URL, topic exchange/queue/subjects, and delivery policy.

        ``subjects`` are the routing-key bindings for the durable queue (the topic
        exchange's ``keel.#`` convention mirrors NATS's ``keel.>``). ``prefetch`` is
        the consumer QoS - the bound on unacked in-flight messages, the maxAckPending
        analog. ``dlx`` is the dead-letter exchange a poison message is published to at
        the delivery cap. ``logger`` records redelivery/termination decisions; it
        defaults to a structlog logger so a dead-lettered message is never dropped
        without a trace.
        """
        self._url = url
        self._exchange_name = exchange
        self._queue_name = queue
        self._subjects = list(subjects)
        self._dlx_name = dlx
        self._max_deliver = max_deliver
        self._prefetch = prefetch
        self._logger: Logger = logger or structlog.get_logger("keel.messaging")
        self._connection: AbstractRobustConnection | None = None
        self._channel: AbstractRobustChannel | None = None
        self._exchange: AbstractRobustExchange | None = None
        self._dlx: AbstractRobustExchange | None = None
        self._queue: AbstractRobustQueue | None = None

    async def connect(self) -> None:
        """Connect and declare the durable topic exchange, dead-letter exchange, and queue."""
        self._connection = await aio_pika.connect_robust(self._url)
        self._channel = await self._connection.channel()
        await self._channel.set_qos(prefetch_count=self._prefetch)
        self._exchange = await self._channel.declare_exchange(
            self._exchange_name, ExchangeType.TOPIC, durable=True
        )
        self._dlx = await self._channel.declare_exchange(
            self._dlx_name, ExchangeType.TOPIC, durable=True
        )
        # Quorum queues expose x-delivery-count, the native redelivery counter the
        # disposition reads; they are durable by construction.
        self._queue = await self._channel.declare_queue(
            self._queue_name, durable=True, arguments={"x-queue-type": "quorum"}
        )
        for subject in self._subjects:
            await self._queue.bind(self._exchange, routing_key=subject)

    async def publish(
        self, subject: str, payload: bytes, *, headers: Mapping[str, str] | None = None
    ) -> None:
        """Publish ``payload`` with ``subject`` as the routing key, injecting trace context."""
        if self._exchange is None:
            msg = "RabbitMqMessageBus.connect() must be called before publish()"
            raise RuntimeError(msg)
        carrier: dict[str, str] = dict(headers or {})
        propagate.inject(carrier)
        await self._exchange.publish(
            aio_pika.Message(body=payload, headers=dict(carrier)), routing_key=subject
        )

    async def _dispatch(self, message: AbstractIncomingMessage, handler: MessageHandler) -> None:
        """Run ``handler`` with trace context; ack on success, nack/dead-letter on failure."""
        raw_headers = message.headers or {}
        headers = _decode_headers(raw_headers)
        subject = message.routing_key or ""
        inbound = InboundMessage(subject=subject, payload=message.body, headers=headers)
        token = otel_context.attach(propagate.extract(headers))
        try:
            try:
                await handler(inbound)
            except Exception:  # one bad handler must not kill the subscription
                # Redeliver until the cap, then dead-letter. Always log the control-plane
                # decision: dead-lettering means the message is dropped from redelivery,
                # which must never be silent. (The handler still owns its own domain
                # error logging/tracing.)
                num_delivered = _num_delivered(raw_headers)
                fate = disposition(
                    handler_ok=False, num_delivered=num_delivered, max_deliver=self._max_deliver
                )
                if fate is Disposition.DEAD_LETTER:
                    # exception() captures the handler traceback that made this a poison
                    # message - the key diagnostic for a dead-letter.
                    self._logger.exception(
                        "message terminated after exhausting delivery attempts",
                        subject=subject,
                        exchange=self._exchange_name,
                        num_delivered=num_delivered,
                        max_deliver=self._max_deliver,
                    )
                    await self._dead_letter(message, subject, raw_headers)
                else:
                    self._logger.warning(
                        "message handler failed; scheduling redelivery",
                        subject=subject,
                        num_delivered=num_delivered,
                    )
                    await self._control(lambda: message.nack(requeue=True), "nack", subject)
                return
            await self._control(message.ack, "ack", subject)
        finally:
            otel_context.detach(token)

    async def _dead_letter(
        self, message: AbstractIncomingMessage, subject: str, headers: Mapping[str, Any]
    ) -> None:
        """Publish a poison message to the dead-letter exchange, then ack the original."""
        if self._dlx is None:
            msg = "RabbitMqMessageBus.connect() must be called before consuming"
            raise RuntimeError(msg)
        try:
            await self._dlx.publish(
                aio_pika.Message(body=message.body, headers=dict(headers)),
                routing_key=subject,
            )
        except Exception:
            # If the dead-letter publish fails, requeue rather than ack-and-drop so the
            # message is not lost; surface the failure so the anomaly is diagnosable.
            self._logger.exception("dead-letter publish failed", subject=subject)
            await self._control(lambda: message.nack(requeue=True), "nack", subject)
            return
        await self._control(message.ack, "ack", subject)

    async def _control(self, op: Any, name: str, subject: str) -> None:  # noqa: ANN401
        """Run an ack/nack call, logging (not raising) a control-plane failure."""
        try:
            await op()
        except Exception:
            # A failed ack/nack would otherwise vanish; surface it so redelivery or
            # duplicate-processing anomalies are diagnosable.
            self._logger.exception("amqp control call failed", op=name, subject=subject)

    async def subscribe(self, subject: str, handler: MessageHandler) -> None:
        """Deliver messages matching ``subject`` to ``handler`` via manual-ack consumption."""
        if self._queue is None or self._exchange is None:
            msg = "RabbitMqMessageBus.connect() must be called before subscribe()"
            raise RuntimeError(msg)
        # Bind the requested routing key so a subject outside the default bindings is
        # still delivered (topic bindings may overlap, unlike JetStream streams).
        await self._queue.bind(self._exchange, routing_key=subject)

        async def _callback(message: AbstractIncomingMessage) -> None:
            await self._dispatch(message, handler)

        await self._queue.consume(_callback)

    async def close(self) -> None:
        """Close the connection (call at shutdown)."""
        if self._connection is not None:
            await self._connection.close()
            self._connection = None
            self._channel = None
            self._exchange = None
            self._dlx = None
            self._queue = None

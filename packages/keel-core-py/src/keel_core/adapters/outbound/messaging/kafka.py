"""Kafka MessageBus adapter (ADR-0025; keel-core[kafka] extra).

Implements the MessageBus port over Kafka with a consumer group and auto-commit
OFF, so a record's offset is committed only after the handler acks. A ``subject``
maps to a Kafka topic (non-alphanumeric sanitized exactly as NATS durable names
are); publishing produces to that topic with W3C trace context injected into the
record headers and re-attached around each handler. The delivery contract matches
the NATS JetStream and RabbitMQ adapters: on handler failure below the cap the
record is re-produced to a retry topic (``<topic>.retry``) with an incremented
delivery-count header and the original offset committed so the partition is not
head-of-line blocked; at the cap it is produced to the dead-letter topic
(``<topic>.dlq``, overridable via ``KEEL_KAFKA_DLQ_TOPIC``) and committed, logged
at error so a poison record neither loops forever nor is dropped silently. Kafka
has no native per-message delivery count, so it rides in a keel-owned
``keel-delivery-count`` record header. The ack/retry/dead-letter decision is the
shared pure ``disposition`` function, unit-testable without a broker. If the retry
or dead-letter produce itself fails, the original offset is NOT committed, so the
record is redelivered rather than lost. Import from this module directly (it
requires the optional aiokafka dependency).
"""

from __future__ import annotations

import asyncio
import contextlib
import enum
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol

import structlog
from aiokafka import AIOKafkaConsumer, AIOKafkaProducer
from aiokafka.structs import TopicPartition
from opentelemetry import context as otel_context
from opentelemetry import propagate

from keel_core.ports.messaging import InboundMessage, MessageHandler

if TYPE_CHECKING:
    from keel_core.ports.logging import Logger

# The portable redelivery count Kafka does not track natively; it is incremented each time a
# failed record is re-produced to the retry topic.
_DELIVERY_COUNT_HEADER = "keel-delivery-count"

# Carries the ORIGINAL subject so it survives the lossy subject -> topic sanitization: a dotted
# subject (keel.test.events) maps to an underscored topic (keel_test_events), so the delivered
# InboundMessage.subject must come from this header, not the topic name, to equal what was
# published. Unlike NATS/RabbitMQ (whose subject IS the routing key, no transform), Kafka's topic
# is a one-way transform, so the subject travels explicitly in a header.
_SUBJECT_HEADER = "keel-subject"

# The retry and dead-letter topics derived from a base topic.
_RETRY_SUFFIX = ".retry"
_DLQ_SUFFIX = ".dlq"

# Replaces every non-alphanumeric/underscore character, the same rule the NATS adapter uses to
# sanitize durable names; the result is a subset of Kafka's legal topic alphabet.
_TOPIC_UNSAFE = re.compile(r"[^A-Za-z0-9_]")


class Disposition(enum.Enum):
    """The fate of a delivered record, decided purely from outcome + delivery count."""

    ACK = "ack"
    REDELIVER = "redeliver"
    DEAD_LETTER = "dead_letter"


def disposition(handler_ok: bool, num_delivered: int, max_deliver: int) -> Disposition:  # noqa: FBT001
    """Decide a record's fate from the handler outcome and delivery count.

    Pure, so the poison-handling policy is unit-testable without a broker: ack on
    success regardless of count; redeliver on failure under the cap; dead-letter at
    or over it. Mirrors the NATS/RabbitMQ/Go adapters' disposition function exactly.
    """
    if handler_ok:
        return Disposition.ACK
    if num_delivered >= max_deliver:
        return Disposition.DEAD_LETTER
    return Disposition.REDELIVER


def topic_name(subject: str) -> str:
    """Sanitize ``subject`` to a legal Kafka topic, matching the NATS durable-name rule."""
    return _TOPIC_UNSAFE.sub("_", subject)


def _base_topic(topic: str) -> str:
    """Strip the ``.retry`` suffix so a retried record routes to the base topic's handler."""
    if topic.endswith(_RETRY_SUFFIX):
        return topic[: -len(_RETRY_SUFFIX)]
    return topic


def _decode_headers(headers: Sequence[tuple[str, bytes]]) -> dict[str, str]:
    """Collapse record headers to the single-valued str->str propagation map the port exposes."""
    return {key: value.decode() for key, value in headers}


def _encode_headers(carrier: Mapping[str, str]) -> list[tuple[str, bytes]]:
    """Encode a str->str carrier to the (str, bytes) header list aiokafka produces."""
    return [(key, value.encode()) for key, value in carrier.items()]


def _delivery_count(headers: Sequence[tuple[str, bytes]]) -> int:
    """Read the 0-based redelivery count from the keel-delivery-count header.

    Returns 0 when the header is absent (the first delivery), malformed, or negative;
    the dispatch adds one to get the 1-based attempt count the disposition compares
    against, matching the NATS ``metadata.num_delivered`` convention.

    The count is parsed as a non-negative decimal integer. A principal with produce
    rights could otherwise stamp a large negative value (e.g. -100000000) to keep
    num_delivered far below the cap and drive ~100M consume->fail->re-produce cycles
    before dead-lettering - a redelivery-amplification DoS. int() strips surrounding
    whitespace and rejects non-decimal input; a negative value is clamped to 0, so a
    forged header can never delay the dead-letter past the honest cap.
    """
    for key, value in headers:
        if key == _DELIVERY_COUNT_HEADER:
            try:
                count = int(value)
            except ValueError:
                return 0
            return max(count, 0)
    return 0


def _set_delivery_count(headers: list[tuple[str, bytes]], count: int) -> list[tuple[str, bytes]]:
    """Set the keel-delivery-count header to ``count``, replacing any existing value."""
    encoded = str(count).encode()
    for index, (key, _) in enumerate(headers):
        if key == _DELIVERY_COUNT_HEADER:
            headers[index] = (key, encoded)
            return headers
    headers.append((_DELIVERY_COUNT_HEADER, encoded))
    return headers


@dataclass
class _Record:
    """A record flowing through dispatch, decoupled from aiokafka's ConsumerRecord.

    Carries the payload, key, and headers needed to re-produce it, plus the
    partition/offset the sink commits. A broker-free test constructs these directly.
    """

    topic: str
    value: bytes
    key: bytes | None = None
    headers: list[tuple[str, bytes]] = field(default_factory=list)
    partition: int = 0
    offset: int = 0


class _RecordSink(Protocol):
    """The slice of a Kafka client dispatch needs: produce a record and commit an offset.

    A Protocol so a broker-free test can supply a fake that records produces and
    commits without a live client.
    """

    async def produce(self, record: _Record) -> None:
        """Produce ``record`` to its topic."""
        ...

    async def commit(self, record: _Record) -> None:
        """Commit the consumed ``record``'s offset."""
        ...


class _AioKafkaSink:
    """The production record sink backed by a live aiokafka producer + consumer."""

    def __init__(self, producer: Any, consumer: Any) -> None:  # noqa: ANN401  # aiokafka is stub-less
        self._producer = producer
        self._consumer = consumer

    async def produce(self, record: _Record) -> None:
        """Produce ``record`` and wait for the broker ack, so a failure surfaces synchronously."""
        await self._producer.send_and_wait(
            record.topic, value=record.value, key=record.key, headers=record.headers
        )

    async def commit(self, record: _Record) -> None:
        """Commit the consumed record's offset (next offset = this record's + 1)."""
        partition = TopicPartition(record.topic, record.partition)
        await self._consumer.commit({partition: record.offset + 1})


class KafkaMessageBus:
    """A MessageBus backed by Kafka for durable at-least-once delivery."""

    def __init__(
        self,
        brokers: Sequence[str],
        *,
        topics: Sequence[str] = ("keel",),
        group_id: str = "keel",
        dlq_topic: str | None = None,
        max_deliver: int = 5,
        logger: Logger | None = None,
    ) -> None:
        """Configure the bootstrap brokers, topics (subjects), consumer group, and delivery policy.

        ``brokers`` is the gate: the comma-separated ``KEEL_KAFKA_BROKERS`` parsed into a
        list of bootstrap servers. ``topics`` (``KEEL_KAFKA_TOPICS``) are the subjects the
        consumer group subscribes to, each sanitized to a legal topic with its ``<topic>.retry``
        sibling consumed too. ``group_id`` is ``KEEL_KAFKA_GROUP_ID``. ``dlq_topic``
        (``KEEL_KAFKA_DLQ_TOPIC``) overrides the per-topic ``<topic>.dlq`` destination with a
        single shared dead-letter topic. ``logger`` records redelivery/dead-letter decisions; it
        defaults to a structlog logger so a dead-lettered record is never dropped without a trace.
        """
        self._brokers = list(brokers)
        self._topics = list(topics)
        self._group_id = group_id
        self._dlq_topic_override = dlq_topic
        self._max_deliver = max_deliver
        self._logger: Logger = logger or structlog.get_logger("keel.messaging")
        self._producer: Any = None  # aiokafka AIOKafkaProducer
        self._consumer: Any = None  # aiokafka AIOKafkaConsumer
        self._sink: _RecordSink | None = None
        self._handlers: dict[str, MessageHandler] = {}
        self._subscribed: set[str] = set()
        self._poll_task: asyncio.Task[None] | None = None

    def _consume_topics(self) -> list[str]:
        """The configured topics plus their ``.retry`` siblings, the initial subscription."""
        topics: set[str] = set()
        for subject in self._topics:
            tn = topic_name(subject)
            topics.add(tn)
            topics.add(tn + _RETRY_SUFFIX)
        return sorted(topics)

    async def connect(self) -> None:
        """Start the producer and a consumer group (auto-commit OFF), failing fast on a dead broker.

        Lazy: no client exists until this is called, so building the bus never blocks startup.
        A connect failure never echoes the broker list or SASL config into the error, so
        credentials cannot leak through the logs.
        """
        self._subscribed = set(self._consume_topics())
        self._producer = AIOKafkaProducer(bootstrap_servers=self._brokers)
        self._consumer = AIOKafkaConsumer(
            *sorted(self._subscribed),
            bootstrap_servers=self._brokers,
            group_id=self._group_id,
            # Auto-commit OFF: the offset is committed only after the handler acks (success) or the
            # record has a home on the retry/dead-letter topic, never before the work is done.
            enable_auto_commit=False,
            auto_offset_reset="earliest",
        )
        try:
            await self._producer.start()
            await self._consumer.start()
        except Exception:
            await self._stop_clients()
            # Never surface the broker list or SASL config in the error: a connect failure must
            # not leak credentials. Re-raise a static message and drop the original cause (which
            # may embed the bootstrap address).
            msg = "failed to connect to Kafka"
            raise ConnectionError(msg) from None
        self._sink = _AioKafkaSink(self._producer, self._consumer)

    async def publish(
        self, subject: str, payload: bytes, *, headers: Mapping[str, str] | None = None
    ) -> None:
        """Publish ``payload`` to ``subject``'s topic, injecting trace context into the headers."""
        if self._sink is None:
            msg = "KafkaMessageBus.connect() must be called before publish()"
            raise RuntimeError(msg)
        carrier: dict[str, str] = dict(headers or {})
        # Carry the original subject so the consumer can report it verbatim; the topic name is a
        # lossy sanitization and cannot be inverted back to the subject.
        carrier[_SUBJECT_HEADER] = subject
        propagate.inject(carrier)
        record = _Record(topic=topic_name(subject), value=payload, headers=_encode_headers(carrier))
        await self._sink.produce(record)

    async def subscribe(self, subject: str, handler: MessageHandler) -> None:
        """Deliver records on ``subject``'s topic (and its retry sibling) to ``handler``.

        Starts the poll loop on the first call; a retried record on ``<topic>.retry`` is routed
        back to the base topic's handler so the retry loop converges on the same consumer.
        """
        if self._consumer is None:
            msg = "KafkaMessageBus.connect() must be called before subscribe()"
            raise RuntimeError(msg)
        tn = topic_name(subject)
        self._handlers[tn] = handler
        new = {tn, tn + _RETRY_SUFFIX} - self._subscribed
        if new:
            self._subscribed |= new
            self._consumer.subscribe(topics=sorted(self._subscribed))
        if self._poll_task is None:
            self._poll_task = asyncio.create_task(self._poll_loop())

    async def _poll_loop(self) -> None:
        """Fetch records and route each to its registered handler until the consumer stops.

        A fetch-level error is logged, not raised, so a transient broker hiccup does not tear
        down the consumer.
        """
        assert self._consumer is not None  # noqa: S101  # started in connect() before the loop runs
        try:
            async for message in self._consumer:
                base = _base_topic(message.topic)
                handler = self._handlers.get(base)
                if handler is None:
                    continue
                await self._dispatch(_record_from_consumer(message), handler)
        except asyncio.CancelledError:
            raise
        except Exception:
            self._logger.exception("kafka poll loop error")

    async def _dispatch(self, record: _Record, handler: MessageHandler) -> None:
        """Run ``handler`` with trace context; commit on success, retry/dead-letter on failure."""
        headers = _decode_headers(record.headers)
        base = _base_topic(record.topic)
        # The subject is reported from the keel-subject header (the original, pre-sanitization
        # subject); fall back to the topic name when the header is absent (e.g. a record produced
        # outside this adapter). The retry/dlq topic derivation stays keyed on the sanitized topic.
        subject = headers.get(_SUBJECT_HEADER, base)
        inbound = InboundMessage(subject=subject, payload=record.value, headers=headers)
        num_delivered = _delivery_count(record.headers) + 1
        token = otel_context.attach(propagate.extract(headers))
        try:
            try:
                await handler(inbound)
            except Exception:  # one bad handler must not kill the poll loop
                # Redeliver until the cap, then dead-letter. Always log the control-plane
                # decision: dead-lettering drops the record from redelivery, which must never be
                # silent. (The handler still owns its own domain error logging/tracing.)
                fate = disposition(
                    handler_ok=False, num_delivered=num_delivered, max_deliver=self._max_deliver
                )
                if fate is Disposition.DEAD_LETTER:
                    # exception() captures the handler traceback that made this a poison record -
                    # the key diagnostic for a dead-letter.
                    self._logger.exception(
                        "message terminated after exhausting delivery attempts",
                        subject=base,
                        dlq_topic=self._dlq_topic(base),
                        num_delivered=num_delivered,
                        max_deliver=self._max_deliver,
                    )
                    await self._dead_letter(record, base)
                else:
                    self._logger.warning(
                        "message handler failed; scheduling redelivery",
                        subject=base,
                        retry_topic=base + _RETRY_SUFFIX,
                        num_delivered=num_delivered,
                    )
                    await self._redeliver(record, base, num_delivered)
                return
            await self._control(record, "commit", base)
        finally:
            otel_context.detach(token)

    async def _redeliver(self, record: _Record, base: str, num_delivered: int) -> None:
        """Re-produce ``record`` to ``<base>.retry`` with the bumped count, then commit the base.

        If the retry produce fails, the record has no home: leave the offset uncommitted so the
        consumer group redelivers it rather than silently dropping it.
        """
        assert self._sink is not None  # noqa: S101  # set in connect() before any record is dispatched
        retry = _Record(
            topic=base + _RETRY_SUFFIX,
            value=record.value,
            key=record.key,
            headers=_set_delivery_count(list(record.headers), num_delivered),
        )
        try:
            await self._sink.produce(retry)
        except Exception:
            self._logger.exception(
                "retry produce failed; offset left uncommitted for redelivery",
                subject=base,
                retry_topic=base + _RETRY_SUFFIX,
            )
            return
        await self._control(record, "commit", base)

    async def _dead_letter(self, record: _Record, base: str) -> None:
        """Produce the poison record to the dead-letter topic, then commit the original.

        If the dead-letter produce fails, leave the offset uncommitted so the record is
        redelivered rather than lost (mirrors the RabbitMQ preserve-on-dead-letter-failure policy).
        """
        assert self._sink is not None  # noqa: S101  # set in connect() before any record is dispatched
        dlq = self._dlq_topic(base)
        dead = _Record(topic=dlq, value=record.value, key=record.key, headers=list(record.headers))
        try:
            await self._sink.produce(dead)
        except Exception:
            self._logger.exception(
                "dead-letter produce failed; offset left uncommitted for redelivery",
                subject=base,
                dlq_topic=dlq,
            )
            return
        await self._control(record, "commit", base)

    async def _control(self, record: _Record, name: str, subject: str) -> None:
        """Run a commit call, logging (not raising) a control-plane failure."""
        assert self._sink is not None  # noqa: S101  # set in connect() before any record is dispatched
        try:
            await self._sink.commit(record)
        except Exception:
            # A failed commit would otherwise vanish; surface it so redelivery or
            # duplicate-processing anomalies are diagnosable.
            self._logger.exception("kafka control call failed", op=name, subject=subject)

    def _dlq_topic(self, base: str) -> str:
        """The dead-letter destination: the shared override when set, else ``<base>.dlq``."""
        if self._dlq_topic_override:
            return self._dlq_topic_override
        return base + _DLQ_SUFFIX

    async def _stop_clients(self) -> None:
        """Stop the consumer then the producer, swallowing errors (on connect failure or close)."""
        for client in (self._consumer, self._producer):
            if client is None:
                continue
            # Best-effort teardown: a stop failure has nothing to recover and must not mask the
            # original connect error or block shutdown.
            with contextlib.suppress(Exception):
                await client.stop()

    async def close(self) -> None:
        """Stop the poll loop and the clients (call at shutdown)."""
        if self._poll_task is not None:
            self._poll_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._poll_task
            self._poll_task = None
        await self._stop_clients()
        self._producer = None
        self._consumer = None
        self._sink = None


def _record_from_consumer(message: Any) -> _Record:  # noqa: ANN401  # aiokafka ConsumerRecord is stub-less
    """Convert an aiokafka ConsumerRecord to the broker-agnostic ``_Record`` dispatch uses."""
    headers = [(key, bytes(value)) for key, value in (message.headers or ())]
    return _Record(
        topic=message.topic,
        value=message.value,
        key=message.key,
        headers=headers,
        partition=message.partition,
        offset=message.offset,
    )

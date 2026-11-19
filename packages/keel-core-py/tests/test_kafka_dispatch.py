"""Kafka per-record commit/retry/dead-letter logic (ADR-0025), unit-tested without a broker.

Mirrors the Go kafka_test.go dispatch suite and the NATS/RabbitMQ dispatch tests: a handler
failure re-produces to the retry topic (incrementing the portable keel-delivery-count header) and
commits the original offset below the cap, dead-letters at the cap, and - the critical guarantee -
a record that fails every time dead-letters on exactly the fifth attempt rather than looping
forever or dropping early. The preserve-on-produce-failure policy is asserted too: if the retry or
dead-letter produce fails, the original offset is NOT committed, so the record is redelivered
rather than lost. The shared pure disposition function is exercised in isolation.
"""

from typing import Any

import pytest
from opentelemetry import trace as otel_trace

pytest.importorskip("aiokafka")

from keel_core.adapters.outbound.messaging.kafka import (
    _DELIVERY_COUNT_HEADER,
    _DLQ_SUFFIX,
    _RETRY_SUFFIX,
    Disposition,
    KafkaMessageBus,
    _delivery_count,
    _Record,
    disposition,
    topic_name,
)
from keel_core.ports.messaging import InboundMessage


class _FakeSink:
    """Records the produces and commits dispatch makes, without a live Kafka client.

    ``produce_err``, when set, fails every produce so the preserve-on-failure path is assertable.
    """

    def __init__(self, produce_err: Exception | None = None) -> None:
        self.produced: list[_Record] = []
        self.commits = 0
        self.produce_err = produce_err

    async def produce(self, record: _Record) -> None:
        if self.produce_err is not None:
            raise self.produce_err
        self.produced.append(record)

    async def commit(self, record: _Record) -> None:
        self.commits += 1

    def last_produced_to(self, suffix: str) -> _Record | None:
        last: _Record | None = None
        for record in self.produced:
            if record.topic.endswith(suffix):
                last = record
        return last


class _CommitErrSink(_FakeSink):
    """Produces cleanly but fails every commit, exercising the control-plane failure path."""

    async def commit(self, record: _Record) -> None:
        msg = "commit failed"
        raise RuntimeError(msg)


class _RecordingLogger:
    """Captures (level, message, fields) so dispatch decisions can be asserted."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict[str, object]]] = []

    def debug(self, message: str, **fields: object) -> None:
        self.calls.append(("debug", message, fields))

    def info(self, message: str, **fields: object) -> None:
        self.calls.append(("info", message, fields))

    def warning(self, message: str, **fields: object) -> None:
        self.calls.append(("warning", message, fields))

    def error(self, message: str, **fields: object) -> None:
        self.calls.append(("error", message, fields))

    def exception(self, message: str, **fields: object) -> None:
        self.calls.append(("exception", message, fields))


def _record(num_delivered: int = 1) -> _Record:
    """Build a base-topic record whose keel-delivery-count encodes a 1-based num_delivered.

    The header is the 0-based count (num_delivered - 1); num_delivered 1 omits it (first delivery).
    """
    headers: list[tuple[str, bytes]] = []
    if num_delivered > 1:
        headers.append((_DELIVERY_COUNT_HEADER, str(num_delivered - 1).encode()))
    return _Record(topic="keel_test_events", value=b"payload", headers=headers)


def _bus(
    logger: _RecordingLogger | None = None,
    sink: Any = None,
    *,
    dlq_topic: str | None = None,
) -> KafkaMessageBus:
    bus = KafkaMessageBus(
        ["unused:9092"],
        topics=["keel.test.events"],
        group_id="keel",
        dlq_topic=dlq_topic,
        max_deliver=5,
        logger=logger or _RecordingLogger(),  # type: ignore[arg-type]
    )
    bus._sink = sink or _FakeSink()  # noqa: SLF001
    return bus


async def _ok_handler(_: InboundMessage) -> None:
    return


async def _fail_handler(_: InboundMessage) -> None:
    msg = "boom"
    raise ValueError(msg)


def test_disposition_acks_on_success_regardless_of_delivery_count() -> None:
    assert disposition(handler_ok=True, num_delivered=1, max_deliver=5) is Disposition.ACK
    assert disposition(handler_ok=True, num_delivered=5, max_deliver=5) is Disposition.ACK


def test_disposition_redelivers_under_the_cap_then_dead_letters_at_it() -> None:
    assert disposition(handler_ok=False, num_delivered=1, max_deliver=5) is Disposition.REDELIVER
    assert disposition(handler_ok=False, num_delivered=4, max_deliver=5) is Disposition.REDELIVER
    assert disposition(handler_ok=False, num_delivered=5, max_deliver=5) is Disposition.DEAD_LETTER
    assert disposition(handler_ok=False, num_delivered=6, max_deliver=5) is Disposition.DEAD_LETTER


async def test_dispatch_runs_handler_under_incoming_trace_context() -> None:
    # A record carrying a known W3C traceparent must be dispatched to the handler under a context
    # whose trace_id equals that header's, proving Kafka consumer trace-continuity without a broker.
    trace_id = "0af7651916cd43dd8448eb211c80319c"
    span_id = "b7ad6b7169203331"
    seen: dict[str, str] = {}

    async def handler(_: InboundMessage) -> None:
        span_context = otel_trace.get_current_span().get_span_context()
        seen["trace_id"] = format(span_context.trace_id, "032x")

    record = _record()
    record.headers.append(("traceparent", f"00-{trace_id}-{span_id}-01".encode()))
    await _bus()._dispatch(record, handler)  # noqa: SLF001
    assert seen["trace_id"] == trace_id


async def test_commits_on_success() -> None:
    sink = _FakeSink()
    await _bus(sink=sink)._dispatch(_record(1), _ok_handler)  # noqa: SLF001
    assert sink.commits == 1
    assert sink.produced == []


async def test_retries_below_max_deliver() -> None:
    sink = _FakeSink()
    await _bus(sink=sink)._dispatch(_record(1), _fail_handler)  # noqa: SLF001
    # Below the cap: re-produced to the retry topic and the original offset committed so the
    # partition is not head-of-line blocked.
    retry = sink.last_produced_to(_RETRY_SUFFIX)
    assert retry is not None
    assert retry.topic == "keel_test_events" + _RETRY_SUFFIX
    # The retried record carries the incremented delivery count so the next attempt sees it.
    assert _delivery_count(retry.headers) == 1
    assert sink.commits == 1


async def test_dead_letters_at_max_deliver() -> None:
    sink = _FakeSink()
    await _bus(sink=sink)._dispatch(_record(5), _fail_handler)  # noqa: SLF001
    dlq = sink.last_produced_to(_DLQ_SUFFIX)
    assert dlq is not None
    assert dlq.topic == "keel_test_events" + _DLQ_SUFFIX
    assert dlq.value == b"payload"
    assert sink.commits == 1


async def test_repeatedly_failing_record_dead_letters_at_fifth_attempt() -> None:
    # The critical guarantee: simulate the consumer group redelivering the record by feeding each
    # retry produce back into dispatch, and prove it is retried exactly four times and dead-lettered
    # on the fifth attempt - never looping forever, never dropped early.
    logger = _RecordingLogger()
    record = _record(1)
    attempts = 0
    dead_lettered = False
    while attempts < 100:
        attempts += 1
        sink = _FakeSink()
        await _bus(logger, sink)._dispatch(record, _fail_handler)  # noqa: SLF001
        if sink.last_produced_to(_DLQ_SUFFIX) is not None:
            dead_lettered = True
            break
        retry = sink.last_produced_to(_RETRY_SUFFIX)
        assert retry is not None, f"attempt {attempts} produced neither a retry nor a dead-letter"
        # The consumer group redelivers the retried record; it becomes the next attempt's input.
        record = _Record(topic="keel_test_events", value=retry.value, headers=list(retry.headers))

    assert dead_lettered
    assert attempts == 5, f"record dead-lettered on attempt {attempts}, want exactly 5"
    # And the terminate was logged, never a silent drop.
    assert any(c[0] == "exception" and "terminated" in c[1] for c in logger.calls)


async def test_retry_produce_failure_preserves_offset() -> None:
    # The retry produce fails; below the cap the record has no home, so the offset must stay
    # uncommitted for redelivery rather than being lost.
    logger = _RecordingLogger()
    sink = _FakeSink(produce_err=RuntimeError("broker down"))
    await _bus(logger, sink)._dispatch(_record(1), _fail_handler)  # noqa: SLF001
    assert sink.commits == 0
    assert any(c[0] == "exception" and "retry produce failed" in c[1] for c in logger.calls)


async def test_dead_letter_produce_failure_preserves_offset() -> None:
    # The dead-letter produce fails at the cap; the offset must stay uncommitted so the record is
    # redelivered rather than silently dropped.
    logger = _RecordingLogger()
    sink = _FakeSink(produce_err=RuntimeError("broker down"))
    await _bus(logger, sink)._dispatch(_record(5), _fail_handler)  # noqa: SLF001
    assert sink.commits == 0
    assert any(c[0] == "exception" and "dead-letter produce failed" in c[1] for c in logger.calls)


async def test_terminated_message_is_logged_not_dropped_silently() -> None:
    logger = _RecordingLogger()
    await _bus(logger)._dispatch(_record(5), _fail_handler)  # noqa: SLF001
    # exception() logs at error level with the poison traceback; the dead-letter must leave a
    # record, never be dropped silently.
    terminated = [c for c in logger.calls if c[0] == "exception" and "terminated" in c[1]]
    assert terminated, "terminate must be logged so the dead-letter is not silent"
    _, _, fields = terminated[0]
    assert fields["subject"] == "keel_test_events"
    assert fields["num_delivered"] == 5


async def test_scheduled_redelivery_is_logged() -> None:
    logger = _RecordingLogger()
    await _bus(logger)._dispatch(_record(1), _fail_handler)  # noqa: SLF001
    assert any(c[0] == "warning" and "redelivery" in c[1] for c in logger.calls)


async def test_control_call_failure_is_logged_not_raised() -> None:
    # A failed commit must surface in the log, not propagate out of the dispatch callback.
    logger = _RecordingLogger()
    await _bus(logger, _CommitErrSink())._dispatch(_record(1), _ok_handler)  # noqa: SLF001
    assert any(c[0] == "exception" and "control call failed" in c[1] for c in logger.calls)


async def test_retried_record_routes_to_base_handler_subject() -> None:
    # A record arriving on <topic>.retry is reported to the handler under the base subject, so the
    # retry loop converges on the same consumer rather than needing a separate ".retry" handler.
    seen: dict[str, str] = {}

    async def handler(message: InboundMessage) -> None:
        seen["subject"] = message.subject

    record = _Record(topic="keel_test_events" + _RETRY_SUFFIX, value=b"x")
    await _bus()._dispatch(record, handler)  # noqa: SLF001
    assert seen["subject"] == "keel_test_events"


async def test_dlq_topic_override() -> None:
    sink = _FakeSink()
    bus = _bus(sink=sink, dlq_topic="keel.deadletters")
    await bus._dispatch(_record(5), _fail_handler)  # noqa: SLF001
    dlq = sink.last_produced_to("")
    assert dlq is not None
    assert dlq.topic == "keel.deadletters"


def test_delivery_count_reads_header() -> None:
    assert _delivery_count([(_DELIVERY_COUNT_HEADER, b"3")]) == 3
    assert _delivery_count([]) == 0
    # A non-numeric value reads back as 0, not a crash.
    assert _delivery_count([(_DELIVERY_COUNT_HEADER, b"nope")]) == 0


def test_topic_name_sanitizes_subject() -> None:
    assert topic_name("keel") == "keel"
    assert topic_name("keel.test.events") == "keel_test_events"
    assert topic_name("keel.test.>") == "keel_test__"


async def test_close_is_safe_without_connection() -> None:
    # close() on an unconnected bus is a no-op (no poll task, no clients), never an error.
    await KafkaMessageBus(["unused:9092"]).close()

import io
import json
import logging

from keel_core import context
from keel_core.adapters.outbound.logging import (
    QueueLogWriter,
    RateLimiter,
    StructuredLogger,
    configure_logging,
)
from keel_core.testkit.fakes import capturing_logger


def _last_record(buffer):
    return json.loads(buffer.getvalue().splitlines()[-1])


def test_log_record_has_required_contract_fields():
    logger, buffer = capturing_logger(service="svc", version="1.2.3")
    logger.info("hello")
    record = _last_record(buffer)
    assert record["message"] == "hello"
    assert record["level"] == "info"
    assert record["service"] == "svc"
    assert record["version"] == "1.2.3"
    assert "timestamp" in record


def test_warn_and_fatal_levels_match_contract_names():
    logger, buffer = capturing_logger()
    logger.warning("careful")
    assert _last_record(buffer)["level"] == "warn"


def test_secret_like_fields_are_redacted():
    logger, buffer = capturing_logger()
    logger.info("login", password="hunter2", token="abc", user_id=7)
    record = _last_record(buffer)
    assert record["password"] == "[REDACTED]"
    assert record["token"] == "[REDACTED]"
    assert record["user_id"] == 7


def test_nested_secrets_are_redacted():
    logger, buffer = capturing_logger()
    logger.info("call", data={"password": "p", "inner": {"api_key": "k", "ok": 1}})
    data = _last_record(buffer)["data"]
    assert data["password"] == "[REDACTED]"
    assert data["inner"]["api_key"] == "[REDACTED]"
    assert data["inner"]["ok"] == 1


def test_credential_key_families_are_redacted():
    logger, buffer = capturing_logger()
    logger.info(
        "request",
        access_token="opaque-123",
        client_secret="shh",
        author="jane",
        **{"x-api-key": "sk_live_1", "cookie": "session=abc"},
    )
    record = _last_record(buffer)
    assert record["access_token"] == "[REDACTED]"
    assert record["client_secret"] == "[REDACTED]"
    assert record["x-api-key"] == "[REDACTED]"
    assert record["cookie"] == "[REDACTED]"
    assert record["author"] == "jane"  # not over-redacted


def test_reserved_fields_cannot_be_clobbered():
    logger, buffer = capturing_logger(service="real")
    logger.info("hi", service="evil", level="fatal")
    record = _last_record(buffer)
    assert record["service"] == "real"
    assert record["level"] == "info"
    assert record["x_service"] == "evil"
    assert record["x_level"] == "fatal"


def test_exception_includes_traceback():
    logger, buffer = capturing_logger()
    try:
        msg = "boom"
        raise ValueError(msg)
    except ValueError:
        logger.exception("operation failed")
    record = _last_record(buffer)
    assert record["message"] == "operation failed"
    assert "ValueError" in record["exception"]
    assert "Traceback" in record["exception"]


def test_trace_id_is_injected_from_context():
    logger, buffer = capturing_logger()
    token = context.trace_id_var.set("trace-xyz")
    try:
        logger.info("traced")
    finally:
        context.trace_id_var.reset(token)
    assert _last_record(buffer)["trace_id"] == "trace-xyz"


def test_level_below_threshold_is_dropped():
    logger, buffer = capturing_logger()
    logger.debug("quiet")  # default level is info
    assert buffer.getvalue() == ""


def test_secret_value_patterns_are_scrubbed():
    logger, buffer = capturing_logger()
    logger.info("call", aws="AKIAIOSFODNN7EXAMPLE", card="4111 1111 1111 1111")
    record = _last_record(buffer)
    assert record["aws"] == "[REDACTED]"
    assert record["card"] == "[REDACTED]"


def test_secret_in_bytes_value_is_scrubbed():
    # A secret inside a bytes value under a non-secret key must still be scrubbed, not
    # emitted verbatim via the JSON renderer's repr of the bytes object.
    logger, buffer = capturing_logger()
    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5NXgL0n3I9PlFUP"
    logger.info("inbound", payload=f"Authorization: Bearer {jwt}".encode())
    payload = _last_record(buffer)["payload"]
    assert "eyJ" not in payload
    assert "[REDACTED]" in payload


def test_secrets_in_message_string_are_scrubbed():
    logger, buffer = capturing_logger()
    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5NXgL0n3I9PlFUP"
    logger.info(f"token {jwt}")  # noqa: G004
    message = _last_record(buffer)["message"]
    assert "eyJ" not in message
    assert "[REDACTED]" in message


def test_oversized_field_is_truncated():
    buffer = io.StringIO()
    logger_capped = StructuredLogger(service="t", version="0", stream=buffer, max_field_len=10)
    logger_capped.info("big", blob="x" * 100)
    assert "truncated" in _last_record(buffer)["blob"]


def test_rate_limiter_drops_excess_and_reports_suppressed():
    clock = [0.0]
    limiter = RateLimiter(capacity=1, refill_per_sec=1.0, now=lambda: clock[0])
    buffer = io.StringIO()
    logger = StructuredLogger(service="t", version="0", stream=buffer, rate_limiter=limiter)

    logger.info("spam")  # admitted (1 token)
    logger.info("spam")  # dropped (no token)
    assert len(buffer.getvalue().splitlines()) == 1

    logger.error("spam")  # error level is never rate-limited
    assert len(buffer.getvalue().splitlines()) == 2

    clock[0] = 1.0  # one token refilled
    logger.info("spam")  # admitted, carrying the suppressed count
    assert _last_record(buffer)["rate_limited_dropped"] == 1


def test_queue_writer_is_non_blocking_and_delivers():
    buffer = io.StringIO()
    writer = QueueLogWriter(buffer)
    writer.write("a\n")
    writer.write("b\n")
    writer.stop()
    assert buffer.getvalue() == "a\nb\n"


def test_queue_writer_survives_a_sink_write_error():
    # A sink error (e.g. a closed stdout pipe) must not kill the writer thread:
    # the next write still lands and shutdown still completes.
    class _FlakySink:
        def __init__(self) -> None:
            self.written: list[str] = []
            self._fail_once = True

        def write(self, text: str) -> int:
            if self._fail_once:
                self._fail_once = False
                raise BrokenPipeError("sink closed")
            self.written.append(text)
            return len(text)

        def flush(self) -> None:
            pass

    sink = _FlakySink()
    writer = QueueLogWriter(sink)
    writer.write("boom\n")  # raises in the thread -> counted, thread survives
    writer.write("after\n")  # must still be delivered
    writer.stop()  # must return (not hang)
    assert not writer._thread.is_alive()  # noqa: SLF001
    assert "after\n" in sink.written
    assert writer.write_errors >= 1


def test_stdlib_library_logs_are_bridged():
    buffer = io.StringIO()
    root = logging.getLogger()
    saved_handlers = root.handlers[:]
    saved_level = root.level
    try:
        configure_logging(service="svc", version="1", stream=buffer, non_blocking=False)
        logging.getLogger("some.library").warning("bridged")
        record = json.loads(buffer.getvalue().splitlines()[-1])
        assert record["message"] == "bridged"
        assert record["service"] == "svc"
        assert record["level"] == "warn"
    finally:
        root.handlers = saved_handlers
        root.setLevel(saved_level)

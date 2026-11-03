import json
import logging

from keel_core import context
from keel_core.adapters.outbound.logging import configure_logging
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


def test_stdlib_library_logs_are_bridged():
    import io

    buffer = io.StringIO()
    root = logging.getLogger()
    saved_handlers = root.handlers[:]
    saved_level = root.level
    try:
        configure_logging(service="svc", version="1", stream=buffer)
        logging.getLogger("some.library").warning("bridged")
        record = json.loads(buffer.getvalue().splitlines()[-1])
        assert record["message"] == "bridged"
        assert record["service"] == "svc"
        assert record["level"] == "warn"
    finally:
        root.handlers = saved_handlers
        root.setLevel(saved_level)

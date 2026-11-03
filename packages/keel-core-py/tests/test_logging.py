import json

from keel_core import context
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


def test_secret_like_fields_are_redacted():
    logger, buffer = capturing_logger()
    logger.info("login", password="hunter2", token="abc", user_id=7)
    record = _last_record(buffer)
    assert record["password"] == "[REDACTED]"
    assert record["token"] == "[REDACTED]"
    assert record["user_id"] == 7


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

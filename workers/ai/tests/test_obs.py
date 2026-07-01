"""Observability module (obs.py) + the /metrics endpoint.

Covers: Prometheus request recording + exposition, the JSON log formatter and
setup_logging (json/plain), and the gated Sentry init (no DSN / DSN + missing SDK
/ DSN + SDK present). Root-logger state is saved and restored so configuring
logging here never leaks into other tests.
"""

from __future__ import annotations

import json
import logging
import sys

import pytest
from fastapi.testclient import TestClient

from tia_ai import obs
from tia_ai.api.app import app


@pytest.fixture()
def _restore_root_logging():
    root = logging.getLogger()
    saved_handlers = root.handlers[:]
    saved_level = root.level
    yield
    root.handlers[:] = saved_handlers
    root.setLevel(saved_level)


# ── Prometheus metrics ────────────────────────────────────────────────────────


def test_observe_request_and_exposition():
    obs.observe_request("GET", "/health", 200, 0.012)
    body, ctype = obs.metrics_exposition()
    assert isinstance(body, (bytes, bytearray))
    assert "text/plain" in ctype  # prometheus exposition content type
    text = body.decode()
    assert "tia_http_requests_total" in text
    assert "tia_http_request_duration_seconds" in text


def test_metrics_endpoint_scrapes_ok():
    with TestClient(app) as c:
        # prior request so at least one sample exists, then scrape
        c.get("/health")
        r = c.get("/metrics")
    assert r.status_code == 200
    assert "tia_http_requests_total" in r.text
    assert "tia_http_request_duration_seconds" in r.text
    # the earlier /health request was recorded under its route template
    assert "/health" in r.text


# ── structured logging ────────────────────────────────────────────────────────


def test_json_formatter_emits_valid_json_with_exc():
    fmt = obs._JsonFormatter()
    rec = logging.LogRecord("tia.test", logging.INFO, __file__, 1, "hello %s", ("world",), None)
    parsed = json.loads(fmt.format(rec))
    assert parsed["level"] == "INFO"
    assert parsed["logger"] == "tia.test"
    assert parsed["msg"] == "hello world"
    assert "exc" not in parsed

    try:
        raise ValueError("boom")
    except ValueError:
        rec2 = logging.LogRecord(
            "tia.test", logging.ERROR, __file__, 2, "failed", (), sys.exc_info()
        )
    parsed2 = json.loads(fmt.format(rec2))
    assert "exc" in parsed2 and "ValueError" in parsed2["exc"]


def test_setup_logging_json_and_plain(_restore_root_logging):
    obs.setup_logging(level="debug", json_format=True)
    root = logging.getLogger()
    assert root.level == logging.DEBUG
    assert isinstance(root.handlers[0].formatter, obs._JsonFormatter)

    obs.setup_logging(level="warning", json_format=False)
    assert root.level == logging.WARNING
    assert not isinstance(root.handlers[0].formatter, obs._JsonFormatter)


def test_setup_logging_reads_env(monkeypatch, _restore_root_logging):
    monkeypatch.setenv("LOG_LEVEL", "error")
    monkeypatch.setenv("LOG_FORMAT", "json")
    obs.setup_logging()
    root = logging.getLogger()
    assert root.level == logging.ERROR
    assert isinstance(root.handlers[0].formatter, obs._JsonFormatter)


# ── gated error tracking ──────────────────────────────────────────────────────


def test_init_error_tracking_noop_without_dsn(monkeypatch):
    monkeypatch.delenv("SENTRY_DSN", raising=False)
    assert obs.init_error_tracking() is False


def test_init_error_tracking_missing_sdk_returns_false(monkeypatch):
    monkeypatch.setenv("SENTRY_DSN", "https://x@example.test/1")
    monkeypatch.setitem(sys.modules, "sentry_sdk", None)  # force ImportError on `import sentry_sdk`
    assert obs.init_error_tracking() is False


def test_init_error_tracking_enabled_with_fake_sdk(monkeypatch):
    import types

    calls = {}

    fake = types.ModuleType("sentry_sdk")
    fake.init = lambda **kw: calls.update(kw)  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "sentry_sdk", fake)
    monkeypatch.setenv("SENTRY_DSN", "https://k@example.test/42")
    monkeypatch.setenv("SENTRY_TRACES_SAMPLE_RATE", "0.25")

    assert obs.init_error_tracking() is True
    assert calls["dsn"] == "https://k@example.test/42"
    assert calls["traces_sample_rate"] == 0.25

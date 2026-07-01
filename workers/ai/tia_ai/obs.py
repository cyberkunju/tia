"""Observability: Prometheus metrics, structured logging, optional error tracking.

Kept deliberately light for a single-box deploy — no OTLP/Grafana stack. The
`/metrics` endpoint (wired in api/app.py) exposes standard Prometheus counters
and a latency histogram; request labels use the ROUTE TEMPLATE (e.g.
`/invoices/{inv_id}`), never the concrete path, so cardinality stays bounded.

Error tracking is opt-in: set SENTRY_DSN (and install the `sentry` extra) and
init_error_tracking() wires Sentry; otherwise it is a no-op. Nothing here ever
raises into the request path.
"""

from __future__ import annotations

import logging
import os
import sys

from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest

log = logging.getLogger("tia.obs")

# ── HTTP metrics (labels use the route template to bound cardinality) ─────────
HTTP_REQUESTS = Counter(
    "tia_http_requests_total",
    "Total HTTP requests handled by the API.",
    ["method", "path", "status"],
)
HTTP_LATENCY = Histogram(
    "tia_http_request_duration_seconds",
    "HTTP request latency in seconds.",
    ["method", "path"],
)


def observe_request(method: str, path: str, status: int, duration_s: float) -> None:
    """Record one handled request. Never raises (observability must not break traffic)."""
    try:
        HTTP_REQUESTS.labels(method=method, path=path, status=str(status)).inc()
        HTTP_LATENCY.labels(method=method, path=path).observe(duration_s)
    except Exception:  # noqa: BLE001  # pragma: no cover - metrics must never break a request
        log.debug("metrics record failed", exc_info=True)


def metrics_exposition() -> tuple[bytes, str]:
    """Return (body, content_type) for the Prometheus /metrics endpoint."""
    return generate_latest(), CONTENT_TYPE_LATEST


# ── Structured logging ────────────────────────────────────────────────────────
class _JsonFormatter(logging.Formatter):
    """Minimal JSON log formatter (no extra dep). One line per record."""

    def format(self, record: logging.LogRecord) -> str:
        import json

        payload = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def setup_logging(level: str | None = None, json_format: bool | None = None) -> None:
    """Configure the root logger once. LOG_LEVEL sets the level; set LOG_FORMAT=json
    for structured logs (recommended in production so a log shipper can parse them)."""
    lvl = (level or os.getenv("LOG_LEVEL", "info")).upper()
    use_json = json_format if json_format is not None else os.getenv("LOG_FORMAT", "").lower() == "json"
    handler = logging.StreamHandler(sys.stdout)
    if use_json:
        handler.setFormatter(_JsonFormatter())
    else:
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(getattr(logging, lvl, logging.INFO))


# ── Optional error tracking (Sentry) ──────────────────────────────────────────
def init_error_tracking() -> bool:
    """Wire Sentry iff SENTRY_DSN is set and the SDK is installed. Returns True when
    active. Safe no-op otherwise — never raises."""
    dsn = os.getenv("SENTRY_DSN", "").strip()
    if not dsn:
        return False
    try:
        import sentry_sdk
    except ImportError:
        log.warning("SENTRY_DSN set but sentry-sdk not installed (uv sync --extra sentry)")
        return False
    sentry_sdk.init(
        dsn=dsn,
        traces_sample_rate=float(os.getenv("SENTRY_TRACES_SAMPLE_RATE", "0.0")),
        environment=os.getenv("TIA_ENV", "production"),
    )
    log.info("error tracking enabled (sentry)")
    return True

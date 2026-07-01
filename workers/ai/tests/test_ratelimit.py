"""Rate limiter (tia_ai/ratelimit.py) + the /intake/upload 429 backstop.

Uses an injected clock so window behaviour is deterministic, and a fake request
object to cover every client_key branch without socket gymnastics.
"""

from __future__ import annotations

import types
import uuid

from fastapi.testclient import TestClient

from tia_ai import ratelimit
from tia_ai.api import app as appmod
from tia_ai.api.app import app


def _req(xff: str = "", client_host: str | None = "1.2.3.4"):
    client = types.SimpleNamespace(host=client_host) if client_host is not None else None
    headers = {"x-forwarded-for": xff} if xff else {}
    return types.SimpleNamespace(headers=headers, client=client)


# ── SlidingWindowLimiter ──────────────────────────────────────────────────────


def test_allows_up_to_max_then_blocks():
    lim = ratelimit.SlidingWindowLimiter(max_requests=2, window_s=60.0)
    assert lim.allow("k", now=0.0) is True
    assert lim.allow("k", now=1.0) is True
    assert lim.allow("k", now=2.0) is False  # 3rd within window → blocked


def test_window_slides_and_frees_capacity():
    lim = ratelimit.SlidingWindowLimiter(max_requests=1, window_s=10.0)
    assert lim.allow("k", now=0.0) is True
    assert lim.allow("k", now=5.0) is False  # still inside the 10s window
    assert lim.allow("k", now=11.0) is True  # first hit aged out


def test_keys_are_isolated():
    lim = ratelimit.SlidingWindowLimiter(max_requests=1, window_s=60.0)
    assert lim.allow("a", now=0.0) is True
    assert lim.allow("b", now=0.0) is True  # different key, own budget
    assert lim.allow("a", now=1.0) is False


def test_allow_uses_monotonic_when_now_omitted():
    lim = ratelimit.SlidingWindowLimiter(max_requests=1, window_s=60.0)
    assert lim.allow("k") is True  # exercises the time.monotonic() default path


# ── client_key branches ───────────────────────────────────────────────────────


def test_client_key_prefers_forwarded_for():
    assert ratelimit.client_key(_req(xff="9.9.9.9, 10.0.0.1")) == "9.9.9.9"


def test_client_key_falls_back_to_peer():
    assert ratelimit.client_key(_req(xff="", client_host="5.6.7.8")) == "5.6.7.8"


def test_client_key_unknown_without_client():
    assert ratelimit.client_key(_req(xff="", client_host=None)) == "unknown"


# ── /intake/upload 429 integration ────────────────────────────────────────────


def test_upload_rate_limit_returns_429(monkeypatch):
    # Swap in a max=1 limiter so the second upload trips the backstop.
    monkeypatch.setattr(appmod, "_UPLOAD_LIMITER", ratelimit.SlidingWindowLimiter(1, 60.0))
    from tia_ai.config import DATA_DIR

    p = DATA_DIR / "synthetic" / "case_07_clean.xlsx"
    with TestClient(app) as c:
        mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        with p.open("rb") as f:
            r1 = c.post(
                "/intake/upload",
                files={"file": (p.name, f, mime)},
                headers={"Idempotency-Key": f"rl-{uuid.uuid4().hex}"},
            )
        with p.open("rb") as f:
            r2 = c.post(
                "/intake/upload",
                files={"file": (p.name, f, mime)},
                headers={"Idempotency-Key": f"rl-{uuid.uuid4().hex}"},
            )
    assert r1.status_code == 200, r1.text
    assert r2.status_code == 429

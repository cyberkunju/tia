"""Lightweight in-memory sliding-window rate limiter.

A backstop for the public upload path — the Cloudflare edge is the real DDoS
layer, so this is deliberately simple (per-worker, in-memory). It bounds abusive
bursts (unauthenticated /intake/upload creates invoices) without any shared
store. For strict global limits, use Cloudflare rate rules at the edge.
"""

from __future__ import annotations

import time
from collections import defaultdict, deque
from typing import Any


class SlidingWindowLimiter:
    """Allow up to `max_requests` per `window_s` seconds per key."""

    def __init__(self, max_requests: int, window_s: float) -> None:
        self.max_requests = max_requests
        self.window_s = window_s
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, key: str, now: float | None = None) -> bool:
        current = time.monotonic() if now is None else now
        dq = self._hits[key]
        cutoff = current - self.window_s
        while dq and dq[0] <= cutoff:
            dq.popleft()
        if len(dq) >= self.max_requests:
            return False
        dq.append(current)
        return True


def client_key(request: Any) -> str:
    """Best-effort client identity for rate-limiting. Prefers the real visitor IP
    from X-Forwarded-For (set by nginx/Cloudflare), else the socket peer."""
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"

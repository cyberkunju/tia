"""Transient-failure retry/backoff for the external-call clients.

Covers the new retry logic added to the LLM chat client (ai/llm.py) and the SAP
B1 Service Layer client (integrations/sap_b1/client.py): transient failures
(timeout / network / 5xx) are retried with bounded backoff; permanent failures
(4xx / empty / unconfigured) are not; retries eventually give up gracefully.
Backoff sleeps are stubbed so the suite stays instant.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from tia_ai.ai import llm as L
from tia_ai.integrations.sap_b1 import client as sap


def _run(coro):
    return asyncio.run(coro)


# ── LLM: _is_transient classification ─────────────────────────────────────────


def test_is_transient_matrix():
    assert L._is_transient(L.ChatResult(ok=False, kind="timeout")) is True
    assert L._is_transient(L.ChatResult(ok=False, kind="network")) is True
    assert L._is_transient(L.ChatResult(ok=False, kind="http", status=503)) is True
    assert L._is_transient(L.ChatResult(ok=False, kind="http", status=500)) is True
    assert L._is_transient(L.ChatResult(ok=False, kind="http", status=400)) is False
    assert L._is_transient(L.ChatResult(ok=False, kind="empty")) is False
    assert L._is_transient(L.ChatResult(ok=False, kind="unconfigured")) is False


def test_retry_sleep_is_awaitable():
    # cover the real backoff sleep body (0s so it's instant)
    asyncio.run(L._retry_sleep(0))


def _chat_client(handler, **kw):
    ac = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return L.ChatModelClient(
        base_url="https://model.test/v1", api_key="k", model="gpt-4o-mini", client=ac, **kw
    )


def test_llm_retries_transient_then_succeeds(monkeypatch):
    async def _noop(_seconds):
        return None

    monkeypatch.setattr(L, "_retry_sleep", _noop)
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(503, text="overloaded")
        return httpx.Response(200, json={"choices": [{"message": {"content": "hi"}}]})

    client = _chat_client(handler)
    res = _run(client.complete([L.ChatMessage(role="user", content="q")]))
    assert res.ok and res.content == "hi"
    assert calls["n"] == 2  # retried once


def test_llm_gives_up_after_max_attempts(monkeypatch):
    async def _noop(_seconds):
        return None

    monkeypatch.setattr(L, "_retry_sleep", _noop)
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(500, text="boom")

    client = _chat_client(handler, max_attempts=3)
    res = _run(client.complete([L.ChatMessage(role="user", content="q")]))
    assert res.ok is False and res.kind == "http" and res.status == 500
    assert calls["n"] == 3  # exhausted all attempts


def test_llm_does_not_retry_client_error(monkeypatch):
    async def _boom(_seconds):
        raise AssertionError("must not sleep/retry on a 4xx")

    monkeypatch.setattr(L, "_retry_sleep", _boom)
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(400, text="bad request")

    client = _chat_client(handler)
    res = _run(client.complete([L.ChatMessage(role="user", content="q")]))
    assert res.ok is False and res.status == 400
    assert calls["n"] == 1  # no retry on a permanent 4xx


def test_llm_zero_attempts_returns_no_attempt_result():
    # Defensive edge: max_attempts=0 makes the loop a no-op and returns the
    # seeded "no attempt made" result without any HTTP call.
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json={"choices": [{"message": {"content": "x"}}]})

    client = _chat_client(handler, max_attempts=0)
    res = _run(client.complete([L.ChatMessage(role="user", content="q")]))
    assert res.ok is False and res.reason == "no attempt made"
    assert calls["n"] == 0


# ── SAP: transient retry ──────────────────────────────────────────────────────


def _configure(monkeypatch):
    monkeypatch.setattr(sap, "SAP_B1_BASE_URL", "https://sap.example/")
    monkeypatch.setattr(sap, "SAP_B1_COMPANY_DB", "TIA_DB")
    monkeypatch.setattr(sap, "SAP_B1_USER", "u")
    monkeypatch.setattr(sap, "SAP_B1_PASSWORD", "p")


def _install(monkeypatch, handler):
    real = httpx.Client

    def _fake(*a, **k):
        k["transport"] = httpx.MockTransport(handler)
        k.pop("verify", None)
        return real(*a, **k)

    monkeypatch.setattr(sap.httpx, "Client", _fake)


def test_sap_retries_transient_5xx_then_succeeds(monkeypatch):
    _configure(monkeypatch)
    slept: list[float] = []
    state = {"login_attempts": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        p = req.url.path
        if p.endswith("/Login"):
            state["login_attempts"] += 1
            if state["login_attempts"] == 1:
                return httpx.Response(503, text="service busy")  # transient
            return httpx.Response(200, json={"SessionId": "x"})
        if p.endswith("/Invoices"):
            return httpx.Response(201, json={"DocEntry": 7, "DocNum": 42})
        return httpx.Response(204)

    _install(monkeypatch, handler)
    res = sap.post_invoice({"CardCode": "CL001"}, _sleep=slept.append)
    assert res == {"DocEntry": 7, "DocNum": 42, "status": 201}
    assert state["login_attempts"] == 2  # retried the transient login once
    assert slept  # backoff was applied


def test_sap_retries_exhaust_then_raise(monkeypatch):
    _configure(monkeypatch)
    attempts = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.endswith("/Login"):
            attempts["n"] += 1
            return httpx.Response(500, text="down")
        return httpx.Response(204)

    _install(monkeypatch, handler)
    with pytest.raises(sap.SapB1Error):
        sap.post_invoice({"CardCode": "CL001"}, attempts=3, _sleep=lambda _s: None)
    assert attempts["n"] == 3


def test_sap_post_5xx_is_transient_and_retried(monkeypatch):
    _configure(monkeypatch)
    posts = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        p = req.url.path
        if p.endswith("/Login"):
            return httpx.Response(200, json={"SessionId": "x"})
        if p.endswith("/Invoices"):
            posts["n"] += 1
            return httpx.Response(502, text="bad gateway")  # transient
        return httpx.Response(204)

    _install(monkeypatch, handler)
    with pytest.raises(sap.SapB1Error):
        sap.post_invoice({"CardCode": "CL001"}, attempts=2, _sleep=lambda _s: None)
    assert posts["n"] == 2  # POST retried


def test_sap_4xx_login_is_permanent_no_retry(monkeypatch):
    _configure(monkeypatch)
    attempts = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.endswith("/Login"):
            attempts["n"] += 1
            return httpx.Response(401, text="bad creds")
        return httpx.Response(204)

    _install(monkeypatch, handler)
    with pytest.raises(sap.SapB1Error):
        sap.post_invoice({"CardCode": "CL001"}, _sleep=lambda _s: None)
    assert attempts["n"] == 1  # permanent 4xx: no retry

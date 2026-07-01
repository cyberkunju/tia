"""Remaining whatsapp.py branches: notify_bridge transport, resolve bound
fallback, push_text_to_sender, notify_whatsapp_result outcomes, answer_for_sender
scoping/rate-limit, and route_message's ambiguous LLM fallback."""

from __future__ import annotations

import datetime as dt
import uuid

import httpx
import pytest
import respx

from tia_ai import whatsapp as wa
from tia_ai.db import SessionLocal
from tia_ai.models import ChatMessage, Client, DocAsset, Invoice, Timesheet


@pytest.fixture()
def s():
    sess = SessionLocal()
    try:
        yield sess
    finally:
        sess.rollback()
        sess.close()


BRIDGE = wa.WHATSAPP_BRIDGE_URL.rstrip("/") + "/internal/notify"


def _wa_ts(s, phone, routing="auto", with_invoice=True) -> Timesheet:
    doc = DocAsset(
        id=str(uuid.uuid4()),
        content_hash=uuid.uuid4().hex,
        source_channel="whatsapp",
        uploaded_by=phone,
        mime="text/plain",
    )
    s.add(doc)
    s.flush()
    ts = Timesheet(
        id=str(uuid.uuid4()),
        doc_id=doc.id,
        client_code="CL001",
        period="June 2026",
        status="approved",
        routing=routing,
        created_at=dt.datetime.now(dt.timezone.utc),
    )
    s.add(ts)
    s.flush()
    if with_invoice:
        inv = Invoice(
            id=str(uuid.uuid4()),
            timesheet_id=ts.id,
            client_code="CL001",
            period="June 2026",
            amount=10000.0,
            total_incl_vat=10500.0,
            currency="AED",
            status="generated",
            created_at=dt.datetime.now(dt.timezone.utc),
        )
        s.add(inv)
        s.flush()
    return ts


# ── notify_bridge transport ─────────────────────────────────────────────────


@respx.mock
def test_notify_bridge_success():
    respx.post(BRIDGE).mock(return_value=httpx.Response(200, json={"ok": True, "result": "sent"}))
    ok, detail = wa.notify_bridge("971500000001", "text", text="hi")
    assert ok is True and "sent" in detail


@respx.mock
def test_notify_bridge_non_200():
    respx.post(BRIDGE).mock(return_value=httpx.Response(503, text="bridge down"))
    ok, detail = wa.notify_bridge("971500000001", "text", text="hi")
    assert ok is False and "503" in detail


@respx.mock
def test_notify_bridge_exception():
    respx.post(BRIDGE).mock(side_effect=httpx.ConnectError("refused"))
    ok, detail = wa.notify_bridge("971500000001", "text", text="hi")
    assert ok is False and "unreachable" in detail


# ── resolve_sender bound fallback ─────────────────────────────────────────────


def test_resolve_sender_bound_fallback(s):
    phone = "9715" + str(uuid.uuid4().int)[:9]  # all-digit, ≥8 digits
    c = s.get(Client, "CL001")
    c.settings = {**(c.settings or {}), "whatsapp_number": phone}
    s.flush()
    # no timesheet history for this phone → falls back to the registered-client binding
    ctx = wa.resolve_sender(s, phone)
    assert ctx == {"client_code": "CL001", "timesheet_id": None, "invoice_id": None}


def test_resolve_sender_none_phone(s):
    assert wa.resolve_sender(s, None) is None


def test_client_for_sender_short_number(s):
    assert wa.client_for_sender(s, "123") is None


# ── push_text_to_sender ────────────────────────────────────────────────────────


def test_push_text_to_sender_whatsapp(monkeypatch, s):
    monkeypatch.setattr(wa, "notify_bridge", lambda to, kind, **f: (True, "ok"))
    ts = _wa_ts(s, "971500000010", with_invoice=False)
    res = wa.push_text_to_sender(s, ts, "your sheet was rejected")
    assert res["ok"] is True and res["to"] == "971500000010"


def test_push_text_to_sender_non_whatsapp(s):
    doc = DocAsset(id=str(uuid.uuid4()), content_hash=uuid.uuid4().hex, source_channel="upload", uploaded_by="c")
    s.add(doc)
    s.flush()
    ts = Timesheet(id=str(uuid.uuid4()), doc_id=doc.id, client_code="CL001", status="rejected")
    s.add(ts)
    s.flush()
    assert wa.push_text_to_sender(s, ts, "x") is None


# ── notify_whatsapp_result outcomes ────────────────────────────────────────────


def test_notify_result_no_phone(s):
    ts = _wa_ts(s, "971500000011")
    assert wa.notify_whatsapp_result(s, ts, None) is None


def test_notify_result_auto_pushes_invoice(monkeypatch, s):
    captured = {}
    monkeypatch.setattr(wa, "notify_bridge", lambda to, kind, **f: captured.update({"kind": kind}) or (True, "ok"))
    ts = _wa_ts(s, "971500000012", routing="auto", with_invoice=True)
    res = wa.notify_whatsapp_result(s, ts, "971500000012")
    assert res is not None and res["ok"] is True
    assert captured["kind"] == "document"


def test_notify_result_escalate_sends_text(monkeypatch, s):
    monkeypatch.setattr(wa, "notify_bridge", lambda to, kind, **f: (True, "ok"))
    ts = _wa_ts(s, "971500000013", routing="escalate", with_invoice=False)
    res = wa.notify_whatsapp_result(s, ts, "971500000013")
    assert res["kind"] == "escalate"


def test_notify_result_hitl_sends_review_text(monkeypatch, s):
    monkeypatch.setattr(wa, "notify_bridge", lambda to, kind, **f: (True, "ok"))
    ts = _wa_ts(s, "971500000014", routing="hitl", with_invoice=False)
    res = wa.notify_whatsapp_result(s, ts, "971500000014")
    assert res["kind"] == "review"


# ── answer_for_sender ──────────────────────────────────────────────────────────


def test_answer_for_sender_no_context(s):
    res = wa.answer_for_sender(s, "97150nonexistent999", "what's my total?")
    assert res["scoped"] is False
    assert "timesheet" in res["answer"].lower()


def test_answer_for_sender_scoped(monkeypatch, s):
    import tia_ai.qa as qa_pkg

    phone = "97150" + uuid.uuid4().hex[:8]
    _wa_ts(s, phone, with_invoice=True)
    monkeypatch.setattr(
        qa_pkg,
        "answer",
        lambda session, q, entity_context=None, client_scope=None, history=None, **k: {
            "answer": f"scoped {client_scope}",
            "citations": [],
            "tool_calls": [],
        },
    )
    res = wa.answer_for_sender(s, phone, "what's my total?")
    assert res["scoped"] is True and res["client_code"] == "CL001"


def test_answer_for_sender_rate_limited(monkeypatch, s):
    phone = "97150" + uuid.uuid4().hex[:8]
    _wa_ts(s, phone, with_invoice=True)
    now = dt.datetime.now(dt.timezone.utc)
    for _ in range(20):
        s.add(ChatMessage(sender=phone, client_code="CL001", role="user", content="q", at=now))
    s.flush()
    res = wa.answer_for_sender(s, phone, "again?")
    assert res.get("rate_limited") is True


# ── route_message ambiguous → LLM fallback ─────────────────────────────────────


def test_route_message_ambiguous_falls_back_to_chat():
    # both timesheet-like (EMP + days) AND question-like (why/?) → LLM router, which
    # is unavailable in the test env → safe-default to chat
    assert wa.route_message("why did EMP10001 only get 22 days?") == "chat"


def test_route_message_ambiguous_uses_llm(monkeypatch):
    from tia_ai.qa import agent as A

    monkeypatch.setattr(A, "route_intent", lambda t: "timesheet")
    assert wa.route_message("why did EMP10001 only get 22 days?") == "timesheet"

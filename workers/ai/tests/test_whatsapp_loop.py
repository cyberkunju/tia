"""WhatsApp full-loop tests.

Covers the three new pieces:
  1. intent classification (timesheet vs "talk to the invoice" question)
  2. sender → client resolution + the approved-invoice push (bridge mocked)
  3. /intake/whatsapp routing a known sender's question to the grounded agent
     (qa mocked) while an unknown sender's text still flows into the pipeline.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from tia_ai import whatsapp as wa
from tia_ai.api.app import app
from tia_ai.db import SessionLocal, init_db
from tia_ai.models import DocAsset, Invoice, Timesheet
from tia_ai.seed import seed
from tia_ai.synthgen import generate_all


@pytest.fixture(scope="module", autouse=True)
def prepare():
    init_db()
    seed()
    generate_all()
    yield


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


# ----------------------------------------------------------------- classifier


@pytest.mark.parametrize(
    "text",
    [
        "EMP10093 worked 23 days in June 2026",
        "Carlos Smith - 22 days, 5 OT hours",
        "timesheet for June: 21 days present, 2 annual leave",
        "payout request total 9834",
    ],
)
def test_classify_timesheet(text):
    assert wa.classify_inbound_text(text) == "timesheet"


@pytest.mark.parametrize(
    "text",
    [
        "why is my invoice so high?",
        "what is the VAT on my last invoice",
        "can you explain the total amount",
        "how was this billed?",
    ],
)
def test_classify_question(text):
    assert wa.classify_inbound_text(text) == "question"


def test_classify_empty_defaults_timesheet():
    assert wa.classify_inbound_text("") == "timesheet"
    assert wa.classify_inbound_text(None) == "timesheet"


# ----------------------------------------------------- resolve + invoice push


def _make_whatsapp_invoice(session, phone: str) -> Invoice:
    """Create a whatsapp-origin doc → timesheet → invoice chain directly."""
    doc = DocAsset(
        id=str(uuid.uuid4()),
        content_hash=uuid.uuid4().hex,
        source_channel="whatsapp",
        uploaded_by=phone,
        mime="text/plain",
    )
    session.add(doc)
    session.flush()
    ts = Timesheet(
        id=str(uuid.uuid4()),
        doc_id=doc.id,
        client_code="CL001",
        period="June 2026",
        status="approved",
    )
    session.add(ts)
    session.flush()
    inv = Invoice(
        id=str(uuid.uuid4()),
        timesheet_id=ts.id,
        client_code="CL001",
        period="June 2026",
        amount=10000.0,
        currency="AED",
        total_incl_vat=10500.0,
        status="generated",
    )
    session.add(inv)
    session.flush()
    return inv


def test_resolve_sender_finds_latest():
    phone = "971500000777"
    s = SessionLocal()
    try:
        inv = _make_whatsapp_invoice(s, phone)
        s.commit()
        ctx = wa.resolve_sender(s, phone)
        assert ctx is not None
        assert ctx["client_code"] == "CL001"
        assert ctx["invoice_id"] == inv.id
    finally:
        s.close()


def test_resolve_sender_unknown_returns_none():
    s = SessionLocal()
    try:
        assert wa.resolve_sender(s, "971500000000-unknown") is None
    finally:
        s.close()


def test_push_invoice_to_sender_calls_bridge(monkeypatch):
    captured = {}

    def fake_notify(to, kind, **fields):
        captured.update({"to": to, "kind": kind, **fields})
        return True, "ok"

    monkeypatch.setattr(wa, "notify_bridge", fake_notify)

    phone = "971500000888"
    s = SessionLocal()
    try:
        inv = _make_whatsapp_invoice(s, phone)
        s.commit()
        result = wa.push_invoice_to_sender(s, inv)
        assert result is not None and result["ok"] is True
        assert captured["to"] == phone
        assert captured["kind"] == "document"
        assert inv.id in captured["url"]
        assert captured["filename"].endswith(".pdf")
    finally:
        s.close()


def test_push_invoice_non_whatsapp_origin_is_noop():
    s = SessionLocal()
    try:
        doc = DocAsset(
            id=str(uuid.uuid4()),
            content_hash=uuid.uuid4().hex,
            source_channel="upload",
            uploaded_by="client",
        )
        s.add(doc)
        s.flush()
        ts = Timesheet(id=str(uuid.uuid4()), doc_id=doc.id, client_code="CL001", status="approved")
        s.add(ts)
        s.flush()
        inv = Invoice(id=str(uuid.uuid4()), timesheet_id=ts.id, client_code="CL001", amount=1.0)
        s.add(inv)
        s.commit()
        assert wa.push_invoice_to_sender(s, inv) is None
    finally:
        s.close()


# ----------------------------------------------------- /intake/whatsapp routing


def test_whatsapp_question_from_known_sender_routes_to_answer(client, monkeypatch):
    import tia_ai.qa as qa_pkg

    phone = "971500000123"

    # 1) first send a timesheet over WhatsApp so the sender has history
    r1 = client.post(
        "/intake/whatsapp",
        json={"from_": phone, "message_text": "EMP10093 worked 23 days in June 2026"},
        headers={"Idempotency-Key": f"wa-ts-{uuid.uuid4().hex}"},
    )
    assert r1.status_code == 202, r1.text
    assert r1.json()["mode"] == "intake"

    # 2) mock the grounded agent so we don't need an LLM/network
    def fake_answer(session, question, entity_context=None, client_scope=None, **kw):
        assert client_scope is not None  # must be client-scoped, never global
        return {
            "answer": f"Scoped to {client_scope}. [invoice:demo]",
            "citations": [{"kind": "invoice", "id": "demo"}],
            "tool_calls": [{"name": "get_invoice"}],
            "model": "mock",
        }

    monkeypatch.setattr(qa_pkg, "answer", fake_answer)

    # 3) now a question from the same number → mode=answer
    r2 = client.post(
        "/intake/whatsapp",
        json={"from_": phone, "message_text": "what is my invoice total?"},
        headers={"Idempotency-Key": f"wa-q-{uuid.uuid4().hex}"},
    )
    assert r2.status_code == 200, r2.text
    body = r2.json()
    assert body["mode"] == "answer"
    assert "Scoped to" in body["answer"]
    assert body["citations"] == [{"kind": "invoice", "id": "demo"}]


def test_whatsapp_question_from_unknown_sender_falls_through_to_intake(client):
    # No prior history for this number → cannot scope a chat answer → treated as intake.
    r = client.post(
        "/intake/whatsapp",
        json={"from_": "971599999999", "message_text": "why is my invoice so high?"},
        headers={"Idempotency-Key": f"wa-u-{uuid.uuid4().hex}"},
    )
    assert r.status_code == 202, r.text
    assert r.json()["mode"] == "intake"

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
from tia_ai.models import Client, DocAsset, Invoice, Timesheet
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


@pytest.mark.parametrize(
    "mime,url,expected",
    [
        ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", None, ".xlsx"),
        ("application/vnd.ms-excel", None, ".xls"),
        ("text/csv", None, ".csv"),
        ("application/pdf", None, ".pdf"),
        ("image/jpeg", None, ".jpg"),
        ("image/png", None, ".png"),
        # unknown mime → fall back to the attachment URL's real suffix (bridge names it <hash>.xlsx)
        (None, "http://bridge/media/abc123.xlsx", ".xlsx"),
        ("application/octet-stream", "http://bridge/media/abc.csv", ".csv"),
        (None, None, ".bin"),
    ],
)
def test_whatsapp_attachment_ext(mime, url, expected):
    from tia_ai.api.app import whatsapp_attachment_ext

    assert whatsapp_attachment_ext(mime, url) == expected


@pytest.mark.parametrize(
    "text", ["hi", "Hello", "hey there"[:3], "thanks", "thank you", "help", "good morning", "menu", "/start"]
)
def test_classify_greeting(text):
    assert wa.classify_inbound_text(text) == "greeting"


def test_help_request_is_question_not_greeting():
    # a real request that merely contains "help" must not be swallowed as a greeting
    assert wa.classify_inbound_text("help me understand my invoice total") == "question"


# ----------------------------------------------------- sender → client binding


def test_client_for_sender_matches_with_country_code_variants():
    s = SessionLocal()
    try:
        c = s.get(Client, "CL002")
        c.settings = {**(c.settings or {}), "whatsapp_number": "9400245958"}
        s.commit()
        # stored without country code; inbound with country code → still matches
        assert wa.client_for_sender(s, "919400245958") == "CL002"
        assert wa.client_for_sender(s, "+91 94002 45958") == "CL002"
        assert wa.client_for_sender(s, "9400245958") == "CL002"
        # an unrelated number does not match
        assert wa.client_for_sender(s, "971500000001") != "CL002"
    finally:
        # clean up so other tests aren't affected
        c = s.get(Client, "CL002")
        c.settings = {k: v for k, v in (c.settings or {}).items() if k != "whatsapp_number"}
        s.commit()
        s.close()


def test_greeting_returns_help_without_creating_doc(client):
    s = SessionLocal()
    try:
        before = s.query(DocAsset).filter_by(source_channel="whatsapp").count()
    finally:
        s.close()
    r = client.post(
        "/intake/whatsapp",
        json={"from_": "971500444555", "message_text": "hi"},
        headers={"Idempotency-Key": f"wa-greet-{uuid.uuid4().hex}"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mode"] == "answer"
    assert "AIDA" in body["answer"]
    s = SessionLocal()
    try:
        after = s.query(DocAsset).filter_by(source_channel="whatsapp").count()
    finally:
        s.close()
    assert after == before  # greeting must not create a junk timesheet


def test_registered_sender_binds_client(client):
    phone = "919812345678"
    s = SessionLocal()
    try:
        c = s.get(Client, "CL001")
        c.settings = {**(c.settings or {}), "whatsapp_number": phone}
        s.commit()
    finally:
        s.close()
    # a clean unique employee at CL001, with no client named in the text
    r = client.post(
        "/intake/whatsapp",
        json={"from_": phone, "message_text": "EMP10001 worked 22 days in June 2026"},
        headers={"Idempotency-Key": f"wa-bind-{uuid.uuid4().hex}"},
    )
    assert r.status_code == 202, r.text
    ts_id = r.json()["timesheet_id"]
    s = SessionLocal()
    try:
        ts = s.get(Timesheet, ts_id)
        assert ts.client_code == "CL001"  # bound from the registered sender number
    finally:
        c = s.get(Client, "CL001")
        c.settings = {k: v for k, v in (c.settings or {}).items() if k != "whatsapp_number"}
        s.commit()
        s.close()


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

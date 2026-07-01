"""Final targeted coverage: SSE events stream, partial clawback, employee
history billed loop, list_documents limit, finance_queue rule-fail, and the
missing-overtime recovery branch."""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid

import pytest
from fastapi.testclient import TestClient

from tia_ai.api.app import app, events_stream
from tia_ai.db import SessionLocal, init_db
from tia_ai.models import DocAsset, Employee, Invoice, Payroll, Timesheet
from tia_ai.orchestrator import log_event
from tia_ai.qa import agent as A
from tia_ai.seed import seed


@pytest.fixture(scope="module", autouse=True)
def prepare():
    init_db()
    seed()
    yield


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def s():
    sess = SessionLocal()
    try:
        yield sess
    finally:
        sess.rollback()
        sess.close()


def _mkinv(**kw) -> str:
    sess = SessionLocal()
    try:
        d = dict(
            id=str(uuid.uuid4()),
            timesheet_id=f"fg:{uuid.uuid4()}",
            client_code="CL001",
            period="June 2026",
            amount=1000.0,
            currency="AED",
            total_incl_vat=1050.0,
            status="dispatched",
            invoice_sequence_no=f"TIA-FG-{uuid.uuid4().hex[:8]}",
            line_items=[{"emp_id": "EMP10001", "amount": 1000.0, "days_worked": 22}],
        )
        d.update(kw)
        inv = Invoice(**d)
        sess.add(inv)
        sess.commit()
        return inv.id
    finally:
        sess.close()


# ── SSE events stream ─────────────────────────────────────────────────────────


def test_events_stream_emits_hello_then_event():
    async def run():
        resp = await events_stream(SessionLocal())
        it = resp.body_iterator
        first = await it.__anext__()  # hello frame
        s2 = SessionLocal()
        try:
            log_event(s2, "tester", "system", f"sse-{uuid.uuid4()}", "sse.probe", {"n": 1})
            s2.commit()
        finally:
            s2.close()
        second = await asyncio.wait_for(it.__anext__(), timeout=6)
        await it.aclose()
        return first, second

    first, second = asyncio.run(run())
    assert "hello" in first
    assert "event" in second and "sse.probe" in second


# ── partial clawback with disputed hours ───────────────────────────────────────


def test_clawback_partial_with_disputed_hours(client):
    inv_id = _mkinv(status="dispatched", amount=2000.0)
    r = client.post(
        f"/invoices/{inv_id}/clawback",
        json={
            "by_user": "finops",
            "reason_code": "PRICING_ERROR",
            "reason_text": "rate too high",
            "partial_amount": 200.0,
            "disputed_hours": 4.0,
            "adjustment_type": "DEDUCT_FROM_NEXT_INVOICE",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["is_partial"] is True
    assert body["credit_note_amount"] == 200.0
    assert body["disputed_hours"] == 4.0


def test_clawback_already_credit_noted(client):
    inv_id = _mkinv(status="dispatched")
    first = client.post(f"/invoices/{inv_id}/clawback", json={"reason_code": "OTHER"})
    assert first.status_code == 200
    second = client.post(f"/invoices/{inv_id}/clawback", json={"reason_code": "OTHER"})
    assert second.json()["action_taken"] == "already_credit_noted"


# ── qa employee history billed loop ─────────────────────────────────────────────


def test_employee_history_includes_billed_periods(s):
    emp = s.query(Employee).filter(Employee.client_code == "CL001").first()
    inv = Invoice(
        id=str(uuid.uuid4()),
        timesheet_id=f"eh:{uuid.uuid4()}",
        client_code="CL001",
        period="June 2026",
        amount=5000.0,
        currency="AED",
        status="generated",
        invoice_sequence_no=f"TIA-EH-{uuid.uuid4().hex[:6]}",
        line_items=[{"emp_id": emp.emp_id, "amount": 5000.0, "days_worked": 22, "ot_hours": 3}],
        created_at=dt.datetime.now(dt.timezone.utc),
    )
    s.add(inv)
    s.flush()
    res = A.tool_get_employee_history(s, emp.emp_id)
    assert res["found"] is True
    assert any(b.get("invoice_sequence_no") == inv.invoice_sequence_no for b in res["billed_history"])


# ── list_documents limit cap ────────────────────────────────────────────────────


def test_list_documents_respects_small_limit(s):
    # seed a few docs+timesheets so there's something to limit
    for _ in range(3):
        doc = DocAsset(id=str(uuid.uuid4()), content_hash=uuid.uuid4().hex, source_channel="upload", uploaded_by="t")
        s.add(doc)
        s.flush()
        s.add(Timesheet(id=str(uuid.uuid4()), doc_id=doc.id, client_code="CL001", status="ingested", routing="auto",
                        created_at=dt.datetime.now(dt.timezone.utc)))
    s.flush()
    res = A.tool_list_documents(s, limit=1)
    assert res["count"] <= 1


# ── finance_queue with a rule failure surfaces small-amount invoice ─────────────


def test_finance_queue_includes_rule_failure(s):
    inv = Invoice(
        id=str(uuid.uuid4()),
        timesheet_id=f"fq:{uuid.uuid4()}",
        client_code="CL001",
        period="June 2026",
        amount=100.0,  # under threshold
        currency="AED",
        status="generated",
        invoice_sequence_no=f"TIA-FQ-{uuid.uuid4().hex[:6]}",
        rule_results=[{"rule_id": "R4", "passed": False, "severity": "error", "message": "OT over cap"}],
        created_at=dt.datetime.now(dt.timezone.utc),
    )
    s.add(inv)
    s.flush()
    res = A.tool_finance_queue(s)
    assert any(x["id"] == inv.id for x in res["queue"])


# ── recovery: missing-overtime branch ──────────────────────────────────────────


def test_recover_leakage_missing_overtime(s):
    emp = s.query(Employee).filter(Employee.client_code == "CL001").first()
    period = f"OTREC {uuid.uuid4().hex[:5]}"
    s.add(
        Payroll(
            id=str(uuid.uuid4()),
            emp_id=emp.emp_id,
            employee_name=emp.full_name,
            client_code="CL001",
            period=period,
            gross=10000.0,
            basic=10000.0,
            ot_hours=10,
            ot_amount=800.0,
            net_pay=10000.0,
            currency="AED",
            working_days=22,
        )
    )
    s.flush()
    res = A.tool_recover_leakage(s, emp_id=emp.emp_id, period=period, reason="missing_overtime")
    assert res["ok"] is True
    assert res["amount_aed"] > 0

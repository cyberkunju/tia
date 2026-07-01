"""Endpoint SUCCESS paths not covered elsewhere (api/app.py).

test_endpoints.py owns the broad 404/validation surface; test_api owns the
happy-path upload flow. This file fills the remaining success-path gaps:
  - GET /documents/{doc_id}      (get_doc detail bundle)
  - POST /timesheets/{id}/approve + /reject  (HITL success, not just 404)
  - GET /invoices/{id}/pdf        (a real rendered PDF is served)
  - GET /events/stream            (SSE hello frame, read without hanging)
  - GET /invoices filters         (client_code + status)
  - GET /invoices/{id}/why        (structured drawer on a known invoice)
"""

from __future__ import annotations

import datetime as dt
import uuid

import pytest
from fastapi.testclient import TestClient

from tia_ai.api.app import app
from tia_ai.config import DATA_DIR
from tia_ai.db import SessionLocal, init_db
from tia_ai.models import Client, DocAsset, Invoice, Timesheet
from tia_ai.schema import MatchResult, RowMatch, TimesheetExtraction, TimesheetRow
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


# ── GET /documents/{doc_id} ───────────────────────────────────────────────────


def test_get_doc_detail_bundle(client):
    p = DATA_DIR / "synthetic" / "case_07_clean.xlsx"
    with p.open("rb") as f:
        up = client.post(
            "/intake/upload",
            files={"file": (p.name, f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
            headers={"Idempotency-Key": f"getdoc-{uuid.uuid4().hex}"},
        )
    assert up.status_code == 200, up.text
    doc_id = up.json()["doc_id"]
    r = client.get(f"/documents/{doc_id}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["doc"]["id"] == doc_id
    assert body["doc"]["channel"] == "upload"
    # a clean upload auto-generates a timesheet + at least one invoice
    assert body["timesheet"] is not None
    assert body["timesheet"]["doc_id"] == doc_id
    assert isinstance(body["invoices"], list) and len(body["invoices"]) >= 1


def test_get_doc_unknown_404(client):
    assert client.get("/documents/no-such-doc").status_code == 404


# ── HITL approve / reject success ─────────────────────────────────────────────


def _seed_awaiting_review_timesheet(client_code="CL001") -> str:
    """Insert a resolvable awaiting_review timesheet directly so approve/reject
    have a real, well-formed substrate (the upload path auto-approves clean
    docs, so we can't get a HITL row from a clean upload)."""
    s = SessionLocal()
    try:
        from tia_ai.models import Employee, Payroll

        emp = s.query(Employee).filter(Employee.client_code == client_code).first()
        pr = s.query(Payroll).filter(Payroll.emp_id == emp.emp_id).first()
        period = pr.period if pr else "June 2026"

        doc = DocAsset(
            id=str(uuid.uuid4()),
            content_hash=uuid.uuid4().hex,
            source_channel="upload",
            mime="text/plain",
            uploaded_by="finops-test",
            filename="hitl.txt",
        )
        s.add(doc)
        s.flush()

        ex = TimesheetExtraction(
            client_code=client_code,
            period=period,
            rows=[TimesheetRow(employee_name=emp.full_name, emp_id=emp.emp_id, days_worked=22)],
        )
        match = MatchResult(
            matches=[RowMatch(row_idx=0, chosen_emp_id=emp.emp_id, ambiguous=False, confidence=0.9)]
        )
        ts = Timesheet(
            id=str(uuid.uuid4()),
            doc_id=doc.id,
            client_code=client_code,
            period=period,
            status="awaiting_review",
            routing="hitl",
            hitl_reason="seeded for approve/reject test",
            confidence_calibrated=0.6,
            extraction=ex.model_dump(mode="json"),
            match_result=match.model_dump(mode="json"),
            validations=[],
            resolved_rows=[],
        )
        s.add(ts)
        s.commit()
        return ts.id
    finally:
        s.close()


def test_timesheet_approve_success_generates_invoice(client):
    ts_id = _seed_awaiting_review_timesheet()
    r = client.post(f"/timesheets/{ts_id}/approve", json={"by_user": "finops", "corrections": []})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["timesheet_id"] == ts_id
    assert body["status"] == "approved"
    assert body["invoice_id"]
    assert body["amount"] >= 0
    # the generated invoice is now fetchable
    inv = client.get(f"/invoices/{body['invoice_id']}")
    assert inv.status_code == 200
    assert inv.json()["timesheet_id"] == ts_id


def test_timesheet_approve_idempotent_replay(client):
    ts_id = _seed_awaiting_review_timesheet()
    key = f"approve-{uuid.uuid4().hex}"
    a = client.post(
        f"/timesheets/{ts_id}/approve",
        json={"by_user": "finops"},
        headers={"Idempotency-Key": key},
    )
    assert a.status_code == 200
    b = client.post(
        f"/timesheets/{ts_id}/approve",
        json={"by_user": "finops"},
        headers={"Idempotency-Key": key},
    )
    assert b.status_code == 200
    assert b.json()["status"] == "duplicate"


def test_timesheet_reject_success(client):
    ts_id = _seed_awaiting_review_timesheet()
    r = client.post(f"/timesheets/{ts_id}/reject", json={"by_user": "finops", "reason": "bad scan"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["timesheet_id"] == ts_id
    assert body["status"] == "rejected"
    # non-WhatsApp origin → no push attempted
    assert body["whatsapp_notified"] is False


# ── invoice PDF success (real rendered file) ──────────────────────────────────


def test_invoice_pdf_served_after_generation(client):
    p = DATA_DIR / "synthetic" / "case_07_clean.xlsx"
    with p.open("rb") as f:
        up = client.post(
            "/intake/upload",
            files={"file": (p.name, f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
            headers={"Idempotency-Key": f"pdf-{uuid.uuid4().hex}"},
        )
    ts_id = up.json()["timesheet_id"]
    invs = client.get(f"/invoices?timesheet_id={ts_id}").json()
    assert invs, "expected a generated invoice"
    inv_id = invs[0]["id"]
    r = client.get(f"/invoices/{inv_id}/pdf")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf"
    assert r.content[:5] == b"%PDF-"


# ── /invoices filters ─────────────────────────────────────────────────────────


def test_invoices_filter_by_client_and_status(client):
    s = SessionLocal()
    try:
        inv = Invoice(
            id=str(uuid.uuid4()),
            timesheet_id=f"filt:{uuid.uuid4()}",
            client_code="CL003",
            period="June 2026",
            amount=42.0,
            currency="AED",
            status="voided",
            invoice_sequence_no=f"TIA-FILT-{uuid.uuid4().hex[:8]}",
            created_at=dt.datetime.now(dt.timezone.utc),
        )
        s.add(inv)
        s.commit()
        inv_id = inv.id
    finally:
        s.close()
    # filter by client_code
    by_client = client.get("/invoices?client_code=CL003").json()
    assert all(i["client_code"] == "CL003" for i in by_client)
    assert any(i["id"] == inv_id for i in by_client)
    # filter by status
    voided = client.get("/invoices?status=voided").json()
    assert all(i["status"] == "voided" for i in voided)
    assert any(i["id"] == inv_id for i in voided)


# ── /invoices/{id}/why on a known invoice ─────────────────────────────────────


def test_invoice_why_drawer_shape(client):
    s = SessionLocal()
    try:
        inv = Invoice(
            id=str(uuid.uuid4()),
            timesheet_id=f"why:{uuid.uuid4()}",
            client_code="CL001",
            period="June 2026",
            amount=1000.0,
            currency="AED",
            status="generated",
            invoice_sequence_no=f"TIA-WHY-{uuid.uuid4().hex[:8]}",
            rule_results=[{"rule_id": "R7", "passed": True, "severity": "info", "message": "ok"}],
            created_at=dt.datetime.now(dt.timezone.utc),
        )
        s.add(inv)
        s.commit()
        inv_id = inv.id
    finally:
        s.close()
    r = client.get(f"/invoices/{inv_id}/why")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["invoice"]["id"] == inv_id
    assert "events" in body and "validations" in body


def test_invoice_why_unknown_404(client):
    assert client.get("/invoices/nope/why").status_code == 404


# ── /events/stream SSE hello ──────────────────────────────────────────────────


def test_events_stream_emits_hello_frame():
    """The /events/stream generator runs an infinite poll loop, so we pull only
    its first frame and close it (via aclose) instead of consuming it over the
    TestClient, which would hang. This still exercises the real handler + gen."""
    import asyncio

    from tia_ai.api.app import events_stream

    async def _first_frame() -> str:
        s = SessionLocal()
        try:
            resp = await events_stream(s)
            assert resp.media_type == "text/event-stream"
            agen = resp.body_iterator
            frame = await agen.__anext__()
            await agen.aclose()  # cancels the infinite loop cleanly
            return frame if isinstance(frame, str) else frame.decode()
        finally:
            s.close()

    first = asyncio.run(_first_frame())
    assert "event: hello" in first

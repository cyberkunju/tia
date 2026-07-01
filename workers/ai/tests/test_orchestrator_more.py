"""Remaining orchestrator branches: email-body context fallback, OCR client-code
normalization, smart-bot artifact failure, dispatch_invoice, and HITL approve
with corrections. Runs in rolled-back sessions; no network."""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from tia_ai.config import DATA_DIR, STAGING_DIR
from tia_ai.db import SessionLocal
from tia_ai.models import Event, Invoice
from tia_ai import orchestrator as O


@pytest.fixture()
def s():
    sess = SessionLocal()
    try:
        yield sess
    finally:
        sess.rollback()
        sess.close()


def _tmp(content: bytes, suffix: str) -> Path:
    p = Path(STAGING_DIR) / f"_orchm_{uuid.uuid4().hex}{suffix}"
    p.write_bytes(content)
    return p


# ── email-body fallback + client-code normalization ────────────────────────────


def test_process_doc_email_body_fallback_and_code_normalization(s):
    # CSV rows but NO client/period in the sheet → body context fills them, and the
    # glyphed client_hint 'CLO01' gets snapped to the real 'CL001'.
    csv = b"Emp ID,Full Name,Working Days,OT Hours\nEMP10001,Carlos Smith,22,5\n"
    p = _tmp(csv, ".csv")
    doc = O.ingest_file(
        s,
        p,
        channel="email",
        mime="text/csv",
        uploaded_by=f"orchm-{uuid.uuid4().hex[:6]}",
        meta={"email_body": "Client Code: CL001\nMonth: June 2026", "from_addr": "a@x.test"},
    )
    ts = O.process_doc(s, doc, client_hint="CLO01")
    # body fallback filled the period; normalization snapped CLO01 → CL001
    actions = {
        e.action
        for e in s.query(Event).filter(Event.entity_id == doc.id).all()
    }
    assert "client_code_normalized" in actions
    assert ts.client_code == "CL001"


# ── smart-bot artifact failure is swallowed ────────────────────────────────────


def test_generate_invoice_smart_bot_failure_is_logged(monkeypatch, s):
    p = DATA_DIR / "synthetic" / "case_07_clean.xlsx"
    if not p.exists():
        pytest.skip("synthetic seed data missing")
    monkeypatch.setattr(
        O, "build_consolidated_excel", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("sap down"))
    )
    doc = O.ingest_file(
        s,
        p,
        channel="upload",
        mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        uploaded_by=f"orchm-sb-{uuid.uuid4().hex[:6]}",
    )
    ts = O.process_doc(s, doc)
    assert ts.status == "invoice_generated"
    skipped = s.query(Event).filter(Event.action == "smart_bot_sap.skipped").count()
    assert skipped >= 1


# ── dispatch_invoice ────────────────────────────────────────────────────────────


def _inv(s, amount=1000.0) -> Invoice:
    inv = Invoice(
        id=str(uuid.uuid4()),
        timesheet_id=f"disp:{uuid.uuid4()}",
        client_code="CL001",
        period="June 2026",
        amount=amount,
        currency="AED",
        line_items=[{"emp_id": "EMP10001", "amount": amount}],
        status="generated",
        invoice_sequence_no=f"TIA-DI-{uuid.uuid4().hex[:8]}",
    )
    s.add(inv)
    s.flush()
    return inv


def test_dispatch_invoice_fresh_then_idempotent(s):
    inv = _inv(s)
    res = O.dispatch_invoice(s, inv, by_user="finance", idempotency_key=f"k-{uuid.uuid4().hex[:8]}")
    assert res["status"] == "dispatched"
    assert inv.status == "dispatched"
    # already dispatched → refuses to re-fire
    res2 = O.dispatch_invoice(s, inv, by_user="finance", idempotency_key="different-key")
    assert res2["status"] == "already_dispatched"


def test_dispatch_invoice_email_failure_is_logged(monkeypatch, s):
    import tia_ai.mailbox.sender as sender

    inv = _inv(s)
    monkeypatch.setattr(
        sender, "send_invoice_email", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("smtp"))
    )
    O.dispatch_invoice(s, inv, by_user="finance", idempotency_key=f"k-{uuid.uuid4().hex[:8]}")
    assert (
        s.query(Event)
        .filter(Event.entity_id == inv.id, Event.action == "email.invoice_send_failed")
        .count()
        >= 1
    )


# ── approve_timesheet with corrections ─────────────────────────────────────────


def test_approve_timesheet_with_corrections(s):
    p = DATA_DIR / "synthetic" / "case_07_clean.xlsx"
    if not p.exists():
        pytest.skip("synthetic seed data missing")
    doc = O.ingest_file(
        s,
        p,
        channel="upload",
        mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        uploaded_by=f"orchm-ap-{uuid.uuid4().hex[:6]}",
    )
    ts = O.process_doc(s, doc)
    # force it back to a review state so approve is legal, then apply a correction
    ts.status = "awaiting_review"
    s.flush()
    mr = ts.match_result or {}
    assert mr.get("matches")
    chosen = mr["matches"][0].get("chosen_emp_id") or "EMP10001"
    invoice = O.approve_timesheet(
        s, ts, by_user="finance", corrections=[{"row_idx": 0, "chosen_emp_id": chosen}]
    )
    assert ts.status == "approved" and ts.routing == "auto"
    assert invoice.id
    # correction reason recorded on the match
    assert any("HITL pick" in (m.get("reason") or "") for m in ts.match_result["matches"])


def test_approve_timesheet_wrong_status_raises(s):
    inv_ts = O.ingest_file(
        s, _tmp(b"x", ".txt"), channel="upload", uploaded_by=f"orchm-w-{uuid.uuid4().hex[:6]}"
    )
    ts = O.process_doc(s, inv_ts)  # empty/garbage → escalate/awaiting_review
    ts.status = "approved"  # not an approvable state
    s.flush()
    with pytest.raises(ValueError):
        O.approve_timesheet(s, ts, by_user="finance")

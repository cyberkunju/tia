"""Render branch coverage + orchestrator rust auto-dispatch path."""

from __future__ import annotations

import datetime as dt
import uuid
from pathlib import Path

import httpx
import pytest
import respx

from tia_ai.db import SessionLocal
from tia_ai.invoice import render as RND
from tia_ai.models import Client, Invoice
from tia_ai import orchestrator as O


@pytest.fixture()
def s():
    sess = SessionLocal()
    try:
        yield sess
    finally:
        sess.rollback()
        sess.close()


# ── render_invoice with optional blocks (sac code, exceptions, warnings) ────────


def test_render_invoice_with_sac_and_exceptions(tmp_path):
    inv = {
        "client_name": "Emirates Steel",
        "client_code": "CL001",
        "period": "June 2026",
        "currency": "AED",
        "amount": 5000.0,
        "vat_rate": 0.05,
        "vat_amount": 250.0,
        "total_excl_vat": 5000.0,
        "total_incl_vat": 5250.0,
        "supplier_trn": "100123456700003",
        "customer_trn": "200200200000003",
        "invoice_sequence_no": "TIA-CL001-JUNE2026-0009",
        "place_of_supply": "Abu Dhabi, UAE",
        "sac_code": "998515",
        "requires_finance_approval": False,
        "line_items": [
            {"emp_id": "EMP10001", "employee_name": "Carlos", "days_worked": 22, "prorated": 4500.0, "ot_amount": 500.0, "reimbursements": 0.0, "amount": 5000.0},
        ],
        "exceptions": [{"employee_name": "Ghost", "reason": "unresolved"}],
        "validations": [{"passed": False, "severity": "warning", "message": "check OT"}],
    }
    out = RND.render_invoice(inv, f"rnd-{uuid.uuid4().hex[:6]}")
    assert Path(out).exists() and Path(out).stat().st_size > 1000


def test_render_invoice_with_credit_note(s):
    now = dt.datetime.now(dt.timezone.utc)
    inv = Invoice(
        id=str(uuid.uuid4()),
        timesheet_id=f"cn:{uuid.uuid4()}",
        client_code="CL001",
        period="June 2026",
        amount=2000.0,
        currency="AED",
        total_excl_vat=2000.0,
        vat_amount=100.0,
        total_incl_vat=2100.0,
        status="dispatched",
        invoice_sequence_no=f"TIA-CN-{uuid.uuid4().hex[:6]}",
        supplier_trn="100123456700003",
        line_items=[{"emp_id": "EMP10001", "employee_name": "Carlos", "days_worked": 22, "amount": 2000.0}],
        credit_note_sequence_no=f"TIA-CN-X-{uuid.uuid4().hex[:6]}",
        credit_note_issued_at=now,
        credit_note_issued_by="finops",
        credit_note_reason_code="PRICING_ERROR",
        credit_note_reason_text="rate too high",
        credit_note_article_refs=["UAE VAT Law Article 60"],
        credit_note_amount=500.0,
        credit_note_disputed_hours=4.0,
        adjustment_type="DEDUCT_FROM_NEXT_INVOICE",
    )
    s.add(inv)
    s.flush()
    out = RND.render_invoice_with_credit_note(inv)
    assert Path(out).exists() and Path(out).stat().st_size > 1000


def test_render_invoice_with_full_credit_note(s):
    now = dt.datetime.now(dt.timezone.utc)
    inv = Invoice(
        id=str(uuid.uuid4()),
        timesheet_id=f"cn2:{uuid.uuid4()}",
        client_code="CL001",
        period="June 2026",
        amount=2000.0,
        currency="AED",
        total_excl_vat=2000.0,
        vat_amount=100.0,
        total_incl_vat=2100.0,
        status="dispatched",
        invoice_sequence_no=f"TIA-CN2-{uuid.uuid4().hex[:6]}",
        line_items=[{"emp_id": "EMP10001", "employee_name": "Carlos", "days_worked": 22, "amount": 2000.0}],
        credit_note_sequence_no=f"TIA-CN2-X-{uuid.uuid4().hex[:6]}",
        credit_note_issued_at=now,
        credit_note_issued_by="finops",
        credit_note_reason_code="DUPLICATE",
        credit_note_amount=2000.0,  # full
        adjustment_type="CREDIT_TO_CLIENT",
    )
    s.add(inv)
    s.flush()
    out = RND.render_invoice_with_credit_note(inv)
    assert Path(out).exists()


# ── orchestrator rust auto-dispatch ─────────────────────────────────────────────


def _gen_inv(s, amount=1000.0) -> Invoice:
    inv = Invoice(
        id=str(uuid.uuid4()),
        timesheet_id=f"rust:{uuid.uuid4()}",
        client_code="CL001",
        period="June 2026",
        amount=amount,
        currency="AED",
        line_items=[{"emp_id": "EMP10001", "amount": amount}],
        status="generated",
        invoice_sequence_no=f"TIA-RUST-{uuid.uuid4().hex[:8]}",
    )
    s.add(inv)
    s.flush()
    return inv


def test_auto_dispatch_rust_success(monkeypatch, s):
    monkeypatch.setenv("RUST_DISPATCH_URL", "http://rust.test")
    inv = _gen_inv(s)
    client = s.get(Client, "CL001")
    with respx.mock:
        respx.post(f"http://rust.test/dispatch/{inv.id}").mock(
            return_value=httpx.Response(200, json={"status": "dispatched", "engine": "rust"})
        )
        O._maybe_auto_dispatch(s, inv, client, [{"rule_id": "R7", "passed": True, "severity": "info"}])
    assert inv.status in ("client_approved", "dispatched")


def test_auto_dispatch_rust_unreachable(monkeypatch, s):
    monkeypatch.setenv("RUST_DISPATCH_URL", "http://rust.test")
    inv = _gen_inv(s)
    client = s.get(Client, "CL001")
    with respx.mock:
        respx.post(f"http://rust.test/dispatch/{inv.id}").mock(side_effect=httpx.ConnectError("down"))
        O._maybe_auto_dispatch(s, inv, client, [{"rule_id": "R7", "passed": True, "severity": "info"}])
    # rust unreachable → skipped event logged, invoice not dispatched by us
    from tia_ai.models import Event

    assert s.query(Event).filter(Event.entity_id == inv.id, Event.action == "auto_dispatch_skipped").count() >= 1


# ── render small branches: _sac_block, QR-failure except ───────────────────────


def test_sac_block_and_service_code():
    assert RND._sac_block({"sac_code": "998513"}).find("998513") >= 0
    assert RND._sac_block({}) == ""
    code, desc = RND._service_code_for({"sac_code": "998513"})
    assert code == "998513"
    code2, _ = RND._service_code_for({})
    assert "informational" in code2


def test_render_invoice_qr_failure_is_swallowed(monkeypatch):
    import tia_ai.invoice.qr as qr

    monkeypatch.setattr(qr, "make_whatsapp_qr", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("qr")))
    inv = {
        "client_name": "Emirates Steel",
        "client_code": "CL001",
        "period": "June 2026",
        "currency": "AED",
        "amount": 1000.0,
        "vat_rate": 0.05,
        "vat_amount": 50.0,
        "total_excl_vat": 1000.0,
        "total_incl_vat": 1050.0,
        "invoice_sequence_no": "TIA-QRFAIL-0001",
        "line_items": [{"emp_id": "EMP10001", "employee_name": "Carlos", "days_worked": 22, "amount": 1000.0}],
    }
    out = RND.render_invoice(inv, f"qrf-{uuid.uuid4().hex[:6]}")
    assert Path(out).exists()  # QR failure did not block the render

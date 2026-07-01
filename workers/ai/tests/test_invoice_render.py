"""Invoice rendering + branded WhatsApp QR (invoice/render.py, invoice/qr.py).

Renders are smoke-tested (they must produce a real, non-trivial PDF/PNG without
crashing). The pure helpers (_esc, _num, _audit_hash, _service_code_for,
whatsapp_url) get exact assertions.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from tia_ai.db import SessionLocal
from tia_ai.invoice.qr import WHATSAPP_NUMBER, make_whatsapp_qr, whatsapp_url
from tia_ai.invoice.render import (
    _audit_hash,
    _esc,
    _num,
    _service_code_for,
    render_invoice,
    render_invoice_with_credit_note,
)
from tia_ai.models import Invoice


# ── pure helpers ─────────────────────────────────────────────────────────────


def test_esc_escapes_typst_specials():
    out = _esc("a*b#c[d]")
    for ch in ("*", "#", "[", "]"):
        assert "\\" + ch in out
    assert _esc(None) == ""


def test_num_formats_two_decimals_and_handles_bad_input():
    assert _num(12.5) == "12.50"
    assert _num("not a number") == "0.00"
    assert _num(None) == "0.00"


def test_audit_hash_deterministic_and_sensitive():
    a = {"amount": 100, "client": "CL001"}
    assert _audit_hash(a) == _audit_hash(dict(a))
    assert _audit_hash({"amount": 101, "client": "CL001"}) != _audit_hash(a)
    assert len(_audit_hash(a)) == 16


def test_service_code_uae_default_vs_explicit_sac():
    code, desc = _service_code_for({"sac_code": None})
    assert "informational" in code
    code2, desc2 = _service_code_for({"sac_code": "998513"})
    assert code2 == "998513"
    assert "Contract Staffing" in desc2


# ── QR ───────────────────────────────────────────────────────────────────────


def test_whatsapp_url_embeds_number_and_invoice():
    url = whatsapp_url("TIA-CL002-JUNE2026-0001")
    assert url.startswith(f"https://wa.me/{WHATSAPP_NUMBER}?text=")
    # invoice number is URL-encoded into the prefilled message
    assert "TIA-CL002-JUNE2026-0001" in url


def test_make_whatsapp_qr_writes_png(tmp_path):
    out = make_whatsapp_qr("TIA-CL001-JUNE2026-0001", tmp_path / "qr.png")
    p = Path(out)
    assert p.exists()
    data = p.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"  # PNG signature
    assert len(data) > 1000


# ── full invoice render (Typst) ──────────────────────────────────────────────


def _invoice_dict():
    return {
        "client_name": "Emirates Steel Industries LLC",
        "client_code": "CL001",
        "period": "June 2026",
        "currency": "AED",
        "amount": 12345.67,
        "vat_rate": 0.05,
        "vat_amount": 617.28,
        "total_excl_vat": 12345.67,
        "total_incl_vat": 12962.95,
        "supplier_trn": "100123456700003",
        "customer_trn": "200200200000003",
        "invoice_sequence_no": "TIA-CL001-JUNE2026-0001",
        "place_of_supply": "Dubai, UAE",
        "sac_code": None,
        "requires_finance_approval": True,
        "line_items": [
            {
                "emp_id": "EMP10001",
                "employee_name": "Carlos Smith",
                "days_worked": 22,
                "prorated": 10000.0,
                "ot_amount": 500.0,
                "reimbursements": 0.0,
                "amount": 12075.0,
            }
        ],
        "exceptions": [{"employee_name": "Aisha Al Zaabi", "reason": "ambiguous match"}],
    }


def test_render_invoice_produces_pdf():
    out = render_invoice(_invoice_dict(), "render-test-001")
    p = Path(out)
    assert p.exists()
    head = p.read_bytes()[:5]
    assert head == b"%PDF-"
    assert p.stat().st_size > 1000


def test_render_invoice_with_no_line_items_still_renders():
    inv = _invoice_dict()
    inv["line_items"] = []
    out = render_invoice(inv, "render-test-empty")
    assert Path(out).read_bytes()[:5] == b"%PDF-"


def test_render_invoice_with_credit_note_appends_page():
    s = SessionLocal()
    try:
        import datetime as dt

        inv = Invoice(
            id=str(uuid.uuid4()),
            timesheet_id=f"cn:{uuid.uuid4()}",
            client_code="CL001",
            period="June 2026",
            amount=5000.0,
            currency="AED",
            line_items=[
                {
                    "emp_id": "EMP10001",
                    "employee_name": "Carlos Smith",
                    "days_worked": 22,
                    "prorated": 5000.0,
                    "ot_amount": 0.0,
                    "reimbursements": 0.0,
                    "amount": 6000.0,
                }
            ],
            invoice_sequence_no="TIA-CL001-JUNE2026-0009",
            supplier_trn="100123456700003",
            customer_trn="-",
            vat_rate=0.05,
            vat_amount=250.0,
            total_excl_vat=5000.0,
            total_incl_vat=5250.0,
            credit_note_sequence_no="TIA-CN-CL001-JUNE2026-0001",
            credit_note_issued_at=dt.datetime.now(dt.timezone.utc),
            credit_note_reason_code="PRICING_ERROR",
            credit_note_reason_text="rate was wrong",
            created_at=dt.datetime.now(dt.timezone.utc),
        )
        s.add(inv)
        s.flush()
        out = render_invoice_with_credit_note(inv)
        p = Path(out)
        assert p.exists()
        assert p.read_bytes()[:5] == b"%PDF-"
        # the combined doc (invoice + credit note page) is larger than a bare invoice
        assert p.stat().st_size > 1500
    finally:
        s.rollback()
        s.close()

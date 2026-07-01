"""Second batch of targeted coverage: eval row-metrics, leakage skip branches,
SAP logout best-effort, OCR layout list shape, rules.py no-threshold, synthgen
font path, and render credit-note date/QR/archive branches. Hermetic; no network.
"""

from __future__ import annotations

import uuid

import httpx
import pytest

from tia_ai.db import SessionLocal
from tia_ai.eval import run as evalrun
from tia_ai.finance import leakage as leak
from tia_ai.finance.leakage import compute_revenue_leakage
from tia_ai.integrations.sap_b1 import client as sap
from tia_ai.invoice import render as R
from tia_ai.models import Employee, Invoice, Payroll
from tia_ai.validate import rules as rules1
from tia_ai import ocr


# ── eval/run._row_metrics field mismatch (92-93) + run_case unmatched row (167) ─


class _FakeRow:
    def __init__(self, name, days=22.0, ot=0.0, hours=None, emp_id=None):
        self.employee_name = name
        self.days_worked = days
        self.ot_hours = ot
        self.hours = hours
        self.emp_id = emp_id
        self.leave_codes = []


class _FakeMatch:
    def __init__(self, chosen=None, ambiguous=False, confidence=0.9):
        self.chosen_emp_id = chosen
        self.ambiguous = ambiguous
        self.confidence = confidence


def test_row_metrics_field_mismatch_counts_false_negative():
    # matched by name, but days_worked differs → fn increment + ok=False (92-93)
    expected = [{"employee_name": "Carlos", "days_worked": 22}]
    got_rows = [_FakeRow("Carlos", days=20.0)]
    got_matches = [_FakeMatch(chosen=None)]
    m = evalrun._row_metrics(expected, got_rows, got_matches)
    assert m["fn"]["days_worked"] == 1
    assert m["rows"][0]["matched"] is True
    assert m["rows"][0]["row_ok"] is False


def test_run_case_skips_unmatched_row_in_calibration(monkeypatch):
    """Force an extracted set that doesn't match the gold rows so a metrics row is
    'matched: False' — exercising the calibration `continue` (line 167)."""
    from tia_ai.schema import MatchResult, RowMatch, TimesheetExtraction, TimesheetRow

    # a gold case that exists on disk
    case = "07"
    # extraction with a bogus employee that won't match any gold row
    ex = TimesheetExtraction(client_code="CL001", period="June 2026",
                             rows=[TimesheetRow(employee_name="Nobody Nowhere")])
    # resolve returns ONE match (for the bogus extracted row) — so the calibration
    # zip has a match to pair against the (unmatched) gold rows, exercising line 167.
    mr = MatchResult(matches=[RowMatch(row_idx=0, chosen_emp_id="EMP99999", confidence=0.8)])
    monkeypatch.setattr(evalrun, "extract", lambda *a, **k: ex)
    monkeypatch.setattr(evalrun, "resolve", lambda e, s: mr)
    monkeypatch.setattr(evalrun, "build_invoice", lambda e, m, s: {"amount": 0.0, "client_code": "CL001", "exceptions": []})
    res = evalrun.run_case(case)
    # gold rows are unmatched → not passed, and calibration skipped them (167) without error
    assert res["passed"] is False
    assert res["calibration"] == []


# ── finance.leakage skip branches (330 no client_code, 337 no leakage) ─────────


_PERIOD = "COVLEAK 2099"


@pytest.fixture()
def s():
    sess = SessionLocal()
    try:
        yield sess
    finally:
        sess.rollback()
        sess.close()


def test_leakage_skips_payroll_without_client_code(s):
    emp = s.query(Employee).filter(Employee.client_code == "CL001").first()
    # payroll row with an EMPTY client_code (NOT NULL column) → falsy → skipped (line 330)
    s.add(
        Payroll(
            id=str(uuid.uuid4()), emp_id=emp.emp_id, employee_name=emp.full_name,
            client_code="", period=_PERIOD, gross=9000.0, basic=9000.0, ot_hours=0,
            ot_amount=0, net_pay=9000.0, currency="AED", working_days=22,
        )
    )
    s.flush()
    report = compute_revenue_leakage(s, period=_PERIOD)
    # the empty-client_code row contributed nothing
    assert all(e.emp_id != emp.emp_id for e in report.entries)


def test_leakage_skips_fully_billed_row(s):
    """A payroll row that IS fully billed (matching invoice line) → _classify
    returns None → the `continue` at line 337 fires."""
    emp = s.query(Employee).filter(Employee.client_code == "CL001").first()
    gross = 10000.0
    s.add(
        Payroll(
            id=str(uuid.uuid4()), emp_id=emp.emp_id, employee_name=emp.full_name,
            client_code="CL001", period=_PERIOD, gross=gross, basic=gross, ot_hours=0,
            ot_amount=0, net_pay=gross, currency="AED", working_days=22,
        )
    )
    # invoice fully covers this employee for the period (days billed == working days,
    # amount >= full cost with markup) → no leakage
    s.add(
        Invoice(
            id=str(uuid.uuid4()),
            timesheet_id=f"cov:{uuid.uuid4()}",
            client_code="CL001",
            period=_PERIOD,
            amount=gross * 1.5,
            currency="AED",
            status="generated",
            invoice_sequence_no=f"TIA-COV-{uuid.uuid4().hex[:8]}",
            line_items=[{"emp_id": emp.emp_id, "days_worked": 22, "ot_hours": 0, "amount": gross * 1.5}],
        )
    )
    s.flush()
    report = compute_revenue_leakage(s, period=_PERIOD, client_code="CL001")
    assert all(e.emp_id != emp.emp_id for e in report.entries)


# ── SAP logout best-effort swallow (69-70) ─────────────────────────────────────


def test_sap_logout_failure_is_swallowed(monkeypatch):
    monkeypatch.setattr(sap, "SAP_B1_BASE_URL", "https://sap.example/")
    monkeypatch.setattr(sap, "SAP_B1_COMPANY_DB", "DB")
    monkeypatch.setattr(sap, "SAP_B1_USER", "u")
    monkeypatch.setattr(sap, "SAP_B1_PASSWORD", "p")

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.endswith("/Login"):
            return httpx.Response(200, json={"SessionId": "x"})
        if req.url.path.endswith("/Invoices"):
            return httpx.Response(201, json={"DocEntry": 1, "DocNum": 2})
        if req.url.path.endswith("/Logout"):
            raise httpx.ConnectError("logout socket died")  # → except: pass (69-70)
        return httpx.Response(204)

    real_client = httpx.Client

    def _fake_client(*a, **k):
        k["transport"] = httpx.MockTransport(handler)
        k.pop("verify", None)
        return real_client(*a, **k)

    monkeypatch.setattr(sap.httpx, "Client", _fake_client)
    # logout raising must NOT propagate; the invoice result still returns
    res = sap.post_invoice({"CardCode": "CL001"})
    assert res == {"DocEntry": 1, "DocNum": 2, "status": 201}


# ── OCR glm_layout returns a bare JSON list (line 192) ─────────────────────────


import respx  # noqa: E402


@respx.mock
def test_glm_layout_returns_plain_list(monkeypatch):
    monkeypatch.setattr(ocr, "GLM_OCR_BASE_URL", "https://glm.test/v1")
    monkeypatch.setattr(ocr, "GLM_OCR_MODEL", "glm-ocr")
    monkeypatch.setattr(ocr, "GLM_OCR_API_KEY", "k")
    monkeypatch.setattr(ocr, "GLM_OCR_CONNECT_TIMEOUT", 5.0)
    # a list with NO objects → _strip_json leaves it intact → json.loads → list (192)
    respx.post("https://glm.test/v1/chat/completions").mock(
        return_value=httpx.Response(200, json={"choices": [{"message": {"content": "[1, 2, 3]"}}]})
    )
    assert ocr.glm_layout(b"x") == [1, 2, 3]


# ── validate/rules.check_threshold no-threshold branch (line 114) ──────────────


def test_check_threshold_none_passes_as_warning():
    r = rules1.check_threshold(1000.0, None)
    assert r.passed is True
    assert r.severity == "warning"
    assert "no threshold" in r.message


# ── synthgen case04 font-load happy path (line 382) ────────────────────────────


def test_synthgen_case04_font_load(monkeypatch):
    from tia_ai import synthgen as G  # noqa: F401
    from PIL import Image, ImageDraw, ImageFont

    class _FakeFont:
        pass

    class _FakeDraw:
        def text(self, *a, **k):
            pass

        def rectangle(self, *a, **k):
            pass

    class _FakeImg:
        size = (900, 600)

        def save(self, path):
            _FakeImg.saved = str(path)

    # make truetype succeed for BOTH font loads so line 382 runs (env may lack the ttf)
    monkeypatch.setattr(ImageFont, "truetype", lambda *a, **k: _FakeFont())
    monkeypatch.setattr(ImageDraw, "Draw", lambda img: _FakeDraw())
    monkeypatch.setattr(Image, "new", lambda *a, **k: _FakeImg())
    G.case04_handwritten()
    assert _FakeImg.saved.endswith("case_04_handwritten.png")


# ── render credit-note date/QR/archive branches (532-535, 553-554, 673-674) ────


def _cn_inv_dict(issued_at):
    return {
        "id": uuid.uuid4().hex,
        "client_code": "CL002",
        "client_name": "Emaar Properties PJSC",
        "period": "June 2026",
        "currency": "AED",
        "amount": 10000.0,
        "vat_rate": 0.05,
        "vat_amount": 500.0,
        "total_excl_vat": 10000.0,
        "total_incl_vat": 10500.0,
        "invoice_sequence_no": "TIA-CL002-JUNE2026-0001",
        "credit_note_sequence_no": "TIA-CL002-JUNE2026-CN001",
        "credit_note_issued_at": issued_at,
        "credit_note_reason_code": "PRICING_ERROR",
        "credit_note_reason_text": "rate was wrong",
        "line_items": [{"emp_id": "EMP10021", "employee_name": "X", "days_worked": 22, "amount": 10000.0}],
    }


def test_credit_note_source_issued_at_string_date():
    src = R._credit_note_source(_cn_inv_dict("2026-06-30T10:00:00"), "abc123")
    assert "2026-06-30" in src  # cn_date sliced from the string (532-533)


def test_credit_note_source_issued_at_none_uses_today():
    import datetime as dt

    src = R._credit_note_source(_cn_inv_dict(None), "abc123")
    assert dt.date.today().isoformat() in src  # else branch → today (534-535)


def test_credit_note_source_qr_failure_swallowed(monkeypatch):
    import tia_ai.invoice.qr as qrmod

    monkeypatch.setattr(
        qrmod, "make_whatsapp_qr", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("qr down"))
    )
    src = R._credit_note_source(_cn_inv_dict(None), "abc123")
    # QR panel omitted (553-554) but the credit note still renders
    assert "TAX CREDIT NOTE" in src
    assert "image(" not in src  # no QR image block


def test_render_with_credit_note_archive_failure_swallowed(monkeypatch, s):
    import shutil

    inv = Invoice(
        id=str(uuid.uuid4()),
        timesheet_id=f"cn:{uuid.uuid4()}",
        client_code="CL002",
        period="June 2026",
        amount=10000.0,
        currency="AED",
        status="dispatched",
        invoice_sequence_no=f"TIA-CN-{uuid.uuid4().hex[:8]}",
        vat_rate=0.05,
        vat_amount=500.0,
        total_excl_vat=10000.0,
        total_incl_vat=10500.0,
        line_items=[{"emp_id": "EMP10021", "employee_name": "X", "days_worked": 22, "amount": 10000.0}],
        credit_note_sequence_no="TIA-CN-CN001",
        credit_note_reason_code="PRICING_ERROR",
    )
    # give it an existing pdf_path so the archive-copy branch runs, then make copy2 fail
    from tia_ai.config import STAGING_DIR
    from pathlib import Path

    pdf = Path(STAGING_DIR) / f"orig_{uuid.uuid4().hex[:6]}.pdf"
    pdf.write_bytes(b"%PDF-1.4 original")
    inv.pdf_path = str(pdf)
    s.add(inv)
    s.flush()
    monkeypatch.setattr(
        shutil, "copy2", lambda *a, **k: (_ for _ in ()).throw(OSError("disk full"))
    )
    out = R.render_invoice_with_credit_note(inv)  # 673-674 swallow, still renders
    assert Path(out).exists()


# ── match.resolver: a name matching nobody → no candidates above threshold (183-184)


def test_resolver_no_candidate_above_threshold(s):
    from tia_ai.match.resolver import resolve
    from tia_ai.schema import TimesheetExtraction, TimesheetRow

    ex = TimesheetExtraction(
        client_code="CL001",
        period="June 2026",
        rows=[TimesheetRow(employee_name="Zzxqwv Nonexistent Persona")],
    )
    mr = resolve(ex, s)
    m = mr.matches[0]
    assert m.chosen_emp_id is None  # no candidate above threshold (183-184)
    assert m.confidence == 0.0
    assert "no candidate" in m.reason

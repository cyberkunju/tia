"""Remaining qa/agent read-tool edges: not-found + scope-denied branches,
_inv_client resolution, _citation_grounded per kind, reject_timesheet success."""

from __future__ import annotations

import datetime as dt
import uuid

import pytest

from tia_ai.db import SessionLocal
from tia_ai.models import Client, Employee, Invoice, Timesheet
from tia_ai.qa import agent as A


@pytest.fixture()
def s():
    sess = SessionLocal()
    try:
        yield sess
    finally:
        sess.rollback()
        sess.close()


def _inv(s, client_code="CL001") -> Invoice:
    inv = Invoice(
        id=str(uuid.uuid4()),
        timesheet_id=f"x:{uuid.uuid4()}",
        client_code=client_code,
        period="June 2026",
        amount=100.0,
        currency="AED",
        status="generated",
        invoice_sequence_no=f"TIA-RE-{uuid.uuid4().hex[:8]}",
    )
    s.add(inv)
    s.flush()
    return inv


# ── not-found + scope-denied read branches ────────────────────────────────────


def test_get_client_settings_not_found(s):
    assert A.tool_get_client_settings(s, "NOPE")["found"] is False


def test_get_contract_not_found(s):
    assert A.tool_get_contract(s, "NOPE")["found"] is False


def test_get_timesheet_not_found_and_scope(s):
    assert A.tool_get_timesheet(s, "nope")["found"] is False
    ts = Timesheet(id=str(uuid.uuid4()), client_code="CL001", status="approved")
    s.add(ts)
    s.flush()
    assert A.tool_get_timesheet(s, ts.id, scope="CL999").get("access") == "denied"


def test_get_events_scope_denied(s):
    inv = _inv(s, "CL001")
    from tia_ai.orchestrator import log_event

    log_event(s, "t", "invoice", inv.id, "generated", {"amount": 1})
    s.flush()
    denied = A.tool_get_events(s, inv.id, scope="CL999")
    assert denied.get("access") == "denied"


def test_get_employee_history_scope_denied(s):
    emp = s.query(Employee).filter(Employee.client_code == "CL001").first()
    denied = A.tool_get_employee_history(s, emp.emp_id, scope="CL999")
    assert denied.get("access") == "denied"


def test_list_clients_scope_restricts(s):
    res = A.tool_list_clients(s, scope="CL001")
    assert all(c["code"] == "CL001" for c in res["clients"])


def test_prepare_sap_payload_scope_denied(s):
    inv = _inv(s, "CL001")
    inv.line_items = [{"emp_id": "E", "amount": 100.0, "days_worked": 1}]
    s.flush()
    assert A.tool_prepare_sap_b1_payload(s, inv.id, scope="CL999").get("access") == "denied"


def test_prepare_sap_payload_value_error(s):
    inv = _inv(s, "CL001")
    inv.line_items = []  # no lines → mapping raises ValueError → ok False
    s.flush()
    res = A.tool_prepare_sap_b1_payload(s, inv.id)
    assert res["found"] is True and res["ok"] is False


# ── _inv_client resolution ─────────────────────────────────────────────────────


def test_inv_client_resolves_invoice_timesheet_client(s):
    inv = _inv(s, "CL001")
    assert A._inv_client(s, inv.id) == "CL001"
    assert A._inv_client(s, inv.invoice_sequence_no) == "CL001"
    ts = Timesheet(id=str(uuid.uuid4()), client_code="CL002", status="approved")
    s.add(ts)
    s.flush()
    assert A._inv_client(s, ts.id) == "CL002"
    c = s.query(Client).first()
    assert A._inv_client(s, c.code) == c.code
    assert A._inv_client(s, "totally-unknown") is None


# ── _citation_grounded per kind ────────────────────────────────────────────────


def test_citation_grounded_invoice(s):
    inv = _inv(s, "CL001")
    assert A._citation_grounded(s, "invoice", inv.id, None) is True
    assert A._citation_grounded(s, "invoice", inv.id, "CL001") is True
    assert A._citation_grounded(s, "invoice", "deadbeefdead", "CL001") is False


def test_citation_grounded_timesheet(s):
    ts = Timesheet(id=str(uuid.uuid4()), client_code="CL001", status="approved")
    s.add(ts)
    s.flush()
    assert A._citation_grounded(s, "timesheet", ts.id[:8], None) is True
    assert A._citation_grounded(s, "timesheet", "nope1234", "CL001") is False


def test_citation_grounded_client_and_employee(s):
    c = s.query(Client).first()
    assert A._citation_grounded(s, "client", c.code, None) is True
    assert A._citation_grounded(s, "client", c.code, c.code) is True
    assert A._citation_grounded(s, "client", "ZZ999", None) is False
    emp = s.query(Employee).filter(Employee.client_code == "CL001").first()
    assert A._citation_grounded(s, "employee", emp.emp_id[:6], None) is True
    assert A._citation_grounded(s, "emp", "EMP_NONE", "CL001") is False
    # unknown kind → treated as grounded
    assert A._citation_grounded(s, "rule", "R4", None) is True


def test_invalid_citations_filters_short_and_unknown(s):
    # short id + unknown kind → skipped; a bad invoice id → flagged
    bad = A._invalid_citations(s, "see [invoice:zzzzzzzz] and [rule:R4] and [x:ab]", "CL001")
    assert any(c["kind"] == "invoice" for c in bad)
    assert not any(c["kind"] == "rule" for c in bad)


# ── tool_reject_timesheet success (with whatsapp notify best-effort) ────────────


def test_reject_timesheet_success(s):
    ts = Timesheet(
        id=str(uuid.uuid4()),
        client_code="CL001",
        period="June 2026",
        status="awaiting_review",
        routing="hitl",
        created_at=dt.datetime.now(dt.timezone.utc),
    )
    s.add(ts)
    s.flush()
    res = A.tool_reject_timesheet(s, ts.id, reason="illegible scan")
    assert res["ok"] is True
    assert res["status"] == "rejected"
    assert "whatsapp_notified" in res

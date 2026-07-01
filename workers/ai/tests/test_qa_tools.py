"""Grounded QA read tools + degraded agent path (qa/agent.py, qa/streaming.py).

test_qa_scope.py covers the scope-isolation of three tools. This file covers the
remaining DB-grounded read tools (list_invoices, verify_audit_chain, metrics_stp,
get_invoice, get_events, find_revenue_leakage, prepare_sap_b1_payload,
get_employee_history) plus the not-configured degraded answer and the streaming
pure helpers - all with NO LLM (credentials are blanked by conftest).
"""

from __future__ import annotations

import datetime as dt
import uuid

import pytest

from tia_ai.db import SessionLocal
from tia_ai.models import Employee, Invoice, Payroll
from tia_ai.qa import answer
from tia_ai.qa import agent as A
from tia_ai.qa.streaming import _result_summary, _tokenize_for_stream


@pytest.fixture()
def s():
    sess = SessionLocal()
    try:
        yield sess
    finally:
        sess.rollback()
        sess.close()


def _seed_invoice(s, *, client_code="CL001", status="generated", amount=1234.0) -> Invoice:
    inv = Invoice(
        id=str(uuid.uuid4()),
        timesheet_id=f"qa:{uuid.uuid4()}",
        client_code=client_code,
        period="June 2026",
        amount=amount,
        currency="AED",
        status=status,
        invoice_sequence_no=f"TIA-QA-{uuid.uuid4().hex[:8]}",
        vat_amount=round(amount * 0.05, 2),
        total_excl_vat=amount,
        total_incl_vat=round(amount * 1.05, 2),
        line_items=[{"emp_id": "EMP10001", "employee_name": "Carlos Smith", "days_worked": 22, "amount": amount}],
        rule_results=[{"rule_id": "R7", "rule_name": "vat_calculation_correct", "passed": True, "severity": "info", "message": "ok"}],
        created_at=dt.datetime.now(dt.timezone.utc),
    )
    s.add(inv)
    s.flush()
    return inv


# ── degraded agent (no credentials) ───────────────────────────────────────────


def test_answer_degrades_without_credentials(s):
    res = answer(s, "what is my invoice total?", client_scope="CL001")
    assert "not configured" in res["answer"].lower()
    assert res["citations"] == []
    assert res["tool_calls"] == []


def test_route_intent_none_without_credentials():
    # no LLM configured → router returns None so the caller falls back
    assert A.route_intent("EMP10001 worked 22 days") is None


# ── tool_get_invoice ──────────────────────────────────────────────────────────


def test_tool_get_invoice_by_id_and_sequence_no(s):
    inv = _seed_invoice(s)
    by_id = A.tool_get_invoice(s, inv.id)
    assert by_id["found"] is True
    assert by_id["id"] == inv.id
    assert by_id["amount"] == inv.amount
    assert by_id["rule_results"][0]["rule_id"] == "R7"
    # sequence_no resolution works too
    by_seq = A.tool_get_invoice(s, inv.invoice_sequence_no)
    assert by_seq["found"] is True and by_seq["id"] == inv.id


def test_tool_get_invoice_not_found(s):
    assert A.tool_get_invoice(s, "does-not-exist")["found"] is False


def test_tool_get_invoice_scope_denied(s):
    inv = _seed_invoice(s, client_code="CL001")
    denied = A.tool_get_invoice(s, inv.id, scope="CL999")
    assert denied.get("access") == "denied"


# ── tool_list_invoices ────────────────────────────────────────────────────────


def test_tool_list_invoices_filters_by_status(s):
    inv = _seed_invoice(s, status="generated")
    res = A.tool_list_invoices(s, client_code="CL001", status="generated")
    assert res["found"] is True
    assert any(x["id"] == inv.id for x in res["invoices"])
    assert res["filter"]["status"] == "generated"


def test_tool_list_invoices_scope_overrides_client_arg(s):
    _seed_invoice(s, client_code="CL001")
    # a client-scoped caller cannot widen to another client via the arg
    res = A.tool_list_invoices(s, client_code="CL002", scope="CL001")
    assert res["filter"]["client_code"] == "CL001"
    assert all(x["client_code"] == "CL001" for x in res["invoices"])


def test_tool_list_invoices_limit_capped_at_50(s):
    res = A.tool_list_invoices(s, limit=9999)
    assert res["filter"]["limit"] == 50


# ── tool_verify_audit_chain / tool_metrics_stp ───────────────────────────────


def test_tool_verify_audit_chain_reports_head(s):
    res = A.tool_verify_audit_chain(s)
    assert set(["ok", "total_events", "head_hash", "error_count"]) <= set(res)
    assert isinstance(res["ok"], bool)
    assert res["total_events"] >= 0


def test_tool_metrics_stp_rate_in_range(s):
    res = A.tool_metrics_stp(s)
    assert 0.0 <= res["rate"] <= 1.0
    assert res["auto"] <= res["routed"]
    assert res["rate_pct_label"].endswith("%")


# ── tool_get_events ───────────────────────────────────────────────────────────


def test_tool_get_events_for_entity(s):
    from tia_ai.orchestrator import log_event

    eid = f"qa-ent-{uuid.uuid4()}"
    log_event(s, "tester", "invoice", eid, "generated", {"amount": 100, "client": "CL001"})
    s.flush()
    res = A.tool_get_events(s, eid)
    assert res["found"] is True
    assert res["events"][0]["action"] == "generated"
    # payload is summarised to a whitelist of keys
    assert res["events"][0]["payload_summary"].get("amount") == 100


# ── tool_find_revenue_leakage ─────────────────────────────────────────────────


def test_tool_find_revenue_leakage_truncates_entries(s):
    period = "QATEST 2099"
    emps = s.query(Employee).filter(Employee.client_code == "CL001").limit(3).all()
    for e in emps:
        s.add(
            Payroll(
                id=str(uuid.uuid4()),
                emp_id=e.emp_id,
                employee_name=e.full_name,
                client_code="CL001",
                period=period,
                gross=10000.0,
                basic=10000.0,
                ot_hours=0,
                ot_amount=0,
                net_pay=10000.0,
                currency="AED",
                working_days=22,
            )
        )
    s.flush()
    res = A.tool_find_revenue_leakage(s, period=period, client_code="CL001")
    assert res["period"] == period
    assert res["total_aed"] > 0
    assert res["total_entries_truncated_to"] == 10
    assert len(res["entries"]) <= 10


def test_tool_find_revenue_leakage_scope_forces_own_client(s):
    denied = A.tool_find_revenue_leakage(s, period="June 2026", client_code="CL002", scope="CL001")
    assert denied.get("access") == "denied"


# ── tool_prepare_sap_b1_payload ───────────────────────────────────────────────


def test_tool_prepare_sap_payload_ok(s):
    inv = _seed_invoice(s, amount=7200.0)
    res = A.tool_prepare_sap_b1_payload(s, inv.id)
    assert res["found"] is True and res["ok"] is True
    assert res["endpoint"] == "POST /b1s/v2/Invoices"
    assert res["payload"]["CardCode"] == "CL001"


def test_tool_prepare_sap_payload_not_found(s):
    assert A.tool_prepare_sap_b1_payload(s, "nope")["found"] is False


# ── tool_get_employee_history ─────────────────────────────────────────────────


def test_tool_get_employee_history(s):
    emp = s.query(Employee).filter(Employee.client_code == "CL001").first()
    res = A.tool_get_employee_history(s, emp.emp_id)
    assert res["found"] is True
    assert res["emp_id"] == emp.emp_id
    assert "payroll_history" in res and "billed_history" in res


def test_tool_get_employee_history_unknown(s):
    assert A.tool_get_employee_history(s, "EMP_NOPE_XX")["found"] is False


# ── streaming pure helpers ────────────────────────────────────────────────────


def test_tokenize_for_stream_roundtrips():
    text = "alpha beta gamma delta epsilon zeta eta theta"
    chunks = _tokenize_for_stream(text, chunk_size=3)
    assert "".join(chunks).strip() == text
    assert len(chunks) >= 2
    assert _tokenize_for_stream("") == []


def test_result_summary_branches():
    assert _result_summary({"error": "boom"}).startswith("error:")
    assert _result_summary({"access": "denied"}) == "access denied (out of scope)"
    assert _result_summary({"found": False}) == "no result"
    assert _result_summary({"total_aed": 1000, "associate_count": 3}).startswith("AED")
    assert _result_summary({"rate": 0.8, "routed": 10, "rate_pct_label": "80.0%"}) == "80.0% touchless"
    assert _result_summary({"matches": [1, 2]}) == "2 matches"
    assert _result_summary("not a dict") == "done"

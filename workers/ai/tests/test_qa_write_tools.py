"""Agent WRITE tools in qa/agent.py — every branch, deterministic.

Real DB mutations where they're light (recover_leakage, pre/post-dispatch
clawback); the heavy delegations (orchestrator.dispatch/approve, SMTP send) are
monkeypatched at their seam so we test the wrapper's arg-forwarding, result
shaping, and audit-invocation without invoking render/email pipelines.
"""

from __future__ import annotations

import datetime as dt
import uuid

import pytest

from tia_ai.db import SessionLocal
from tia_ai.models import Employee, Event, Invoice, Payroll, Timesheet
from tia_ai.qa import agent as A


@pytest.fixture()
def s():
    sess = SessionLocal()
    try:
        yield sess
    finally:
        sess.rollback()
        sess.close()


def _emp(s, client_code="CL001") -> Employee:
    return s.query(Employee).filter(Employee.client_code == client_code).first()


def _seed_invoice(s, *, client_code="CL001", status="generated", amount=1234.0) -> Invoice:
    inv = Invoice(
        id=str(uuid.uuid4()),
        timesheet_id=f"qa:{uuid.uuid4()}",
        client_code=client_code,
        period="June 2026",
        amount=amount,
        currency="AED",
        status=status,
        invoice_sequence_no=f"TIA-W-{uuid.uuid4().hex[:8]}",
        vat_amount=round(amount * 0.05, 2),
        total_excl_vat=amount,
        total_incl_vat=round(amount * 1.05, 2),
        line_items=[{"emp_id": "EMP10001", "amount": amount}],
        created_at=dt.datetime.now(dt.timezone.utc),
    )
    s.add(inv)
    s.flush()
    return inv


# ── recover_leakage ────────────────────────────────────────────────────────────


def test_recover_leakage_unknown_employee(s):
    res = A.tool_recover_leakage(s, emp_id="EMP_NOPE", period="June 2026")
    assert res["ok"] is False and "unknown employee" in res["reason"]


def test_recover_leakage_scope_denied(s):
    emp = _emp(s, "CL001")
    denied = A.tool_recover_leakage(s, emp_id=emp.emp_id, period="June 2026", scope="CL999")
    assert denied.get("access") == "denied"


def test_recover_leakage_no_payroll_error_path(s):
    emp = _emp(s, "CL001")
    res = A.tool_recover_leakage(s, emp_id=emp.emp_id, period="ZZZ 1999")
    assert res["ok"] is False and "no payroll" in res["reason"]
    # error is logged on the chain
    assert (
        s.query(Event)
        .filter(Event.action == "agent.recover_leakage_invoked")
        .count()
        >= 1
    )


def test_recover_leakage_success_creates_invoice_and_chains(s):
    emp = _emp(s, "CL001")
    period = f"RECOVER {uuid.uuid4().hex[:6]}"
    s.add(
        Payroll(
            id=str(uuid.uuid4()),
            emp_id=emp.emp_id,
            employee_name=emp.full_name,
            client_code="CL001",
            period=period,
            gross=12000.0,
            basic=12000.0,
            ot_hours=0,
            ot_amount=0,
            net_pay=12000.0,
            currency="AED",
            working_days=22,
        )
    )
    s.flush()
    res = A.tool_recover_leakage(s, emp_id=emp.emp_id, period=period)
    assert res["ok"] is True
    assert res["amount_aed"] > 0
    assert res["invoice_sequence_no"].endswith("R001")
    assert res["audit_chain_head"]  # verify_audit_chain returned a head


# ── dispatch_invoice ────────────────────────────────────────────────────────────


def test_dispatch_invoice_not_found(s):
    assert A.tool_dispatch_invoice(s, "nope")["ok"] is False


def test_dispatch_invoice_scope_denied(s):
    inv = _seed_invoice(s, client_code="CL001")
    assert A.tool_dispatch_invoice(s, inv.id, scope="CL999").get("access") == "denied"


def test_dispatch_invoice_success(monkeypatch, s):
    import tia_ai.orchestrator as orch

    inv = _seed_invoice(s)
    monkeypatch.setattr(orch, "dispatch_invoice", lambda *a, **k: {"status": "dispatched"})
    res = A.tool_dispatch_invoice(s, inv.id)
    assert res["ok"] is True and res["status"] == "dispatched"
    assert s.query(Event).filter(Event.action == "agent.dispatch_invoice_invoked").count() >= 1


def test_dispatch_invoice_error_is_logged(monkeypatch, s):
    import tia_ai.orchestrator as orch

    inv = _seed_invoice(s)

    def _boom(*a, **k):
        raise RuntimeError("dispatch blew up")

    monkeypatch.setattr(orch, "dispatch_invoice", _boom)
    res = A.tool_dispatch_invoice(s, inv.id)
    assert res["ok"] is False and "blew up" in res["reason"]


# ── clawback_invoice ────────────────────────────────────────────────────────────


def test_clawback_not_found(s):
    assert A.tool_clawback_invoice(s, "nope")["ok"] is False


def test_clawback_scope_denied(s):
    inv = _seed_invoice(s)
    assert A.tool_clawback_invoice(s, inv.id, scope="CL999").get("access") == "denied"


def test_clawback_already_settled(s):
    inv = _seed_invoice(s, status="voided")
    res = A.tool_clawback_invoice(s, inv.id)
    assert res["ok"] is True and res["action_taken"] == "already_settled"


def test_clawback_pre_dispatch_voids(s):
    inv = _seed_invoice(s, status="generated")
    res = A.tool_clawback_invoice(s, inv.id, reason_code="DUPLICATE")
    assert res["ok"] is True and res["action_taken"] == "voided"
    assert res["status"] == "voided"
    s.refresh(inv)
    assert inv.voided_by == "agent" and inv.voided_reason_code == "DUPLICATE"


def test_clawback_invalid_transition_is_caught(monkeypatch, s):
    import tia_ai.invoice.fsm as fsm

    inv = _seed_invoice(s, status="generated")

    def _boom(session, invoice, target):
        raise fsm.InvalidTransition(invoice.status, target)

    monkeypatch.setattr(fsm, "set_status", _boom)
    res = A.tool_clawback_invoice(s, inv.id)
    assert res["ok"] is False


def test_clawback_post_dispatch_requires_console(s):
    inv = _seed_invoice(s, status="dispatched")
    res = A.tool_clawback_invoice(s, inv.id)
    assert res["ok"] is False and res["action_taken"] == "requires_console"


# ── approve_timesheet ────────────────────────────────────────────────────────────


def _seed_ts(s, status="awaiting_review") -> Timesheet:
    ts = Timesheet(
        id=str(uuid.uuid4()),
        client_code="CL001",
        period="June 2026",
        status=status,
        routing="hitl",
        created_at=dt.datetime.now(dt.timezone.utc),
    )
    s.add(ts)
    s.flush()
    return ts


def test_approve_timesheet_not_found(s):
    assert A.tool_approve_timesheet(s, "nope")["ok"] is False


def test_approve_timesheet_scope_denied(s):
    ts = _seed_ts(s)
    assert A.tool_approve_timesheet(s, ts.id, scope="CL999").get("access") == "denied"


def test_approve_timesheet_already_approved(s):
    ts = _seed_ts(s, status="approved")
    res = A.tool_approve_timesheet(s, ts.id)
    assert res["ok"] is True and res["action_taken"] == "already_approved"


def test_approve_timesheet_success(monkeypatch, s):
    import tia_ai.orchestrator as orch

    ts = _seed_ts(s)
    inv = _seed_invoice(s)

    def _approve(session, timesheet, **k):
        timesheet.status = "approved"
        return inv

    monkeypatch.setattr(orch, "approve_timesheet", _approve)
    res = A.tool_approve_timesheet(s, ts.id)
    assert res["ok"] is True and res["invoice_id"] == inv.id
    assert s.query(Event).filter(Event.action == "agent.approve_timesheet_invoked").count() >= 1


def test_approve_timesheet_error_is_logged(monkeypatch, s):
    import tia_ai.orchestrator as orch

    ts = _seed_ts(s)
    monkeypatch.setattr(
        orch, "approve_timesheet", lambda *a, **k: (_ for _ in ()).throw(ValueError("nope"))
    )
    res = A.tool_approve_timesheet(s, ts.id)
    assert res["ok"] is False and "nope" in res["reason"]


# ── resend_invoice_email ────────────────────────────────────────────────────────


def test_resend_email_not_found(s):
    assert A.tool_resend_invoice_email(s, "nope")["ok"] is False


def test_resend_email_scope_denied(s):
    inv = _seed_invoice(s)
    assert A.tool_resend_invoice_email(s, inv.id, scope="CL999").get("access") == "denied"


def test_resend_email_sent(monkeypatch, s):
    import tia_ai.mailbox.sender as sender

    inv = _seed_invoice(s)
    monkeypatch.setattr(
        sender,
        "send_invoice_email",
        lambda *a, **k: {"sent": True, "to": "x@y.com", "message_id": "<mid>"},
    )
    res = A.tool_resend_invoice_email(s, inv.id)
    assert res["ok"] is True and res["to"] == "x@y.com"


def test_resend_email_skipped(monkeypatch, s):
    import tia_ai.mailbox.sender as sender

    inv = _seed_invoice(s)
    monkeypatch.setattr(
        sender, "send_invoice_email", lambda *a, **k: {"sent": False, "skipped": "smtp_unconfigured"}
    )
    res = A.tool_resend_invoice_email(s, inv.id)
    assert res["ok"] is False


def test_resend_email_exception_is_logged(monkeypatch, s):
    import tia_ai.mailbox.sender as sender

    inv = _seed_invoice(s)
    monkeypatch.setattr(
        sender, "send_invoice_email", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("smtp"))
    )
    res = A.tool_resend_invoice_email(s, inv.id)
    assert res["ok"] is False and "smtp" in res["reason"]

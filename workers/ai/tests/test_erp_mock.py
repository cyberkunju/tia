"""Mock-ERP invoice builder tests (erp/mock.py).

`build_invoice` is the money engine: it prorates the monthly cost by attendance,
recomputes OT from the statutory formula (basic / 26 / 8 x hrs x 1.25), applies
the client markup, adds reimbursements, and classifies unresolved / ambiguous /
no-payroll rows as exceptions. It had no direct unit test - this pins the exact
decimal math and every branch of the row loop.

Uses a synthetic (client, period) with round numbers, rolled back so it never
pollutes the shared DB.
"""

from __future__ import annotations

import uuid
from decimal import Decimal

import pytest

from tia_ai.db import SessionLocal
from tia_ai.erp.mock import build_invoice, client_settings
from tia_ai.models import Client, Employee, Payroll
from tia_ai.schema import (
    Candidate,
    MatchResult,
    Reimbursement,
    RowMatch,
    TimesheetExtraction,
    TimesheetRow,
)

_PERIOD = "MOCKTEST 2099"


@pytest.fixture()
def s():
    sess = SessionLocal()
    try:
        yield sess
    finally:
        sess.rollback()
        sess.close()


def _cl001_emp(s) -> Employee:
    e = s.query(Employee).filter(Employee.client_code == "CL001").first()
    assert e is not None, "seed employee missing"
    return e


def _seed_payroll(s, emp, *, gross=10000.0, basic=8000.0, ot_hours=0.0, ot_amount=0.0,
                  working_days=20) -> Payroll:
    pr = Payroll(
        id=str(uuid.uuid4()),
        emp_id=emp.emp_id,
        employee_name=emp.full_name,
        client_code="CL001",
        period=_PERIOD,
        basic=basic,
        housing=gross - basic,  # keeps gross == sum(components) so check_gross passes
        transport=0.0,
        food=0.0,
        phone=0.0,
        gross=gross,
        ot_hours=ot_hours,
        ot_amount=ot_amount,
        deductions=0.0,
        net_pay=gross + ot_amount,
        currency="AED",
        working_days=working_days,
    )
    s.add(pr)
    s.flush()
    return pr


def _extraction(emp, *, days_worked=20, ot_hours=None, reimbursements=None) -> TimesheetExtraction:
    return TimesheetExtraction(
        client_code="CL001",
        period=_PERIOD,
        rows=[
            TimesheetRow(
                employee_name=emp.full_name,
                emp_id=emp.emp_id,
                days_worked=days_worked,
                ot_hours=ot_hours,
                reimbursements=reimbursements or [],
            )
        ],
    )


def _match_resolved(emp) -> MatchResult:
    return MatchResult(
        matches=[RowMatch(row_idx=0, chosen_emp_id=emp.emp_id, ambiguous=False, confidence=0.95)]
    )


# ── proration + markup (exact decimal) ───────────────────────────────────────


def test_full_attendance_prorates_full_gross_and_applies_markup(s):
    emp = _cl001_emp(s)
    _seed_payroll(s, emp, gross=10000.0, basic=8000.0, working_days=20)
    inv = build_invoice(_extraction(emp, days_worked=20), _match_resolved(emp), s)

    assert inv["client_code"] == "CL001"
    assert len(inv["line_items"]) == 1
    li = inv["line_items"][0]
    # attended 20 == std 20 → full gross prorated
    assert li["prorated"] == 10000.0
    assert li["ot_amount"] == 0.0
    assert li["reimbursements"] == 0.0

    markup = float(client_settings(s.get(Client, "CL001"))["markup_pct"])
    expected = round(10000.0 * (1.0 + markup), 2)
    assert li["amount"] == expected
    assert inv["amount"] == expected
    assert li["markup_pct"] == markup


def test_partial_attendance_prorates_down(s):
    emp = _cl001_emp(s)
    _seed_payroll(s, emp, gross=10000.0, basic=8000.0, working_days=20)
    inv = build_invoice(_extraction(emp, days_worked=10), _match_resolved(emp), s)
    li = inv["line_items"][0]
    # 10 of 20 days → half the gross
    assert li["prorated"] == 5000.0
    assert li["days_worked"] == 10.0
    assert li["standard_days"] == 20


# ── OT recomputed from the statutory formula (basic / 26 / 8 x hrs x 1.25) ────


def test_overtime_uses_statutory_formula(s):
    emp = _cl001_emp(s)
    _seed_payroll(s, emp, gross=10000.0, basic=8000.0, ot_hours=10, ot_amount=480.77,
                  working_days=20)
    inv = build_invoice(_extraction(emp, days_worked=20, ot_hours=10), _match_resolved(emp), s)
    li = inv["line_items"][0]
    # 8000 / 208 * 10 * 1.25 = 480.7692… → 480.77
    assert li["ot_amount"] == 480.77
    # hourly rate = 8000 / 208 * 1.25 = 48.0769… → 48.08
    assert li["ot_hourly_rate"] == 48.08
    assert li["ot_hours"] == 10.0

    markup = float(client_settings(s.get(Client, "CL001"))["markup_pct"])
    expected = round(
        float((Decimal("10000") + Decimal("480.77")) * (Decimal("1") + Decimal(str(markup)))), 2
    )
    # build_invoice computes (prorated + ot) * (1+markup) with Decimal; assert to the cent
    assert abs(li["amount"] - expected) < 0.02


def test_reimbursements_added_after_markup(s):
    emp = _cl001_emp(s)
    _seed_payroll(s, emp, gross=10000.0, basic=8000.0, working_days=20)
    ex = _extraction(
        emp, days_worked=20, reimbursements=[Reimbursement(reason="taxi", amount_aed=250.0)]
    )
    inv = build_invoice(ex, _match_resolved(emp), s)
    li = inv["line_items"][0]
    markup = float(client_settings(s.get(Client, "CL001"))["markup_pct"])
    # reimbursements are NOT marked up: (prorated+ot)*(1+markup) + reimb
    expected = round(10000.0 * (1 + markup) + 250.0, 2)
    assert li["reimbursements"] == 250.0
    assert abs(li["amount"] - expected) < 0.01


# ── exceptions: unresolved / ambiguous / no-payroll ──────────────────────────


def test_unresolved_row_becomes_exception(s):
    emp = _cl001_emp(s)
    _seed_payroll(s, emp)
    match = MatchResult(matches=[RowMatch(row_idx=0, chosen_emp_id=None, reason="unresolved")])
    inv = build_invoice(_extraction(emp), match, s)
    assert inv["line_items"] == []
    assert len(inv["exceptions"]) == 1
    assert inv["exceptions"][0]["reason"] == "unresolved"
    assert inv["amount"] == 0.0


def test_ambiguous_row_becomes_exception_with_candidates(s):
    emp = _cl001_emp(s)
    _seed_payroll(s, emp)
    match = MatchResult(
        matches=[
            RowMatch(
                row_idx=0,
                chosen_emp_id=emp.emp_id,
                ambiguous=True,
                reason="name matches two employees",
                candidates=[
                    Candidate(emp_id=emp.emp_id, full_name=emp.full_name, client_code="CL001", score=0.6),
                    Candidate(emp_id="EMP_OTHER", full_name="Other", client_code="CL001", score=0.55),
                ],
            )
        ]
    )
    inv = build_invoice(_extraction(emp), match, s)
    assert inv["line_items"] == []
    ex = inv["exceptions"][0]
    assert ex["ambiguous"] is True
    assert emp.emp_id in ex["candidates"] and "EMP_OTHER" in ex["candidates"]


def test_no_payroll_row_becomes_exception(s):
    # a real employee that has zero payroll rows anywhere → "no payroll record"
    ghost = Employee(
        emp_id=f"EMP_GHOST_{uuid.uuid4().hex[:6]}",
        full_name="Ghost NoPayroll",
        client_code="CL001",
        job_title="Contractor",
    )
    s.add(ghost)
    s.flush()
    ex = TimesheetExtraction(
        client_code="CL001",
        period=_PERIOD,
        rows=[TimesheetRow(employee_name=ghost.full_name, emp_id=ghost.emp_id, days_worked=20)],
    )
    match = MatchResult(
        matches=[RowMatch(row_idx=0, chosen_emp_id=ghost.emp_id, ambiguous=False, confidence=0.9)]
    )
    inv = build_invoice(ex, match, s)
    assert inv["line_items"] == []
    assert inv["exceptions"][0]["reason"] == "no payroll record"


# ── client inference + threshold flag ────────────────────────────────────────


def test_client_inferred_from_first_resolved_employee(s):
    emp = _cl001_emp(s)
    _seed_payroll(s, emp)
    ex = _extraction(emp)
    ex.client_code = None  # force inference from the resolved employee
    inv = build_invoice(ex, _match_resolved(emp), s)
    assert inv["client_code"] == "CL001"
    assert inv["client_name"]


def test_over_threshold_requires_finance_approval(s):
    emp = _cl001_emp(s)
    # huge gross → billable well over the 60k default threshold_aed
    _seed_payroll(s, emp, gross=70000.0, basic=70000.0, working_days=20)
    inv = build_invoice(_extraction(emp, days_worked=20), _match_resolved(emp), s)
    assert inv["amount"] >= 60000
    assert inv["requires_finance_approval"] is True
    # the threshold_approval validation is present and failed (warning severity)
    thr = next(v for v in inv["validations"] if v["rule"] == "threshold_approval")
    assert thr["passed"] is False


def test_under_threshold_does_not_require_finance_approval(s):
    emp = _cl001_emp(s)
    _seed_payroll(s, emp, gross=1000.0, basic=1000.0, working_days=20)
    inv = build_invoice(_extraction(emp, days_worked=20), _match_resolved(emp), s)
    assert inv["requires_finance_approval"] is False

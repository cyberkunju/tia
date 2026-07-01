"""Revenue-leakage sentinel + recovery invoice (finance/leakage.py, finance/recovery.py).

Uses a synthetic isolated period (rolled back) so the scan is deterministic
regardless of what other test files leave in the shared DB. Asserts the
classifier math, report aggregation, friendly messages, and the recovery
invoice's money/VAT/sequence shape.
"""

from __future__ import annotations

import uuid

import pytest

from tia_ai.db import SessionLocal
from tia_ai.finance import build_recovery_invoice, compute_revenue_leakage
from tia_ai.finance.leakage import (
    FRIENDLY_LEAKAGE_MESSAGES,
    LeakageReason,
    reasons_friendly,
)
from tia_ai.models import Employee, Payroll


_PERIOD = "LEAKTEST 2099"


@pytest.fixture()
def s():
    sess = SessionLocal()
    try:
        yield sess
    finally:
        sess.rollback()  # never persist the synthetic payroll
        sess.close()


def _two_cl001_emps(s):
    emps = s.query(Employee).filter(Employee.client_code == "CL001").limit(2).all()
    assert len(emps) == 2
    return emps


def _seed_unbilled(s, gross_values):
    emps = _two_cl001_emps(s)[: len(gross_values)]
    for emp, gross in zip(emps, gross_values, strict=True):
        s.add(
            Payroll(
                id=str(uuid.uuid4()),
                emp_id=emp.emp_id,
                employee_name=emp.full_name,
                client_code="CL001",
                period=_PERIOD,
                gross=gross,
                basic=gross,
                ot_hours=0,
                ot_amount=0,
                net_pay=gross,
                currency="AED",
                working_days=22,
            )
        )
    s.flush()
    return emps


def test_unbilled_payroll_is_full_leakage(s):
    emps = _seed_unbilled(s, [10000.0, 5000.0])
    report = compute_revenue_leakage(s, period=_PERIOD)
    assert report.period == _PERIOD
    # nobody billed this synthetic period → 2 leakage entries, expected = gross * 1.20
    emp_ids = {e.emp_id for e in emps}
    entries = [e for e in report.entries if e.emp_id in emp_ids]
    assert len(entries) == 2
    for e in entries:
        # default markup 0.20 (no markup_pct on client.settings)
        assert e.reason in (LeakageReason.NO_TIMESHEET, LeakageReason.LATE_PERIOD)
        assert e.client_code == "CL001"
    # report total == sum of entry expectations (within rounding)
    assert abs(report.total_aed - sum(e.expected_billable_aed for e in report.entries)) < 0.05


def test_report_aggregation_consistency(s):
    _seed_unbilled(s, [12000.0, 8000.0])
    report = compute_revenue_leakage(s, period=_PERIOD, client_code="CL001")
    # by_client total reconciles with the grand total
    assert len(report.by_client) == 1
    cl = report.by_client[0]
    assert cl.client_code == "CL001"
    assert abs(cl.total_aed - report.total_aed) < 0.05
    # by_reason values sum to the total
    assert abs(sum(report.by_reason.values()) - report.total_aed) < 0.05
    # associate_count matches entries length
    assert report.associate_count == len(report.entries)


def test_friendly_messages_cover_every_reason():
    for reason in LeakageReason:
        assert FRIENDLY_LEAKAGE_MESSAGES[reason]


def test_reasons_friendly_attaches_message(s):
    _seed_unbilled(s, [9000.0])
    report = compute_revenue_leakage(s, period=_PERIOD, client_code="CL001")
    enriched = reasons_friendly(report.entries)
    assert enriched and all("friendly" in e and e["friendly"] for e in enriched)


def test_empty_period_yields_zero_total(s):
    report = compute_revenue_leakage(s, period="NO-PAYROLL-EVER-9988")
    assert report.total_aed == 0.0
    assert report.entries == []
    assert report.associate_count == 0


# ── recovery invoice ─────────────────────────────────────────────────────────


def test_build_recovery_invoice_money_and_sequence(s):
    emp = _two_cl001_emps(s)[0]
    s.add(
        Payroll(
            id=str(uuid.uuid4()),
            emp_id=emp.emp_id,
            employee_name=emp.full_name,
            client_code="CL001",
            period=_PERIOD,
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
    inv = build_recovery_invoice(s, emp_id=emp.emp_id, period=_PERIOD, reason="no_timesheet")
    # contract markup 0.20, vat 0.05 (UAE) → exact decimal math
    assert inv.amount == 12000.0  # 10000 * 1.20
    assert inv.vat_amount == 600.0  # 12000 * 0.05
    assert inv.total_incl_vat == 12600.0
    assert inv.status == "generated"
    assert inv.client_code == "CL001"
    # recovery sequence carries the -R suffix so it's separable at audit time
    assert "-R" in (inv.invoice_sequence_no or "")
    assert inv.line_items and inv.line_items[0]["emp_id"] == emp.emp_id
    assert inv.line_items[0]["recovery_reason"] == "no_timesheet"


def test_build_recovery_invoice_missing_overtime_bills_ot_only(s):
    emp = _two_cl001_emps(s)[0]
    s.add(
        Payroll(
            id=str(uuid.uuid4()),
            emp_id=emp.emp_id,
            employee_name=emp.full_name,
            client_code="CL001",
            period=_PERIOD,
            gross=10000.0,
            basic=10000.0,
            ot_hours=10,
            ot_amount=500.0,
            net_pay=10500.0,
            currency="AED",
            working_days=22,
        )
    )
    s.flush()
    inv = build_recovery_invoice(s, emp_id=emp.emp_id, period=_PERIOD, reason="missing_overtime")
    # OT-only recovery: 500 * 1.20 = 600
    assert inv.amount == 600.0
    assert inv.line_items[0]["prorated"] == 0.0


def test_build_recovery_invoice_unknown_employee_raises(s):
    with pytest.raises(ValueError):
        build_recovery_invoice(s, emp_id="EMP_NOPE_000", period=_PERIOD)


def test_build_recovery_invoice_no_payroll_raises(s):
    emp = _two_cl001_emps(s)[0]
    with pytest.raises(ValueError):
        build_recovery_invoice(s, emp_id=emp.emp_id, period="PERIOD-WITH-NO-PAYROLL-7766")

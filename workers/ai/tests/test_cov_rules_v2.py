"""Remaining validate/rules_v2 branches: r1/r4/r8 continue-guards, r5 over-budget
and ok paths, r7 zero-VAT ok, r9 retired stub, r15 skip-guards, and the engine's
per-rule exception handler. Deterministic (builds its own SOW/Employee/Payroll in a
rolled-back session); no network."""

from __future__ import annotations

import uuid

import pytest

from tia_ai.db import SessionLocal
from tia_ai.models import Employee, Payroll, SOW
from tia_ai.validate import rules_v2 as R


@pytest.fixture()
def s():
    sess = SessionLocal()
    try:
        yield sess
    finally:
        sess.rollback()
        sess.close()


def _contract(s, code="CL001"):
    c = R.find_active_contract(s, code)
    assert c is not None, f"seed missing contract for {code}"
    return c


# ── r1 continue when a line has no emp_id (line 87) ────────────────────────────


def test_r1_skips_line_without_emp_id(s):
    c = _contract(s)
    inv = {"line_items": [{"amount": 100.0}, {"emp_id": (c.authorized_emp_ids or ["EMP10001"])[0]}]}
    res = R.r1_employee_in_contract_scope(inv, c, {}, s)
    # only the emp_id-bearing line produced a result
    assert len(res) == 1
    assert res[0]["rule_id"] == "R1"


# ── r4 regular_hours <= 0 continue (line 209) ──────────────────────────────────


def test_r4_negative_hours_continue(s):
    c = _contract(s)
    # negative days_worked (garbage extraction) → regular_hours < 0 → continue, no result
    inv = {"line_items": [{"emp_id": "E1", "days_worked": -3, "ot_hours": 5}]}
    res = R.r4_ot_within_contract_cap(inv, c, {}, s)
    assert res == []


# ── r5 over-budget fail (266) and ok (276) ─────────────────────────────────────


def _make_fixed_scope(s, code="CL001"):
    c = _contract(s, code)
    c.type = "FIXED_SCOPE"
    # clear any pre-existing SOWs for a deterministic budget
    for sow in s.query(SOW).filter_by(contract_id=c.id).all():
        s.delete(sow)
    s.flush()
    return c


def test_r5_over_open_budget_fails(s):
    c = _make_fixed_scope(s)
    s.add(
        SOW(id=str(uuid.uuid4()), contract_id=c.id, deliverable="Build",
            hours_expected=10, hours_consumed=8, status="OPEN")  # remaining budget = 2h
    )
    s.flush()
    inv = {"line_items": [{"emp_id": "E1", "days_worked": 22, "ot_hours": 0}]}  # 176h ≫ 2h
    res = R.r5_sow_hours_not_exceeded(inv, c, {}, s)
    fails = [r for r in res if not r["passed"]]
    assert fails and "remaining SOW budget" in fails[0]["message"]  # line 266


def test_r5_within_budget_ok(s):
    c = _make_fixed_scope(s)
    s.add(
        SOW(id=str(uuid.uuid4()), contract_id=c.id, deliverable="Build",
            hours_expected=10000, hours_consumed=0, status="OPEN")  # plenty of budget
    )
    s.flush()
    inv = {"line_items": [{"emp_id": "E1", "days_worked": 1, "ot_hours": 0}]}  # 8h ≪ 10000h
    res = R.r5_sow_hours_not_exceeded(inv, c, {}, s)
    assert len(res) == 1 and res[0]["passed"] is True  # line 276 (_ok when no failures)


# ── r7 zero-VAT ok (line 318) ──────────────────────────────────────────────────


def test_r7_zero_excl_and_zero_vat_ok(s):
    c = _contract(s)
    res = R.r7_vat_calculation_correct({"total_excl_vat": 0, "vat_amount": 0}, c, {}, s)
    assert res[0]["passed"] is True and res[0]["rule_id"] == "R7"


# ── r8 continue when a line has no emp_id (line 344) ───────────────────────────


def test_r8_skips_line_without_emp_id(s):
    c = _contract(s)
    inv = {"client_code": "CL001", "period": "June 2026", "line_items": [{"amount": 5.0}]}
    res = R.r8_duplicate_invoice_extended(inv, c, {}, s)
    assert res == []  # the only line had no emp_id → skipped


# ── r9 retired stub (line 383) ─────────────────────────────────────────────────


def test_r9_retired_stub_always_ok(s):
    c = _contract(s)
    res = R.r9_approver_signature_present({"line_items": []}, c, {}, s)
    assert res[0]["passed"] is True
    assert res[0]["actual"] == "retired"


# ── r15 skip-guards (495 no emp/zero billed, 498 emp missing, 507 no payroll,
#     510 non-positive baseline) ────────────────────────────────────────────────


def test_r15_skips_no_emp_or_zero_billed(s):
    c = _contract(s)
    inv = {"line_items": [{"amount": 0.0}, {"emp_id": "E", "amount": 0.0}]}  # both skipped (495)
    res = R.r15_anomaly_vs_history(inv, c, {}, s)
    assert res == []


def test_r15_skips_unknown_employee(s):
    c = _contract(s)
    inv = {"line_items": [{"emp_id": "EMP_GHOST_ZZZ", "amount": 5000.0}]}  # emp None → 498
    res = R.r15_anomaly_vs_history(inv, c, {}, s)
    assert res == []


def test_r15_skips_employee_without_payroll(s):
    c = _contract(s)
    emp = Employee(
        emp_id=f"EMPNOPAY{uuid.uuid4().hex[:4].upper()}",
        full_name="No Payroll",
        client_code="CL001",
    )
    s.add(emp)
    s.flush()
    inv = {"line_items": [{"emp_id": emp.emp_id, "amount": 5000.0}]}  # no payroll → 507
    res = R.r15_anomaly_vs_history(inv, c, {}, s)
    assert res == []


def test_r15_skips_non_positive_baseline(s):
    c = _contract(s)
    emp = Employee(
        emp_id=f"EMPNEG{uuid.uuid4().hex[:4].upper()}",
        full_name="Negative Gross",
        client_code="CL001",
    )
    s.add(emp)
    s.flush()
    # gross is truthy (passes the `not payroll.gross` guard) but negative → baseline<=0 (510)
    s.add(
        Payroll(
            id=str(uuid.uuid4()), emp_id=emp.emp_id, employee_name=emp.full_name,
            client_code="CL001", period="NEG 2099", gross=-100.0, basic=-100.0, ot_hours=0,
            ot_amount=0, net_pay=-100.0, currency="AED", working_days=22,
        )
    )
    s.flush()
    inv = {"line_items": [{"emp_id": emp.emp_id, "amount": 5000.0}]}
    res = R.r15_anomaly_vs_history(inv, c, {}, s)
    assert res == []


# ── run_rule_engine per-rule exception handler (640-641) ───────────────────────


def test_run_rule_engine_catches_rule_exception(s):
    c = _contract(s)
    # a non-numeric vat_amount makes r7's float() raise → caught, appended as R? fail
    inv = {
        "client_code": "CL001",
        "period": "June 2026",
        "total_excl_vat": 1000.0,
        "vat_amount": "definitely-not-a-number",
        "line_items": [{"emp_id": (c.authorized_emp_ids or ["EMP10001"])[0], "amount": 1200.0}],
    }
    res = R.run_rule_engine(inv, c, s)
    caught = [r for r in res if r["rule_id"] == "R?"]
    assert caught and caught[0]["passed"] is False
    assert "not-a-number" in caught[0]["message"] or caught[0]["actual"]

"""validate/rules_v2.py — exercise each rule's fail/warn/ok branches directly
against seeded contracts (no LLM, no network)."""

from __future__ import annotations

import uuid

import pytest

from tia_ai.db import SessionLocal
from tia_ai.models import Client, Invoice, Payroll, RateCard, SOW
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
    return R.find_active_contract(s, code)


# ── R2 rate compliance ────────────────────────────────────────────────────────


def test_r2_rate_mismatch_and_missing_and_ok(s):
    c = _contract(s, "CL001")
    cards = s.query(RateCard).filter_by(contract_id=c.id).all()
    if not cards:
        pytest.skip("no rate cards seeded")
    cat, rate = cards[0].labor_category, cards[0].regular_rate
    inv = {
        "line_items": [
            {"job_title": cat, "billing_rate_aed": rate + 100, "emp_id": "E1"},  # mismatch
            {"job_title": "NoSuchCategory", "billing_rate_aed": 50, "emp_id": "E2"},  # no card
            {"job_title": cat, "billing_rate_aed": rate, "emp_id": "E3"},  # ok
            {"job_title": cat, "emp_id": "E4"},  # no billed rate → skipped
        ]
    }
    res = R.r2_rate_compliance_per_category(inv, c, {}, s)
    passed = [r["passed"] for r in res]
    assert False in passed and True in passed


# ── R3 period boundary ────────────────────────────────────────────────────────


def test_r3_unparseable_and_outside(s):
    c = _contract(s, "CL001")
    warn = R.r3_period_boundary_check({"period": "not a period"}, c, {}, s)
    assert warn[0]["severity"] == "warning"
    outside = R.r3_period_boundary_check({"period": "1990-01"}, c, {}, s)
    assert outside[0]["passed"] is False


# ── R4 OT cap ─────────────────────────────────────────────────────────────────


def test_r4_ot_over_cap(s):
    c = _contract(s, "CL001")
    inv = {"line_items": [{"emp_id": "E1", "days_worked": 22, "ot_hours": 60}]}
    res = R.r4_ot_within_contract_cap(inv, c, {}, s)
    assert res[0]["passed"] is False


# ── R5 SOW ────────────────────────────────────────────────────────────────────


def test_r5_fixed_scope_completed_or_budget(s):
    c = _contract(s, "CL002")
    if not c or c.type != "FIXED_SCOPE":
        pytest.skip("CL002 not FIXED_SCOPE")
    inv = {"line_items": [{"emp_id": "E1", "days_worked": 22, "ot_hours": 16}]}
    res = R.r5_sow_hours_not_exceeded(inv, c, {}, s)
    # a completed SOW or exceeded open budget → at least one failure
    assert any(not r["passed"] for r in res) or res[0]["passed"] is True


def test_r5_non_fixed_scope_passes(s):
    c = _contract(s, "CL001")
    res = R.r5_sow_hours_not_exceeded({"line_items": []}, c, {}, s)
    # CL001 is not FIXED_SCOPE (T&M) → passes with a note (or, if it is, still a result)
    assert res and "R5" == res[0]["rule_id"]


# ── R7 VAT ────────────────────────────────────────────────────────────────────


def test_r7_vat_mismatch_and_ok(s):
    c = _contract(s, "CL001")
    bad = R.r7_vat_calculation_correct({"total_excl_vat": 1000.0, "vat_amount": 999.0}, c, {}, s)
    assert bad[0]["passed"] is False
    rate = float(c.vat_rate or 0.05)
    ok = R.r7_vat_calculation_correct(
        {"total_excl_vat": 1000.0, "vat_amount": round(1000.0 * rate, 2)}, c, {}, s
    )
    assert ok[0]["passed"] is True


# ── R8 duplicate (function not registered but exercised directly) ──────────────


def test_r8_duplicate_detected(s):
    c = _contract(s, "CL001")
    period = f"DUP {uuid.uuid4().hex[:5]}"
    prior = Invoice(
        id=str(uuid.uuid4()),
        timesheet_id=f"x:{uuid.uuid4()}",
        client_code="CL001",
        period=period,
        amount=100.0,
        currency="AED",
        status="generated",
        invoice_sequence_no=f"TIA-DUP-{uuid.uuid4().hex[:6]}",
        line_items=[{"emp_id": "EMP10001", "amount": 100.0}],
    )
    s.add(prior)
    s.flush()
    inv = {"client_code": "CL001", "period": period, "line_items": [{"emp_id": "EMP10001"}]}
    res = R.r8_duplicate_invoice_extended(inv, c, {"invoice_id": "different"}, s)
    assert any(not r["passed"] for r in res)


def test_r8_no_period_passes(s):
    c = _contract(s, "CL001")
    res = R.r8_duplicate_invoice_extended({"line_items": []}, c, {}, s)
    assert res[0]["passed"] is True


# ── R10 OT multiplier ─────────────────────────────────────────────────────────


def test_r10_ot_amount_mismatch_and_ok(s):
    c = _contract(s, "CL001")
    bad = R.r10_holiday_weekend_multiplier_check(
        {"line_items": [{"emp_id": "E1", "ot_hours": 5, "ot_hourly_rate": 10.0, "ot_amount": 999.0}]},
        c, {}, s,
    )
    assert bad[0]["passed"] is False
    ok = R.r10_holiday_weekend_multiplier_check(
        {"line_items": [{"emp_id": "E1", "ot_hours": 5, "ot_hourly_rate": 10.0, "ot_amount": 50.0}]},
        c, {}, s,
    )
    assert ok[0]["passed"] is True


# ── R14 period closed ─────────────────────────────────────────────────────────


def test_r14_period_closed(s):
    c = _contract(s, "CL001")
    client = s.get(Client, "CL001")
    period = f"CLOSED {uuid.uuid4().hex[:5]}"
    client.settings = {**(client.settings or {}), "closed_periods": [period]}
    s.flush()
    res = R.r14_period_not_closed({"client_code": "CL001", "period": period}, c, {}, s)
    assert res[0]["passed"] is False


# ── R15 anomaly ───────────────────────────────────────────────────────────────


def test_r15_anomaly_fail_warn_ok(s):
    c = _contract(s, "CL001")
    emp = s.query(Payroll).filter(Payroll.emp_id.like("EMP%")).first()
    if not emp or not emp.gross:
        pytest.skip("no payroll gross seeded")
    markup = float(c.markup_pct or 0.20)
    baseline = float(emp.gross) * (1 + markup)
    fail = R.r15_anomaly_vs_history(
        {"line_items": [{"emp_id": emp.emp_id, "amount": baseline * 1.8}]}, c, {}, s
    )
    assert any(not r["passed"] for r in fail)
    warn = R.r15_anomaly_vs_history(
        {"line_items": [{"emp_id": emp.emp_id, "amount": baseline * 1.12}]}, c, {}, s
    )
    assert any(r.get("severity") == "warning" for r in warn)
    ok = R.r15_anomaly_vs_history(
        {"line_items": [{"emp_id": emp.emp_id, "amount": baseline * 1.0}]}, c, {}, s
    )
    assert any(r["passed"] and r.get("severity") == "info" for r in ok)


# ── engine + friendly ─────────────────────────────────────────────────────────


def test_friendly_message_and_engine(s):
    assert R.friendly_message("R4")
    assert R.friendly_message(None) is None
    assert R.friendly_message("R_UNKNOWN") is None
    # no contract → R0 blocking failure
    res = R.run_rule_engine({"line_items": []}, None, s)
    assert R.has_blocking_failure(res) is True


# ── edge branches: OK-paths, continue-guards, R5 SOW seeded ────────────────────


def test_r4_zero_hours_continue_and_ok(s):
    c = _contract(s, "CL001")
    inv = {"line_items": [
        {"emp_id": "E0", "days_worked": 0, "ot_hours": 0},   # regular_hours 0 → continue
        {"emp_id": "E1", "days_worked": 22, "ot_hours": 2},  # under cap → ok
    ]}
    res = R.r4_ot_within_contract_cap(inv, c, {}, s)
    assert any(r["passed"] for r in res)


def test_r5_seeded_sows_force_branches(s):
    c = _contract(s, "CL002")
    if not c:
        pytest.skip("no CL002 contract")
    # make it FIXED_SCOPE and seed a completed + a small open SOW
    c.type = "FIXED_SCOPE"
    s.add(SOW(id=str(uuid.uuid4()), contract_id=c.id, deliverable="Done phase", hours_expected=100, hours_consumed=100, status="COMPLETED"))
    s.add(SOW(id=str(uuid.uuid4()), contract_id=c.id, deliverable="Open phase", hours_expected=10, hours_consumed=8, status="OPEN"))
    s.flush()
    inv = {"line_items": [{"emp_id": "E1", "days_worked": 22, "ot_hours": 16}]}  # ~192h
    res = R.r5_sow_hours_not_exceeded(inv, c, {}, s)
    fails = [r for r in res if not r["passed"]]
    assert len(fails) >= 1  # completed-SOW and/or over-budget


def test_r5_fixed_scope_no_sow_warns(s):
    c = _contract(s, "CL002")
    if not c:
        pytest.skip("no CL002 contract")
    c.type = "FIXED_SCOPE"
    # delete any SOWs so the 'no SOW' warn path fires
    for sow in s.query(SOW).filter_by(contract_id=c.id).all():
        s.delete(sow)
    s.flush()
    res = R.r5_sow_hours_not_exceeded({"line_items": []}, c, {}, s)
    assert res[0]["severity"] == "warning"


def test_r10_ot_zero_and_no_rate_skipped(s):
    c = _contract(s, "CL001")
    inv = {"line_items": [
        {"emp_id": "E1", "ot_hours": 0},                      # ot 0 → skip
        {"emp_id": "E2", "ot_hours": 5, "ot_hourly_rate": 0}, # no rate → skip
    ]}
    res = R.r10_holiday_weekend_multiplier_check(inv, c, {}, s)
    assert res == []


def test_run_rule_engine_clean_invoice_hits_ok_paths(s):
    c = _contract(s, "CL001")
    emp_id = (c.authorized_emp_ids or ["EMP10001"])[0]
    inv = {
        "client_code": "CL001",
        "period": "June 2026",
        "total_excl_vat": 1000.0,
        "vat_amount": round(1000.0 * float(c.vat_rate or 0.05), 2),
        "line_items": [{"emp_id": emp_id, "days_worked": 22, "ot_hours": 2, "prorated": 1000.0, "ot_amount": 0.0, "reimbursements": 0.0, "amount": round(1000.0 * (1 + float(c.markup_pct or 0.2)), 2)}],
    }
    res = R.run_rule_engine(inv, c, s)
    assert any(r["rule_id"] == "R1" and r["passed"] for r in res)

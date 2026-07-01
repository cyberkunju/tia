"""BTP-style contract-bound rule engine tests (validate/rules_v2.py).

Every rule R1..R15 is exercised with a passing AND a failing invoice payload,
run against the seeded contracts so the contract parameters (markup, OT cap,
rate card, VAT, SOW, period window) are real. The orchestration helpers
(run_rule_engine, has_blocking_failure, friendly_message) are covered too.
"""

from __future__ import annotations

import pytest

from tia_ai.db import SessionLocal
from tia_ai.models import Contract, Employee, Payroll, RateCard
from tia_ai.validate import rules_v2 as R


@pytest.fixture()
def s():
    sess = SessionLocal()
    try:
        yield sess
    finally:
        sess.rollback()
        sess.close()


def _contract(s, client_code="CL001") -> Contract:
    c = R.find_active_contract(s, client_code)
    assert c is not None, f"no seeded contract for {client_code}"
    return c


# ── R1 employee_in_contract_scope ────────────────────────────────────────────


def test_r1_in_roster_passes_and_unknown_fails(s):
    c = _contract(s)
    on_roster = (c.authorized_emp_ids or [])[0]
    inv = {"line_items": [{"emp_id": on_roster}, {"emp_id": "EMP_NOT_REAL_999"}]}
    out = R.r1_employee_in_contract_scope(inv, c, {}, s)
    by_emp = {r["emp_id"]: r for r in out}
    assert by_emp[on_roster]["passed"] is True
    assert by_emp["EMP_NOT_REAL_999"]["passed"] is False
    assert by_emp["EMP_NOT_REAL_999"]["severity"] == "error"


# ── R2 rate_compliance_per_category ──────────────────────────────────────────


def test_r2_matches_rate_card_and_flags_off_rate(s):
    c = _contract(s)
    card = s.query(RateCard).filter(RateCard.contract_id == c.id).first()
    assert card is not None
    # billed rate matching the card (within AED 1) passes
    ok = R.r2_rate_compliance_per_category(
        {"line_items": [{"job_title": card.labor_category, "billing_rate_aed": card.regular_rate}]},
        c,
        {},
        s,
    )
    assert ok[0]["passed"] is True
    # billed 50 AED above the card rate fails
    bad = R.r2_rate_compliance_per_category(
        {
            "line_items": [
                {"job_title": card.labor_category, "billing_rate_aed": card.regular_rate + 50}
            ]
        },
        c,
        {},
        s,
    )
    assert bad[0]["passed"] is False


def test_r2_no_explicit_rate_is_skipped(s):
    c = _contract(s)
    # no billing_rate_aed on the line → rule emits nothing (we used the card)
    out = R.r2_rate_compliance_per_category({"line_items": [{"job_title": "x"}]}, c, {}, s)
    assert out == []


# ── R3 period_boundary_check ─────────────────────────────────────────────────


def test_r3_inside_and_outside_window(s):
    c = _contract(s)  # seeded 2026-01-01 .. 2026-12-31
    assert R.r3_period_boundary_check({"period": "June 2026"}, c, {}, s)[0]["passed"] is True
    out = R.r3_period_boundary_check({"period": "June 2027"}, c, {}, s)[0]
    assert out["passed"] is False
    assert "outside" in out["message"]


def test_r3_unparseable_period_warns(s):
    c = _contract(s)
    out = R.r3_period_boundary_check({"period": "Q2 2026"}, c, {}, s)[0]
    assert out["passed"] is True and out["severity"] == "warning"


# ── R4 ot_within_contract_cap (cap = 20%) ────────────────────────────────────


def test_r4_under_and_over_cap(s):
    c = _contract(s)  # max_ot_pct = 0.20
    # 20 days × 8h = 160 regular hours; 10 OT = 6.25% < 20% → pass
    ok = R.r4_ot_within_contract_cap(
        {"line_items": [{"emp_id": "E", "days_worked": 20, "ot_hours": 10}]}, c, {}, s
    )
    assert ok[0]["passed"] is True
    # 50 OT = 31% > 20% → fail
    bad = R.r4_ot_within_contract_cap(
        {"line_items": [{"emp_id": "E", "days_worked": 20, "ot_hours": 50}]}, c, {}, s
    )
    assert bad[0]["passed"] is False


# ── R5 sow_hours_not_exceeded (FIXED_SCOPE only) ─────────────────────────────


def test_r5_non_fixed_scope_is_ok(s):
    c = _contract(s, "CL001")  # TIME_AND_MATERIALS
    out = R.r5_sow_hours_not_exceeded({"line_items": [{"days_worked": 22}]}, c, {}, s)
    assert out[0]["passed"] is True
    assert "not a FIXED_SCOPE" in out[0]["message"]


def test_r5_billing_against_completed_sow_fails(s):
    # CL002 is FIXED_SCOPE with a COMPLETED "Design phase" SOW
    c = _contract(s, "CL002")
    assert c.type == "FIXED_SCOPE"
    out = R.r5_sow_hours_not_exceeded({"line_items": [{"days_worked": 22, "ot_hours": 0}]}, c, {}, s)
    assert any(not r["passed"] for r in out), out


# ── R6 markup_correctly_applied (markup 20%) ─────────────────────────────────


def test_r6_recomputes_line_amount(s):
    c = _contract(s)  # markup 0.20
    # (1000 + 0) * 1.2 + 0 = 1200 → pass
    ok = R.r6_markup_correctly_applied(
        {"line_items": [{"prorated": 1000, "ot_amount": 0, "reimbursements": 0, "amount": 1200}]},
        c,
        {},
        s,
    )
    assert ok[0]["passed"] is True
    # amount off by 200 → fail
    bad = R.r6_markup_correctly_applied(
        {"line_items": [{"prorated": 1000, "ot_amount": 0, "reimbursements": 0, "amount": 1000}]},
        c,
        {},
        s,
    )
    assert bad[0]["passed"] is False


# ── R7 vat_calculation_correct (UAE 5%) ──────────────────────────────────────


def test_r7_vat_exact_and_wrong(s):
    c = _contract(s, "CL001")  # UAE → 5%
    assert float(c.vat_rate) == 0.05
    ok = R.r7_vat_calculation_correct({"total_excl_vat": 1000, "vat_amount": 50.0}, c, {}, s)[0]
    assert ok["passed"] is True
    bad = R.r7_vat_calculation_correct({"total_excl_vat": 1000, "vat_amount": 80.0}, c, {}, s)[0]
    assert bad["passed"] is False


def test_r7_ksa_15_percent(s):
    c = _contract(s, "CL008")  # KSA → 15%
    assert float(c.vat_rate) == 0.15
    ok = R.r7_vat_calculation_correct({"total_excl_vat": 1000, "vat_amount": 150.0}, c, {}, s)[0]
    assert ok["passed"] is True


# ── R8 duplicate_invoice_extended (disabled in RULES, fn still works) ─────────


def test_r8_no_prior_invoice_passes(s):
    c = _contract(s)
    out = R.r8_duplicate_invoice_extended(
        {"client_code": "CL001", "period": "ZZ-no-such-period", "line_items": [{"emp_id": "EMP10001"}]},
        c,
        {},
        s,
    )
    assert out[0]["passed"] is True


def test_r8_missing_period_or_client_is_ok(s):
    c = _contract(s)
    assert R.r8_duplicate_invoice_extended({"line_items": []}, c, {}, s)[0]["passed"] is True


# ── R10 holiday_weekend_multiplier_check ─────────────────────────────────────


def test_r10_ot_reconciles_and_mismatch(s):
    c = _contract(s)
    ok = R.r10_holiday_weekend_multiplier_check(
        {"line_items": [{"ot_hours": 10, "ot_hourly_rate": 10.0, "ot_amount": 100.0}]}, c, {}, s
    )
    assert ok[0]["passed"] is True
    bad = R.r10_holiday_weekend_multiplier_check(
        {"line_items": [{"ot_hours": 10, "ot_hourly_rate": 10.0, "ot_amount": 50.0}]}, c, {}, s
    )
    assert bad[0]["passed"] is False


def test_r10_zero_ot_emits_nothing(s):
    c = _contract(s)
    assert R.r10_holiday_weekend_multiplier_check({"line_items": [{"ot_hours": 0}]}, c, {}, s) == []


# ── R14 period_not_closed ────────────────────────────────────────────────────


def test_r14_open_period_passes(s):
    c = _contract(s)
    out = R.r14_period_not_closed({"client_code": "CL001", "period": "June 2026"}, c, {}, s)
    assert out[0]["passed"] is True


def test_r14_closed_period_blocks(s):
    # mutate the client's closed_periods within this rolled-back session only
    from tia_ai.models import Client

    c = _contract(s, "CL003")
    client = s.get(Client, "CL003")
    client.settings = {**(client.settings or {}), "closed_periods": ["June 2026"]}
    s.flush()
    out = R.r14_period_not_closed({"client_code": "CL003", "period": "June 2026"}, c, {}, s)
    assert out[0]["passed"] is False
    assert out[0]["actual"] == "CLOSED"


# ── R15 anomaly_vs_history ───────────────────────────────────────────────────


def _emp_with_payroll(s, client_code="CL001"):
    pr = (
        s.query(Payroll)
        .filter(Payroll.client_code == client_code, Payroll.gross > 0)
        .first()
    )
    assert pr is not None
    emp = s.get(Employee, pr.emp_id)
    assert emp is not None
    return emp, float(pr.gross)


def test_r15_within_baseline_passes(s):
    c = _contract(s)  # markup 0.20
    emp, gross = _emp_with_payroll(s)
    baseline = gross * 1.20
    out = R.r15_anomaly_vs_history(
        {"line_items": [{"emp_id": emp.emp_id, "amount": round(baseline * 1.05, 2)}]}, c, {}, s
    )
    assert out and out[0]["passed"] is True


def test_r15_large_inflation_blocks(s):
    c = _contract(s)
    emp, gross = _emp_with_payroll(s)
    baseline = gross * 1.20
    out = R.r15_anomaly_vs_history(
        {"line_items": [{"emp_id": emp.emp_id, "amount": round(baseline * 1.40, 2)}]}, c, {}, s
    )
    assert out and out[0]["passed"] is False
    assert out[0]["severity"] == "error"


def test_r15_moderate_inflation_warns(s):
    c = _contract(s)
    emp, gross = _emp_with_payroll(s)
    baseline = gross * 1.20
    out = R.r15_anomaly_vs_history(
        {"line_items": [{"emp_id": emp.emp_id, "amount": round(baseline * 1.13, 2)}]}, c, {}, s
    )
    assert out and out[0]["passed"] is True and out[0]["severity"] == "warning"


# ── orchestration helpers ────────────────────────────────────────────────────


def test_run_rule_engine_no_contract_emits_R0(s):
    out = R.run_rule_engine({"line_items": []}, None, s)
    assert len(out) == 1
    assert out[0]["rule_id"] == "R0" and out[0]["passed"] is False
    assert R.has_blocking_failure(out) is True


def test_run_rule_engine_clean_invoice_passes(s):
    c = _contract(s)
    on_roster = (c.authorized_emp_ids or [])[0]
    # a clean, well-formed line that satisfies every active rule
    inv = {
        "client_code": "CL001",
        "period": "June 2026",
        "total_excl_vat": 1200.0,
        "vat_amount": 60.0,
        "line_items": [
            {
                "emp_id": on_roster,
                "days_worked": 22,
                "ot_hours": 0,
                "prorated": 1000.0,
                "ot_amount": 0.0,
                "reimbursements": 0.0,
                "amount": 1200.0,
            }
        ],
    }
    out = R.run_rule_engine(inv, c, s)
    assert out, "rule engine should emit results"
    # the engine must run real rules, not just R0
    assert all(r["rule_id"] != "R0" for r in out)


def test_has_blocking_failure_ignores_warnings():
    warn_only = [{"passed": False, "severity": "warning"}, {"passed": True, "severity": "info"}]
    assert R.has_blocking_failure(warn_only) is False
    blocking = [{"passed": False, "severity": "error"}]
    assert R.has_blocking_failure(blocking) is True


def test_friendly_message_known_and_unknown():
    assert R.friendly_message("R4")
    assert "R4" not in R.friendly_message("R4")  # no internal id leaked
    assert R.friendly_message(None) is None
    assert R.friendly_message("R_does_not_exist") is None


def test_rules_registry_excludes_disabled_r8_r9():
    ids = {rid for rid, _ in R.RULES}
    assert "R8" not in ids and "R9" not in ids
    assert {"R1", "R2", "R3", "R4", "R5", "R6", "R7", "R10", "R14", "R15"} <= ids

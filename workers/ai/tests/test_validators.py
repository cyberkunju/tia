"""Validator tests — math reconciler, bounds, attendance, threshold approval.

These deterministic checks are the safety net that catches errors in ANY
extraction path — Excel, email, GLM-OCR — so they're the no-wrapper spine.
"""

from __future__ import annotations

from types import SimpleNamespace

from tia_ai.validate.rules import (
    check_attendance,
    check_currency,
    check_gross,
    check_net,
    check_threshold,
    check_working_days,
    validate_payroll,
)


def _payroll(**kw):
    base = dict(
        basic=7000,
        housing=1750,
        transport=500,
        food=300,
        phone=200,
        gross=9750,
        ot_hours=2,
        ot_amount=84.13,
        deductions=0,
        net_pay=9834.13,
        currency="AED",
        working_days=24,
    )
    base.update(kw)
    return SimpleNamespace(**base)


def test_gross_matches_components():
    assert check_gross(_payroll()).passed


def test_gross_mismatch_caught():
    bad = _payroll(gross=9000)  # parts sum to 9750
    r = check_gross(bad)
    assert not r.passed
    assert "9750" in r.message  # surfaces the actual sum


def test_net_formula():
    assert check_net(_payroll()).passed
    bad = _payroll(net_pay=10000)
    assert not check_net(bad).passed


def test_working_days_bounds():
    assert check_working_days(_payroll(working_days=22)).passed
    assert check_working_days(_payroll(working_days=20)).passed
    assert check_working_days(_payroll(working_days=26)).passed
    assert not check_working_days(_payroll(working_days=19)).passed
    assert not check_working_days(_payroll(working_days=31)).passed


def test_currency_aed_only():
    assert check_currency(_payroll(currency="AED")).passed
    assert check_currency(_payroll(currency="aed")).passed
    assert not check_currency(_payroll(currency="USD")).passed


def test_attendance_bounds():
    p = _payroll(working_days=24)
    assert check_attendance(20, p).passed
    assert check_attendance(24, p).passed
    assert check_attendance(25, p).passed  # +1 grace
    assert not check_attendance(40, p).passed
    # None means "not reported" — treated as soft warning, passes
    assert check_attendance(None, p).passed


def test_threshold_approval():
    # below threshold passes
    assert check_threshold(50_000, 60_000).passed
    # at or above triggers warning (not error)
    r = check_threshold(60_000, 60_000)
    assert not r.passed
    assert r.severity == "warning"


def test_validate_payroll_full():
    rs = validate_payroll(_payroll())
    assert all(r.passed for r in rs)
    assert len(rs) == 4  # gross, net, working_days, currency


def test_full_validator_catches_compound_failure():
    """One payload that violates 3 rules at once — every rule must surface its
    own error independently so the operator sees the full list, not just the first."""
    bad = _payroll(gross=9000, currency="USD", working_days=30)
    results = validate_payroll(bad)
    failed = {r.rule for r in results if not r.passed}
    assert "math_gross" in failed
    assert "currency_aed" in failed
    assert "working_days_bounds" in failed
    # net check also fails because gross is bogus
    assert "math_net" in failed

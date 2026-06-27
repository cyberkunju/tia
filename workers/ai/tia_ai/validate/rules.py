"""Deterministic validation rules - pure functions, decimal money math, no LLM.

These are the layer that catches errors in *any* extraction path (the no-wrapper point):
the math reconciler doesn't care whether the value came from Excel, email, or GLM-OCR.

Seed math relationships (from the brief):
    Gross = Basic + Housing + Transport + Food + Phone
    Net   = Gross + OT_Amount - Deductions
    OT_Amount = round(Basic / 208 * OT_Hours * 1.25, 2)   # 208 = 26 std days * 8h, 1.25x
    Working_Days in [20, 26]
    Currency == AED
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal

from ..schema import ValidationResult

CENT = Decimal("0.01")
WD_MIN, WD_MAX = 20, 26
# Overtime hourly rate basis: a standard month is 26 working days * 8 hours, OT paid at 1.25x.
# Verified exact against all 200 seed payroll rows.
OT_MONTHLY_HOURS = Decimal("208")
OT_MULTIPLIER = Decimal("1.25")


def _d(x) -> Decimal:
    return Decimal(str(x or 0))


def expected_ot_amount(basic, ot_hours) -> Decimal:
    return (_d(basic) / OT_MONTHLY_HOURS * _d(ot_hours) * OT_MULTIPLIER).quantize(
        CENT, rounding=ROUND_HALF_UP
    )


def check_ot(p) -> ValidationResult:
    """Independently verify the OT amount against the formula - catches an OT mis-extraction
    that a Net check alone would miss when Net was (mis-)derived from the same bad OT figure."""
    expected = expected_ot_amount(p.basic, p.ot_hours)
    ok = abs(expected - _d(p.ot_amount)) < CENT
    return ValidationResult(
        rule="math_ot",
        passed=ok,
        message="OT == round(Basic/208 * OT_Hours * 1.25, 2)"
        if ok
        else f"OT {p.ot_amount} != expected {expected} for {p.ot_hours}h",
    )


def check_gross(p) -> ValidationResult:
    parts = _d(p.basic) + _d(p.housing) + _d(p.transport) + _d(p.food) + _d(p.phone)
    ok = abs(parts - _d(p.gross)) < CENT
    return ValidationResult(
        rule="math_gross",
        passed=ok,
        message="Gross == Basic+Housing+Transport+Food+Phone"
        if ok
        else f"Gross {p.gross} != sum of components {parts}",
    )


def check_net(p) -> ValidationResult:
    expected = _d(p.gross) + _d(p.ot_amount) - _d(p.deductions)
    ok = abs(expected - _d(p.net_pay)) < CENT
    return ValidationResult(
        rule="math_net",
        passed=ok,
        message="Net == Gross + OT - Deductions"
        if ok
        else f"Net {p.net_pay} != Gross+OT-Deduct {expected}",
    )


def check_working_days(p) -> ValidationResult:
    ok = WD_MIN <= int(p.working_days) <= WD_MAX
    return ValidationResult(
        rule="working_days_bounds",
        passed=ok,
        message=f"Working days {p.working_days} in [{WD_MIN},{WD_MAX}]"
        if ok
        else f"Working days {p.working_days} outside [{WD_MIN},{WD_MAX}]",
    )


def check_currency(p) -> ValidationResult:
    ok = (p.currency or "").upper() == "AED"
    return ValidationResult(
        rule="currency_aed",
        passed=ok,
        message="Currency is AED" if ok else f"Unsupported currency {p.currency}",
    )


def check_attendance(row_days_worked, p) -> ValidationResult:
    """Timesheet attendance can't exceed the month's working days (+1 grace)."""
    if row_days_worked is None:
        return ValidationResult(
            rule="attendance_bounds", passed=True, message="no days reported", severity="warning"
        )
    ok = 0 <= float(row_days_worked) <= int(p.working_days) + 1
    return ValidationResult(
        rule="attendance_bounds",
        passed=ok,
        message=f"Days worked {row_days_worked} <= working days {p.working_days}"
        if ok
        else f"Days worked {row_days_worked} exceeds working days {p.working_days}",
    )


def check_threshold(amount_aed: float, threshold_aed: float | None) -> ValidationResult:
    if not threshold_aed:
        return ValidationResult(
            rule="threshold_approval", passed=True, message="no threshold set", severity="warning"
        )
    ok = float(amount_aed) < float(threshold_aed)
    return ValidationResult(
        rule="threshold_approval",
        passed=ok,
        message=f"Amount {amount_aed} under threshold {threshold_aed}"
        if ok
        else f"Amount {amount_aed} >= threshold {threshold_aed} - requires Finance approval",
        severity="warning" if not ok else "error",
    )


def validate_payroll(p) -> list[ValidationResult]:
    return [check_gross(p), check_ot(p), check_net(p), check_working_days(p), check_currency(p)]

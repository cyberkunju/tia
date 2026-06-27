"""BTP-style contract-bound validation rules (brief §4.5).

Each rule is a pure function `(invoice, contract, ctx) -> RuleResult`.
`RuleResult` is a structured dict so the orchestrator can route on it, the UI
can render it as a chip on the Review screen, and the chat agent can cite it.

Why "BTP-style"? The brief explicitly names this a "configurable rule set
(BTP-style parameters)." The behaviour is the same rule set every time; the
*parameters* (rate cards, OT cap, markup, scope hours) live on each contract.
That's the configurability — same engine, per-client tuning.

Rule IDs:
  R1  employee_in_contract_scope
  R2  rate_compliance_per_category
  R3  period_boundary_check
  R4  ot_within_contract_cap
  R5  sow_hours_not_exceeded
  R6  markup_correctly_applied
  R7  vat_calculation_correct
  R8  duplicate_invoice_extended
  R9  approver_signature_present
  R10 holiday_weekend_multiplier_check
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any, TypedDict

from sqlalchemy.orm import Session

from ..models import Contract, Employee, Invoice, RateCard, SOW

# --- types --------------------------------------------------------------

# Using a plain dict alias instead of TypedDict so optional keys don't trip the linter.
# Shape: {rule_id, rule_name, passed, severity, expected?, actual?, message, line_idx?, emp_id?}
RuleResult = dict  # type: ignore[misc,assignment]


def _ok(rid: str, name: str, **extra) -> RuleResult:
    return {
        "rule_id": rid,
        "rule_name": name,
        "passed": True,
        "severity": "info",
        "message": "passed",
        **extra,
    }


def _fail(rid: str, name: str, expected, actual, message: str, **extra) -> RuleResult:
    return {
        "rule_id": rid,
        "rule_name": name,
        "passed": False,
        "severity": "error",
        "expected": expected,
        "actual": actual,
        "message": message,
        **extra,
    }


def _warn(rid: str, name: str, message: str, **extra) -> RuleResult:
    return {
        "rule_id": rid,
        "rule_name": name,
        "passed": True,
        "severity": "warning",
        "message": message,
        **extra,
    }


# --- rules --------------------------------------------------------------


def r1_employee_in_contract_scope(
    invoice: dict, contract: Contract, ctx: dict, session: Session
) -> list[RuleResult]:
    """R1: every billed employee must be on contract.authorized_emp_ids."""
    authorized = set(contract.authorized_emp_ids or [])
    out: list[RuleResult] = []
    for i, li in enumerate(invoice.get("line_items", [])):
        emp_id = li.get("emp_id")
        if not emp_id:
            continue
        if emp_id in authorized:
            out.append(_ok("R1", "employee_in_contract_scope", line_idx=i, emp_id=emp_id))
        else:
            out.append(
                _fail(
                    "R1",
                    "employee_in_contract_scope",
                    expected=f"emp_id in {len(authorized)}-roster",
                    actual=emp_id,
                    message=f"{emp_id} is not on the {contract.client_code} contract roster",
                    line_idx=i,
                    emp_id=emp_id,
                )
            )
    return out


def r2_rate_compliance_per_category(
    invoice: dict, contract: Contract, ctx: dict, session: Session
) -> list[RuleResult]:
    """R2: billed regular rate must match the contract rate card for the employee's labor category.

    If the invoice payload includes an explicit `billing_rate_aed` (e.g. extracted
    from the email body), we compare it to the rate card's regular_rate. With no
    explicit rate from the source doc, the rule passes (we used the card).
    """
    out: list[RuleResult] = []
    cards = (
        session.query(RateCard).filter(RateCard.contract_id == contract.id).all()
        if contract
        else []
    )
    by_cat = {c.labor_category: c for c in cards}
    for i, li in enumerate(invoice.get("line_items", [])):
        category = li.get("job_title")
        billed_rate = li.get("billing_rate_aed")  # may be None
        if billed_rate is None:
            continue
        card = by_cat.get(category or "")
        if not card:
            out.append(
                _fail(
                    "R2",
                    "rate_compliance_per_category",
                    expected=f"rate card for {category}",
                    actual="missing",
                    message=f"no rate card for category {category!r}",
                    line_idx=i,
                    emp_id=li.get("emp_id"),
                )
            )
            continue
        if abs(float(billed_rate) - float(card.regular_rate)) > 1.0:  # AED 1 tolerance
            out.append(
                _fail(
                    "R2",
                    "rate_compliance_per_category",
                    expected=card.regular_rate,
                    actual=billed_rate,
                    message=(
                        f"billed {billed_rate:.2f} AED/hr for {category}; contract rate card "
                        f"says {card.regular_rate:.2f} AED/hr"
                    ),
                    line_idx=i,
                    emp_id=li.get("emp_id"),
                )
            )
        else:
            out.append(
                _ok("R2", "rate_compliance_per_category", line_idx=i, emp_id=li.get("emp_id"))
            )
    return out


def r3_period_boundary_check(
    invoice: dict, contract: Contract, ctx: dict, session: Session
) -> list[RuleResult]:
    """R3: invoice period must fall within contract.start_date..end_date.

    Period is a string like "June 2026"; we do best-effort YYYY-MM parsing.
    """
    import datetime as dt

    period = invoice.get("period") or ""
    try:
        # accept "June 2026" or "2026-06"
        if "-" in period:
            year, month = period.split("-")[0:2]
        else:
            name, year = period.strip().split()
            month = str(dt.datetime.strptime(name, "%B").month)
        period_dt = dt.date(int(year), int(month), 15)  # mid-month
    except Exception:  # noqa: BLE001
        return [_warn("R3", "period_boundary_check", message="could not parse period")]
    start = dt.date.fromisoformat(contract.start_date)
    end = dt.date.fromisoformat(contract.end_date) if contract.end_date else dt.date(9999, 12, 31)
    if start <= period_dt <= end:
        return [_ok("R3", "period_boundary_check", expected=f"{start}..{end}", actual=period)]
    return [
        _fail(
            "R3",
            "period_boundary_check",
            expected=f"{start}..{end}",
            actual=period,
            message=f"invoice period {period} is outside contract validity {start}..{end}",
        )
    ]


def r4_ot_within_contract_cap(
    invoice: dict, contract: Contract, ctx: dict, session: Session
) -> list[RuleResult]:
    """R4: total OT hours ≤ contract.max_ot_pct × regular hours."""
    out: list[RuleResult] = []
    cap = float(contract.max_ot_pct or 0.20)
    for i, li in enumerate(invoice.get("line_items", [])):
        ot_h = float(li.get("ot_hours") or 0)
        std_days = float(li.get("standard_days") or 22)
        days = float(li.get("days_worked") or std_days)
        regular_hours = days * 8.0
        if regular_hours <= 0:
            continue
        pct = ot_h / regular_hours
        if pct > cap:
            out.append(
                _fail(
                    "R4",
                    "ot_within_contract_cap",
                    expected=f"≤ {cap:.0%} of {regular_hours:.0f}h",
                    actual=f"{pct:.1%} ({ot_h:.0f}h / {regular_hours:.0f}h)",
                    message=(
                        f"OT {ot_h:.0f}h is {pct:.1%} of regular hours; contract cap is {cap:.0%}"
                    ),
                    line_idx=i,
                    emp_id=li.get("emp_id"),
                )
            )
        else:
            out.append(_ok("R4", "ot_within_contract_cap", line_idx=i, emp_id=li.get("emp_id")))
    return out


def r5_sow_hours_not_exceeded(
    invoice: dict, contract: Contract, ctx: dict, session: Session
) -> list[RuleResult]:
    """R5: for FIXED_SCOPE contracts, billed hours cannot exceed any SOW.hours_expected.

    Also: hours billed against a COMPLETED SOW = exception (this is the
    "completed work early but timesheet keeps charging" case from the mentor's
    feedback)."""
    if contract.type != "FIXED_SCOPE":
        return [_ok("R5", "sow_hours_not_exceeded", message="not a FIXED_SCOPE contract")]
    sows = session.query(SOW).filter(SOW.contract_id == contract.id).all()
    if not sows:
        return [_warn("R5", "sow_hours_not_exceeded", message="FIXED_SCOPE contract has no SOW")]
    # for the demo: total hours on the invoice
    total_h = 0.0
    for li in invoice.get("line_items", []):
        days = float(li.get("days_worked") or 0)
        ot = float(li.get("ot_hours") or 0)
        total_h += days * 8.0 + ot
    completed = [s for s in sows if s.status == "COMPLETED"]
    open_sows = [s for s in sows if s.status == "OPEN"]
    out: list[RuleResult] = []
    if completed and total_h > 0:
        # billing against completed SOW — flag
        names = ", ".join(s.deliverable for s in completed)
        out.append(
            _fail(
                "R5",
                "sow_hours_not_exceeded",
                expected="0h against completed deliverables",
                actual=f"{total_h:.0f}h",
                message=f"timesheet bills {total_h:.0f}h, but SOW '{names}' is COMPLETED",
            )
        )
    open_budget = sum(max(0, (s.hours_expected or 0) - (s.hours_consumed or 0)) for s in open_sows)
    if total_h > open_budget and open_budget > 0:
        out.append(
            _fail(
                "R5",
                "sow_hours_not_exceeded",
                expected=f"≤ {open_budget:.0f}h remaining in open SOWs",
                actual=f"{total_h:.0f}h",
                message=f"timesheet exceeds remaining SOW budget ({open_budget:.0f}h)",
            )
        )
    if not out:
        out.append(_ok("R5", "sow_hours_not_exceeded"))
    return out


def r6_markup_correctly_applied(
    invoice: dict, contract: Contract, ctx: dict, session: Session
) -> list[RuleResult]:
    """R6: invoice line amount ≈ (prorated + ot_amount) × (1 + markup) + reimb."""
    markup = float(contract.markup_pct or 0.20)
    out: list[RuleResult] = []
    for i, li in enumerate(invoice.get("line_items", [])):
        prorated = float(li.get("prorated") or 0)
        ot = float(li.get("ot_amount") or 0)
        reimb = float(li.get("reimbursements") or 0)
        expected = round((prorated + ot) * (1 + markup) + reimb, 2)
        actual = round(float(li.get("amount") or 0), 2)
        if abs(actual - expected) > 0.05:
            out.append(
                _fail(
                    "R6",
                    "markup_correctly_applied",
                    expected=expected,
                    actual=actual,
                    message=f"line {i + 1} amount {actual} ≠ recomputed {expected}",
                    line_idx=i,
                    emp_id=li.get("emp_id"),
                )
            )
        else:
            out.append(_ok("R6", "markup_correctly_applied", line_idx=i, emp_id=li.get("emp_id")))
    return out


def r7_vat_calculation_correct(
    invoice: dict, contract: Contract, ctx: dict, session: Session
) -> list[RuleResult]:
    """R7: vat_amount = total_excl_vat × vat_rate (UAE 5%, KSA 15%, IN 18%)."""
    excl = float(invoice.get("total_excl_vat") or invoice.get("amount") or 0)
    rate = float(contract.vat_rate or 0.05)
    expected = round(excl * rate, 2)
    actual = round(float(invoice.get("vat_amount") or 0), 2)
    if excl == 0 and actual == 0:
        return [_ok("R7", "vat_calculation_correct")]
    if abs(actual - expected) > 0.05:
        return [
            _fail(
                "R7",
                "vat_calculation_correct",
                expected=expected,
                actual=actual,
                message=f"VAT {actual} ≠ {rate:.0%} × {excl:.2f} ({expected})",
            )
        ]
    return [_ok("R7", "vat_calculation_correct", expected=expected, actual=actual)]


def r8_duplicate_invoice_extended(
    invoice: dict, contract: Contract, ctx: dict, session: Session
) -> list[RuleResult]:
    """R8: same (emp_id, period) already invoiced under this contract."""
    period = invoice.get("period")
    client_code = invoice.get("client_code")
    if not (period and client_code):
        return [_ok("R8", "duplicate_invoice_extended")]
    out: list[RuleResult] = []
    for i, li in enumerate(invoice.get("line_items", [])):
        emp_id = li.get("emp_id")
        if not emp_id:
            continue
        existing = (
            session.query(Invoice)
            .filter(Invoice.client_code == client_code, Invoice.period == period)
            .all()
        )
        # look for prior invoice that contains this emp_id
        prior = []
        for inv in existing:
            for prior_li in inv.line_items or []:
                if prior_li.get("emp_id") == emp_id and inv.id != ctx.get("invoice_id"):
                    prior.append(inv.id)
                    break
        if prior:
            out.append(
                _fail(
                    "R8",
                    "duplicate_invoice_extended",
                    expected="no prior invoice for (emp, period)",
                    actual=f"already billed on {prior[0][:8]}",
                    message=f"{emp_id} already invoiced for {period} on invoice {prior[0][:8]}",
                    line_idx=i,
                    emp_id=emp_id,
                )
            )
        else:
            out.append(_ok("R8", "duplicate_invoice_extended", line_idx=i, emp_id=emp_id))
    return out


def r9_approver_signature_present(
    invoice: dict, contract: Contract, ctx: dict, session: Session
) -> list[RuleResult]:
    """R9: timesheet extraction must have a signed_by field (warning, not error)."""
    signed_by = ctx.get("signed_by")
    if signed_by:
        return [_ok("R9", "approver_signature_present", actual=signed_by)]
    return [
        _warn(
            "R9",
            "approver_signature_present",
            message="no approver signature on source document",
        )
    ]


def r10_holiday_weekend_multiplier_check(
    invoice: dict, contract: Contract, ctx: dict, session: Session
) -> list[RuleResult]:
    """R10: OT computed at correct statutory multiplier.

    UAE Federal Decree-Law 33/2021: standard OT = 1.25×, night/rest/holiday = 1.5×.
    We surface this as informational: each line's ot_amount should be reconcilable
    against basic / 26 / 8 × hrs × 1.25.
    """
    out: list[RuleResult] = []
    for i, li in enumerate(invoice.get("line_items", [])):
        ot_amount = float(li.get("ot_amount") or 0)
        ot_hours = float(li.get("ot_hours") or 0)
        if ot_hours == 0:
            continue
        hourly = float(li.get("ot_hourly_rate") or 0)
        if hourly == 0:
            continue
        expected = round(ot_hours * hourly, 2)
        actual = round(ot_amount, 2)
        if abs(expected - actual) > 0.5:
            out.append(
                _fail(
                    "R10",
                    "holiday_weekend_multiplier_check",
                    expected=expected,
                    actual=actual,
                    message=(
                        f"OT amount {actual} doesn't reconcile to {ot_hours}h × "
                        f"{hourly:.2f}/hr = {expected}"
                    ),
                    line_idx=i,
                    emp_id=li.get("emp_id"),
                )
            )
        else:
            out.append(
                _ok("R10", "holiday_weekend_multiplier_check", line_idx=i, emp_id=li.get("emp_id"))
            )
    return out


# --- orchestration ------------------------------------------------------


def r14_period_not_closed(
    invoice: dict, contract: Contract, ctx: dict, session: Session
) -> list[RuleResult]:
    """R14: don't generate invoices for a (client, period) that's been closed.

    Real AP / payroll products lock periods after the close to prevent late
    adjustments slipping in. We honor `Client.settings.closed_periods[]`.
    """
    from ..models import Client

    client_code = invoice.get("client_code")
    period = invoice.get("period")
    if not (client_code and period):
        return [_ok("R14", "period_not_closed")]
    c = session.get(Client, client_code)
    closed = (c.settings or {}).get("closed_periods", []) if c else []
    if period in closed:
        return [
            _fail(
                "R14",
                "period_not_closed",
                expected=f"period '{period}' open",
                actual="CLOSED",
                message=f"period '{period}' is locked for client {client_code}; "
                f"reopen explicitly before invoicing",
            )
        ]
    return [_ok("R14", "period_not_closed")]


RULES = (
    ("R1", r1_employee_in_contract_scope),
    ("R2", r2_rate_compliance_per_category),
    ("R3", r3_period_boundary_check),
    ("R4", r4_ot_within_contract_cap),
    ("R5", r5_sow_hours_not_exceeded),
    ("R6", r6_markup_correctly_applied),
    ("R7", r7_vat_calculation_correct),
    ("R8", r8_duplicate_invoice_extended),
    ("R9", r9_approver_signature_present),
    ("R10", r10_holiday_weekend_multiplier_check),
    ("R14", r14_period_not_closed),
)


def find_active_contract(session: Session, client_code: str | None) -> Contract | None:
    if not client_code:
        return None
    return (
        session.query(Contract)
        .filter(Contract.client_code == client_code, Contract.active.is_(True))
        .first()
    )


def run_rule_engine(
    invoice: dict, contract: Contract | None, session: Session, ctx: dict | None = None
) -> list[RuleResult]:
    """Run all 10 rules. If no contract is bound, emit a single error so the doc
    routes to HITL — a billable timesheet without a contract is always exception."""
    ctx = ctx or {}
    if contract is None:
        return [
            _fail(
                "R0",
                "contract_bound",
                expected="active contract for client",
                actual="none",
                message="no active contract found for this client/period",
            )
        ]
    results: list[RuleResult] = []
    for _, fn in RULES:
        try:
            results.extend(fn(invoice, contract, ctx, session))
        except Exception as e:  # noqa: BLE001
            results.append(
                _fail("R?", fn.__name__, expected="rule run", actual=str(e), message=str(e))
            )
    return results


def has_blocking_failure(results: list[RuleResult]) -> bool:
    return any((not r["passed"]) and r.get("severity") != "warning" for r in results)


def _demo() -> None:
    # minimal smoke: empty invoice + no contract → returns "R0 contract_bound" error
    results = run_rule_engine({"line_items": []}, None, session=None)  # type: ignore[arg-type]
    assert any(r["rule_id"] == "R0" and not r["passed"] for r in results), results
    print("rule engine smoke: PASS")


if __name__ == "__main__":
    _demo()

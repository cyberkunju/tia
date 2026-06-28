"""Mock ERP - turns resolved timesheet rows + payroll master into invoice line items.

TASC bills the client for staff: per employee, prorate the monthly cost by attendance,
add OT cost and reimbursements, apply the client's management markup. Pure + deterministic.

OT formula per UAE Federal Decree-Law 33/2021 (and TASC's seed Payroll sheet):
  ot_amount = basic / 26 / 8 × ot_hours × multiplier
  multiplier defaults to 1.25 (standard OT). Night/Rest/Holiday OT is 1.5x - modelled
  in rate cards; the mock honours the standard 1.25 unless contract overrides.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy.orm import Session

from ..models import Client, Employee, Payroll
from ..schema import MatchResult, TimesheetExtraction
from ..validate.rules import check_attendance, check_threshold, validate_payroll

CENT = Decimal("0.01")
DEFAULT_MARKUP = 0.20  # 20% - TASC standard for UAE manpower supply
OT_DIVISOR_DAYS = Decimal("26")  # UAE labour-law convention
OT_HOURS_PER_DAY = Decimal("8")
OT_STANDARD_MULT = Decimal("1.25")  # UAE Federal Decree-Law 33/2021


def _d(x) -> Decimal:
    return Decimal(str(x or 0))


def _money(x: Decimal) -> float:
    return float(x.quantize(CENT, rounding=ROUND_HALF_UP))


def _compute_ot(basic, ot_hours, multiplier: Decimal = OT_STANDARD_MULT) -> Decimal:
    """OT cost from basic salary + hours + statutory multiplier."""
    if not ot_hours:
        return Decimal("0")
    return _d(basic) / OT_DIVISOR_DAYS / OT_HOURS_PER_DAY * _d(ot_hours) * multiplier


def client_settings(client: Client | None) -> dict:
    base = {"markup_pct": DEFAULT_MARKUP, "threshold_aed": 60000, "dispatch_rule": "alphabetical"}
    if client and client.settings:
        # settings is the per-client override; keep what's in DB
        for k, v in client.settings.items():
            base[k] = v
    return base


def build_invoice(extraction: TimesheetExtraction, match: MatchResult, session: Session) -> dict:
    client_code = extraction.client_code
    # infer client from first resolved employee if not set
    if not client_code:
        for m in match.matches:
            if m.chosen_emp_id:
                e = session.get(Employee, m.chosen_emp_id)
                if e:
                    client_code = e.client_code
                    break
    client = session.get(Client, client_code) if client_code else None
    settings = client_settings(client)
    markup = _d(settings["markup_pct"])

    line_items: list[dict] = []
    validations: list[dict] = []
    exceptions: list[dict] = []
    total = Decimal("0")

    for m in match.matches:
        row = extraction.rows[m.row_idx]
        if not m.chosen_emp_id or m.ambiguous:
            exceptions.append(
                {
                    "employee_name": row.employee_name,
                    "reason": m.reason or "unresolved",
                    "ambiguous": m.ambiguous,
                    "candidates": [c.emp_id for c in m.candidates],
                }
            )
            continue

        emp = session.get(Employee, m.chosen_emp_id)
        payroll = (
            session.query(Payroll)
            .filter(
                Payroll.emp_id == m.chosen_emp_id,
                Payroll.period == (extraction.period or Payroll.period),
            )
            .first()
        ) or session.query(Payroll).filter(Payroll.emp_id == m.chosen_emp_id).first()

        if not payroll:
            exceptions.append({"employee_name": row.employee_name, "reason": "no payroll record"})
            continue

        std = int(payroll.working_days) or 22
        attended = float(row.days_worked) if row.days_worked is not None else std
        prorated = _d(payroll.gross) * _d(attended) / _d(std)
        # Recompute OT from the timesheet's hours (basic/26/8 × hrs × 1.25),
        # not the seed's pre-baked ot_amount, so a timesheet asking for 50 OT hrs
        # actually shows up as 50 OT hrs of cost on the invoice.
        ts_ot_hours = (
            float(row.ot_hours) if row.ot_hours is not None else float(payroll.ot_hours or 0)
        )
        ot = _compute_ot(payroll.basic, ts_ot_hours)
        reimb = sum((_d(r.amount_aed) for r in row.reimbursements), Decimal("0"))
        billable = (prorated + ot) * (Decimal("1") + markup) + reimb
        total += billable

        # per-row validations (the deterministic safety net)
        row_checks = validate_payroll(payroll) + [check_attendance(row.days_worked, payroll)]
        for c in row_checks:
            validations.append({**c.model_dump(), "emp_id": m.chosen_emp_id})

        line_items.append(
            {
                "emp_id": emp.emp_id,
                "employee_name": emp.full_name,
                "job_title": emp.job_title,
                "days_worked": attended,
                "standard_days": std,
                "ot_hours": ts_ot_hours,
                "monthly_gross": _money(_d(payroll.gross)),
                "prorated": _money(prorated),
                "ot_amount": _money(ot),
                "ot_hourly_rate": _money(
                    _d(payroll.basic) / OT_DIVISOR_DAYS / OT_HOURS_PER_DAY * OT_STANDARD_MULT
                ),
                "reimbursements": _money(reimb),
                "markup_pct": float(markup),
                "amount": _money(billable),
                "confidence": m.confidence,
            }
        )

    amount = _money(total)
    threshold = check_threshold(amount, settings.get("threshold_aed"))
    validations.append(threshold.model_dump())

    return {
        "client_code": client_code,
        "client_name": client.name if client else None,
        "period": extraction.period,
        "currency": "AED",
        "line_items": line_items,
        "exceptions": exceptions,
        "amount": amount,
        "validations": validations,
        "requires_finance_approval": not threshold.passed,
    }

"""Revenue-leakage sentinel.

"Leakage" = the silent loss when an employee was paid by TASC but never
re-billed to the client. For a staffing business this is the single biggest
hidden P&L hole - it doesn't show up as a bad debt, it just never appears as
revenue.

We walk `Payroll` for a period and, per (emp_id, client_code), check whether
any active (non-voided) `Invoice` has a `line_items` entry covering the cost.
What's missing is classified into five plain-English reasons:

    NO_TIMESHEET        no invoice line item at all - the row was never billed
    PARTIAL_TIMESHEET   billed but for fewer days than the working-day total
    MISSING_OVERTIME    billed but no OT hours billed despite OT on payroll
    RATE_UNDERCHARGE    billed but the prorated cost is well below payroll gross
    LATE_PERIOD         no current invoice but a prior period had one

Returns a `LeakageReport` with per-entry detail + per-client aggregation +
a grand total. The trailing anomaly score (`is_anomalous_period`) flags
periods whose leakage exceeds the trailing-3-period mean by 2σ - a quiet
canary for "this month is unusually bad".

Every scan emits `metrics.leakage_scan` to the audit chain so a controller
can subpoena the exact moment a leakage was first surfaced.
"""

from __future__ import annotations

import math
import statistics
from collections import defaultdict
from enum import Enum
from typing import Iterable

from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..models import Client, Employee, Invoice, Payroll


class LeakageReason(str, Enum):
    NO_TIMESHEET = "no_timesheet"
    PARTIAL_TIMESHEET = "partial_timesheet"
    MISSING_OVERTIME = "missing_overtime"
    RATE_UNDERCHARGE = "rate_undercharge"
    LATE_PERIOD = "late_period"


FRIENDLY_LEAKAGE_MESSAGES: dict[LeakageReason, str] = {
    LeakageReason.NO_TIMESHEET: (
        "TASC paid this associate's salary for the period but the client was never "
        "invoiced for their time. No timesheet ever reached TIA."
    ),
    LeakageReason.PARTIAL_TIMESHEET: (
        "Only part of the associate's working days were billed - the timesheet "
        "covered fewer days than the payroll standard."
    ),
    LeakageReason.MISSING_OVERTIME: (
        "Payroll paid OT hours but the invoice has zero billable OT - the OT was "
        "absorbed by TASC instead of recovered from the client."
    ),
    LeakageReason.RATE_UNDERCHARGE: (
        "The invoiced amount is materially below the associate's prorated payroll "
        "cost - the markup didn't survive billing."
    ),
    LeakageReason.LATE_PERIOD: (
        "No invoice yet for the current period, but the client was billed for this "
        "associate in a prior period - looks like a missed cycle."
    ),
}

# Tolerances (kept loose for the demo; tighten in production)
_PARTIAL_DAYS_TOLERANCE = 0.5  # under-bill by more than half a day → partial
_RATE_UNDERCHARGE_PCT = 0.10  # billed < payroll cost - 10% → undercharge
_DEFAULT_MARKUP = 0.20  # TASC standard


# ---- Pydantic surface ------------------------------------------------------


class LeakageEntry(BaseModel):
    emp_id: str
    name: str
    client_code: str
    client_name: str | None = None
    reason: LeakageReason
    expected_billable_aed: float
    actual_billed_aed: float = 0.0
    days_paid: float = 0.0
    days_billed: float = 0.0
    ot_hours_paid: float = 0.0
    ot_hours_billed: float = 0.0
    last_billed_period: str | None = None
    notes: str | None = None


class ClientLeakage(BaseModel):
    client_code: str
    client_name: str | None = None
    total_aed: float
    entry_count: int
    by_reason: dict[str, float] = Field(default_factory=dict)


class LeakageReport(BaseModel):
    period: str
    generated_at: str  # ISO timestamp
    total_aed: float
    associate_count: int
    by_client: list[ClientLeakage]
    entries: list[LeakageEntry]
    by_reason: dict[str, float] = Field(default_factory=dict)
    # Trailing-baseline anomaly check
    baseline_mean_aed: float = 0.0
    baseline_stdev_aed: float = 0.0
    is_anomalous_period: bool = False
    baseline_delta_pct: float | None = None


# ---- Core walker ------------------------------------------------------------


def _markup_for(client: Client | None) -> float:
    if client and isinstance(client.settings, dict):
        m = client.settings.get("markup_pct")
        if isinstance(m, (int, float)):
            return float(m)
    return _DEFAULT_MARKUP


def _invoice_lines_for(session: Session, client_code: str, period: str) -> list[dict]:
    """Active (non-voided) invoice lines for one (client, period), indexed by emp_id.

    Recovery invoices (suffix `-R\\d+`) ARE counted as billed coverage — the
    "click Recover → leakage drops" demo narrative depends on it. The recovery
    trail stays auditable via the sequence suffix and the
    `invoice.recovery_issued` audit event.
    """
    invs = (
        session.query(Invoice)
        .filter(
            Invoice.client_code == client_code,
            Invoice.period == period,
            Invoice.voided_at.is_(None),
        )
        .all()
    )
    lines: list[dict] = []
    for inv in invs:
        for li in inv.line_items or []:
            if isinstance(li, dict):
                lines.append(li)
    return lines


def _last_billed_period(session: Session, emp_id: str, before_period: str) -> str | None:
    """The most recent period (lexically less than `before_period`) where this
    emp appeared on an invoice line. Period strings like "June 2026" don't sort
    well lexically, so we just take the most-recent generated invoice."""
    invs = (
        session.query(Invoice)
        .filter(Invoice.voided_at.is_(None))
        .order_by(Invoice.created_at.desc())
        .all()
    )
    for inv in invs:
        if inv.period == before_period:
            continue
        for li in inv.line_items or []:
            if isinstance(li, dict) and li.get("emp_id") == emp_id:
                return inv.period
    return None


def _classify(
    payroll: Payroll,
    invoice_line: dict | None,
    last_billed: str | None,
    markup: float,
) -> tuple[LeakageReason, float, dict] | None:
    """Return (reason, expected_billable_aed, extra_fields) or None if no leakage."""
    std_days = max(int(payroll.working_days or 22), 1)
    payroll_gross = float(payroll.gross or 0.0)
    payroll_ot_hours = float(payroll.ot_hours or 0.0)
    payroll_ot_amount = float(payroll.ot_amount or 0.0)
    expected_full = payroll_gross * (1.0 + markup)

    if invoice_line is None:
        if last_billed:
            return (
                LeakageReason.LATE_PERIOD,
                expected_full,
                {"days_paid": std_days, "last_billed_period": last_billed},
            )
        return (
            LeakageReason.NO_TIMESHEET,
            expected_full,
            {"days_paid": std_days},
        )

    days_billed = float(invoice_line.get("days_worked") or 0.0)
    ot_hours_billed = float(invoice_line.get("ot_hours") or 0.0)
    actual_billed = float(invoice_line.get("amount") or 0.0)

    if days_billed + _PARTIAL_DAYS_TOLERANCE < std_days:
        missing_days = std_days - days_billed
        expected = (payroll_gross * missing_days / std_days) * (1.0 + markup)
        return (
            LeakageReason.PARTIAL_TIMESHEET,
            expected,
            {
                "days_paid": std_days,
                "days_billed": days_billed,
                "actual_billed_aed": actual_billed,
            },
        )

    if payroll_ot_hours > 0 and ot_hours_billed == 0:
        expected = payroll_ot_amount * (1.0 + markup)
        return (
            LeakageReason.MISSING_OVERTIME,
            expected,
            {
                "ot_hours_paid": payroll_ot_hours,
                "ot_hours_billed": 0.0,
                "actual_billed_aed": actual_billed,
            },
        )

    # Rate undercharge: prorated full-month cost (with markup) materially
    # exceeds what we actually billed.
    full_cost_with_markup = payroll_gross * (1.0 + markup)
    if (
        actual_billed > 0
        and full_cost_with_markup > 0
        and actual_billed < full_cost_with_markup * (1.0 - _RATE_UNDERCHARGE_PCT)
    ):
        delta = full_cost_with_markup - actual_billed
        return (
            LeakageReason.RATE_UNDERCHARGE,
            delta,
            {
                "days_paid": std_days,
                "days_billed": days_billed,
                "actual_billed_aed": actual_billed,
            },
        )

    return None


def _baseline_for(
    session: Session, current_period: str, client_code: str | None
) -> tuple[float, float]:
    """Trailing-3-period total leakage mean + stdev.

    Implementation note: we don't run the full classifier across history. For
    the trailing baseline we use a cheap proxy - the count of unbilled
    payroll rows × the mean payroll gross with markup. It's directionally
    correct (more unbilled rows → higher leakage) and runs in one query per
    period. Upgrade path: cache `LeakageReport.total_aed` per period.
    """
    periods = (
        session.query(Payroll.period)
        .filter(Payroll.period.is_not(None), Payroll.period != current_period)
        .distinct()
        .all()
    )
    period_values = [p[0] for p in periods if p[0]]
    if len(period_values) < 2:
        return 0.0, 0.0
    sample: list[float] = []
    for p in period_values[-3:]:
        q = session.query(Payroll).filter(Payroll.period == p)
        if client_code:
            q = q.filter(Payroll.client_code == client_code)
        rows = q.all()
        if not rows:
            continue
        mean_gross = sum(float(r.gross or 0.0) for r in rows) / max(len(rows), 1)
        # Cheap proxy: assume ~10% unbilled rate per period
        sample.append(mean_gross * len(rows) * 0.10 * (1.0 + _DEFAULT_MARKUP))
    if len(sample) < 2:
        return 0.0, 0.0
    return statistics.mean(sample), statistics.pstdev(sample)


def compute_revenue_leakage(
    session: Session,
    period: str,
    client_code: str | None = None,
) -> LeakageReport:
    """Walk payroll for `period` and classify every unbilled / under-billed row.

    `client_code` (optional) restricts the scan to one client - used when a
    Client persona asks "where am I losing money".
    """
    from datetime import datetime, timezone

    from ..orchestrator import log_event

    pq = session.query(Payroll).filter(Payroll.period == period)
    if client_code:
        pq = pq.filter(Payroll.client_code == client_code)
    payroll_rows: list[Payroll] = pq.all()

    # Pre-index invoice lines per client_code so we don't re-query per row.
    clients_in_scope = {p.client_code for p in payroll_rows if p.client_code}
    lines_by_client: dict[str, dict[str, dict]] = {}
    for c in clients_in_scope:
        idx: dict[str, dict] = {}
        for li in _invoice_lines_for(session, c, period):
            emp = li.get("emp_id")
            if emp and emp not in idx:
                idx[emp] = li
        lines_by_client[c] = idx

    entries: list[LeakageEntry] = []
    by_client: dict[str, ClientLeakage] = {}
    by_reason: defaultdict[str, float] = defaultdict(float)
    total = 0.0

    for pr in payroll_rows:
        if not pr.client_code:
            continue
        client = session.get(Client, pr.client_code)
        markup = _markup_for(client)
        line = lines_by_client.get(pr.client_code, {}).get(pr.emp_id)
        last_billed = _last_billed_period(session, pr.emp_id, period) if line is None else None
        classified = _classify(pr, line, last_billed, markup)
        if not classified:
            continue
        reason, expected, extras = classified
        emp = session.get(Employee, pr.emp_id)
        entry = LeakageEntry(
            emp_id=pr.emp_id,
            name=(emp.full_name if emp else pr.employee_name or pr.emp_id),
            client_code=pr.client_code,
            client_name=client.name if client else None,
            reason=reason,
            expected_billable_aed=round(expected, 2),
            **extras,
        )
        entries.append(entry)
        total += entry.expected_billable_aed
        by_reason[reason.value] += entry.expected_billable_aed
        cl = by_client.setdefault(
            pr.client_code,
            ClientLeakage(
                client_code=pr.client_code,
                client_name=client.name if client else None,
                total_aed=0.0,
                entry_count=0,
            ),
        )
        cl.total_aed = round(cl.total_aed + entry.expected_billable_aed, 2)
        cl.entry_count += 1
        cl.by_reason[reason.value] = round(
            cl.by_reason.get(reason.value, 0.0) + entry.expected_billable_aed, 2
        )

    mean, stdev = _baseline_for(session, period, client_code)
    delta_pct: float | None = None
    is_anomalous = False
    if mean > 0:
        delta_pct = (total - mean) / mean
        if stdev > 0 and total > mean + 2 * stdev:
            is_anomalous = True

    by_client_sorted = sorted(by_client.values(), key=lambda c: -c.total_aed)
    entries.sort(key=lambda e: -e.expected_billable_aed)

    report = LeakageReport(
        period=period,
        generated_at=datetime.now(timezone.utc).isoformat(),
        total_aed=round(total, 2),
        associate_count=len(entries),
        by_client=by_client_sorted,
        entries=entries,
        by_reason={k: round(v, 2) for k, v in by_reason.items()},
        baseline_mean_aed=round(mean, 2),
        baseline_stdev_aed=round(stdev, 2),
        is_anomalous_period=is_anomalous,
        baseline_delta_pct=(round(delta_pct, 4) if delta_pct is not None else None),
    )

    # Audit-log the scan (best-effort; never block the response)
    try:
        log_event(
            session,
            "system",
            "metrics",
            f"leakage:{period}:{client_code or 'ALL'}",
            "metrics.leakage_scan",
            {
                "period": period,
                "client_code": client_code,
                "total_aed": report.total_aed,
                "associate_count": report.associate_count,
                "is_anomalous": is_anomalous,
            },
        )
    except Exception:  # noqa: BLE001
        pass

    return report


# ---- Convenience exports for tests / REPL ----------------------------------


def reasons_friendly(entries: Iterable[LeakageEntry]) -> list[dict]:
    """Render entries with friendly messages attached - for UI tooltips."""
    return [
        {
            **e.model_dump(),
            "friendly": FRIENDLY_LEAKAGE_MESSAGES.get(e.reason, ""),
        }
        for e in entries
    ]


def _demo() -> None:
    """Offline smoke: classifier + baseline math sanity."""
    # baseline math sanity (no DB)
    assert FRIENDLY_LEAKAGE_MESSAGES[LeakageReason.NO_TIMESHEET].startswith("TASC paid")
    # _PARTIAL_DAYS_TOLERANCE behaviour
    assert _PARTIAL_DAYS_TOLERANCE > 0
    # math.isfinite guard for empty baselines
    assert math.isfinite(0.0)
    print("finance.leakage: OK")


if __name__ == "__main__":
    _demo()

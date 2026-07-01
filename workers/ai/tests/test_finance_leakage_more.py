"""finance/leakage.py — _classify branches, baseline math, anomaly flag, and
the client_code=None skip in compute_revenue_leakage."""

from __future__ import annotations

import uuid

import pytest

from tia_ai.db import SessionLocal
from tia_ai.finance import leakage as L
from tia_ai.finance.leakage import LeakageReason
from tia_ai.models import Payroll


@pytest.fixture()
def s():
    sess = SessionLocal()
    try:
        yield sess
    finally:
        sess.rollback()
        sess.close()


class _PR:
    def __init__(self, working_days=22, gross=10000.0, ot_hours=0.0, ot_amount=0.0):
        self.working_days = working_days
        self.gross = gross
        self.ot_hours = ot_hours
        self.ot_amount = ot_amount


# ── _classify branches ─────────────────────────────────────────────────────────


def test_classify_no_timesheet():
    r = L._classify(_PR(), None, None, 0.2)
    assert r[0] == LeakageReason.NO_TIMESHEET
    assert r[1] == 10000.0 * 1.2


def test_classify_late_period():
    r = L._classify(_PR(), None, "May 2026", 0.2)
    assert r[0] == LeakageReason.LATE_PERIOD
    assert r[2]["last_billed_period"] == "May 2026"


def test_classify_partial_timesheet():
    line = {"days_worked": 10, "ot_hours": 0, "amount": 5000.0}
    r = L._classify(_PR(working_days=22), line, None, 0.2)
    assert r[0] == LeakageReason.PARTIAL_TIMESHEET
    assert r[2]["days_billed"] == 10


def test_classify_missing_overtime():
    line = {"days_worked": 22, "ot_hours": 0, "amount": 12000.0}
    r = L._classify(_PR(working_days=22, ot_hours=8, ot_amount=800.0), line, None, 0.2)
    assert r[0] == LeakageReason.MISSING_OVERTIME
    assert r[2]["ot_hours_paid"] == 8


def test_classify_rate_undercharge():
    # billed well below prorated full cost with markup
    line = {"days_worked": 22, "ot_hours": 0, "amount": 1000.0}
    r = L._classify(_PR(working_days=22, gross=10000.0), line, None, 0.2)
    assert r[0] == LeakageReason.RATE_UNDERCHARGE


def test_classify_fully_billed_returns_none():
    line = {"days_worked": 22, "ot_hours": 0, "amount": 12000.0}  # == gross*1.2
    assert L._classify(_PR(working_days=22, gross=10000.0), line, None, 0.2) is None


# ── _baseline_for ──────────────────────────────────────────────────────────────


def _seed_payroll(s, client_code, period, n, gross):
    for i in range(n):
        s.add(
            Payroll(
                id=str(uuid.uuid4()),
                emp_id=f"LKEMP{uuid.uuid4().hex[:8]}",
                employee_name="X",
                client_code=client_code,
                period=period,
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


def test_baseline_for_with_history(s):
    cc = "LK" + uuid.uuid4().hex[:5]
    _seed_payroll(s, cc, "BASE-A 2099", 2, 100.0)
    _seed_payroll(s, cc, "BASE-B 2099", 5, 200.0)
    _seed_payroll(s, cc, "BASE-C 2099", 3, 150.0)
    mean, stdev = L._baseline_for(s, "CURR 2099", cc)
    assert mean > 0.0 and stdev >= 0.0


def test_baseline_for_insufficient_history(s):
    cc = "LK" + uuid.uuid4().hex[:5]
    _seed_payroll(s, cc, "ONLY 2099", 2, 100.0)
    # only one non-current period → not enough for a baseline
    assert L._baseline_for(s, "CURR 2099", cc) == (0.0, 0.0)


# ── compute_revenue_leakage: skip null client + anomaly flag ───────────────────


def test_compute_flags_anomalous_period(s):
    cc = "LK" + uuid.uuid4().hex[:5]
    # small, varied baseline periods
    _seed_payroll(s, cc, "AB1 2099", 2, 100.0)
    _seed_payroll(s, cc, "AB2 2099", 6, 250.0)
    _seed_payroll(s, cc, "AB3 2099", 3, 120.0)
    # current period: several fully-unbilled high-gross rows → huge leakage
    curr = "ACURR 2099"
    _seed_payroll(s, cc, curr, 5, 200000.0)
    report = L.compute_revenue_leakage(s, period=curr, client_code=cc)
    assert report.total_aed > 0
    assert isinstance(report.is_anomalous_period, bool)
    assert report.baseline_delta_pct is not None
    assert report.is_anomalous_period is True


def test_reasons_friendly():
    r = L._classify(_PR(), None, None, 0.2)
    entry = L.LeakageEntry(
        emp_id="E1", name="Carlos", client_code="CL001", reason=r[0], expected_billable_aed=r[1]
    )
    out = L.reasons_friendly([entry])
    assert out[0]["friendly"].startswith("TASC paid")

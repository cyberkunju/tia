"""Unit tests for the deterministic canonicalizer.

Karpathy rule: every non-trivial pure function leaves a runnable check behind.
"""

from __future__ import annotations

from tia_ai.canonicalize import (
    canon_leave,
    canon_leaves,
    canon_period,
    punch_to_day,
    summarize_punches,
)
from tia_ai.schema import LeaveCode


def test_canon_leave_variants():
    assert canon_leave("A/L") == LeaveCode.AL
    assert canon_leave("a-l") == LeaveCode.AL
    assert canon_leave("Annual") == LeaveCode.AL
    assert canon_leave("annual leave") == LeaveCode.AL
    assert canon_leave("vacation") == LeaveCode.AL
    assert canon_leave("Sick") == LeaveCode.SICK
    assert canon_leave("SL") == LeaveCode.SICK
    assert canon_leave("S") == LeaveCode.SICK
    assert canon_leave("public holiday") == LeaveCode.PUBLIC_HOLIDAY
    assert canon_leave("PH") == LeaveCode.PUBLIC_HOLIDAY
    assert canon_leave("LWP") == LeaveCode.UNPAID
    assert canon_leave("Present") == LeaveCode.PRESENT
    assert canon_leave("xyz") is None
    assert canon_leave("") is None
    assert canon_leave(None) is None


def test_canon_leaves_dedup_and_order():
    assert canon_leaves(["AL", "a/l", "Annual"]) == [LeaveCode.AL]
    assert canon_leaves(["AL", "Sick"]) == [LeaveCode.AL, LeaveCode.SICK]
    assert canon_leaves(["junk", "S"]) == [LeaveCode.SICK]
    assert canon_leaves([]) == []


def test_canon_period_normalisation():
    assert canon_period("June 2026") == "June 2026"
    assert canon_period("Jun 2026") == "June 2026"
    assert canon_period("2026-06") == "June 2026"
    assert canon_period("06/2026") == "June 2026"
    assert canon_period("January 2026") == "January 2026"
    assert canon_period(None) is None
    # unknown -> passthrough
    assert canon_period("Q2 2026") == "Q2 2026"


def test_punch_to_day():
    assert punch_to_day("09:00", "17:30") == (1.0, 8.5)
    assert punch_to_day("08:00", "12:00") == (1.0, 4.0)
    assert punch_to_day("09:00", None) == (0.0, 0.0)
    assert punch_to_day(None, "17:00") == (0.0, 0.0)
    assert punch_to_day("17:00", "09:00") == (0.0, 0.0)  # negative span
    assert punch_to_day("", "") == (0.0, 0.0)


def test_summarize_punches():
    days, hours = summarize_punches([("09:00", "17:00"), ("08:30", "12:30"), (None, None)])
    assert days == 2.0
    assert hours == 12.0
    days, hours = summarize_punches([])
    assert (days, hours) == (0.0, 0.0)

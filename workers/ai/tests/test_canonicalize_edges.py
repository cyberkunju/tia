"""Extra edge cases for the canonicalizer not covered by test_canonicalize.py.

Whitespace tolerance, case-insensitivity, unrecognised passthrough, and the
punch-clock zero/negative-span guards.
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


def test_canon_leave_trims_and_lowercases():
    assert canon_leave("  AL  ") == LeaveCode.AL
    assert canon_leave("SiCk") == LeaveCode.SICK
    assert canon_leave("PH") == LeaveCode.PUBLIC_HOLIDAY


def test_canon_leaves_filters_unknown_and_dedups_preserving_order():
    assert canon_leaves(["unknown", "AL", "annual", "Sick", "junk"]) == [
        LeaveCode.AL,
        LeaveCode.SICK,
    ]
    assert canon_leaves([]) == []


def test_canon_period_passthrough_for_unrecognised():
    # Anything not matching the known shapes is returned untouched.
    assert canon_period("Q3 FY26") == "Q3 FY26"
    assert canon_period("") is None
    assert canon_period(None) is None


def test_canon_period_mm_yyyy_and_dash_forms():
    assert canon_period("06/2026") == "June 2026"
    assert canon_period("2026-06") == "June 2026"
    assert canon_period("June-2026") == "June 2026"
    assert canon_period("December 2026") == "December 2026"


def test_punch_to_day_exact_hours():
    assert punch_to_day("08:15", "16:45") == (1.0, 8.5)
    # equal in/out is a zero-length span → not a worked day
    assert punch_to_day("09:00", "09:00") == (0.0, 0.0)
    # malformed times → guard returns zero
    assert punch_to_day("notatime", "alsono") == (0.0, 0.0)


def test_summarize_punches_skips_invalid_days():
    days, hours = summarize_punches(
        [("09:00", "17:00"), ("bad", "worse"), ("08:00", "12:00"), (None, None)]
    )
    assert days == 2.0
    assert hours == 12.0

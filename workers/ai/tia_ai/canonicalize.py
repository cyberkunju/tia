"""Deterministic canonicalization — pure functions, no LLM.

Maps the messy real-world variants the brief throws at us (mixed leave codes,
punch in/out, period spellings) onto canonical forms. Unit-checked in __main__.
"""

from __future__ import annotations

import datetime as dt
import re

from .schema import LeaveCode

# raw token (lowercased, stripped) -> canonical leave code
_LEAVE_MAP = {
    "al": LeaveCode.AL,
    "a/l": LeaveCode.AL,
    "a-l": LeaveCode.AL,
    "annual": LeaveCode.AL,
    "annual leave": LeaveCode.AL,
    "vacation": LeaveCode.AL,
    "sick": LeaveCode.SICK,
    "s": LeaveCode.SICK,
    "sl": LeaveCode.SICK,
    "s/l": LeaveCode.SICK,
    "sick leave": LeaveCode.SICK,
    "unpaid": LeaveCode.UNPAID,
    "lwp": LeaveCode.UNPAID,
    "unpaid leave": LeaveCode.UNPAID,
    "ph": LeaveCode.PUBLIC_HOLIDAY,
    "holiday": LeaveCode.PUBLIC_HOLIDAY,
    "public holiday": LeaveCode.PUBLIC_HOLIDAY,
    "absent": LeaveCode.ABSENT,
    "a": LeaveCode.ABSENT,
    "abs": LeaveCode.ABSENT,
    "present": LeaveCode.PRESENT,
    "p": LeaveCode.PRESENT,
    "present ": LeaveCode.PRESENT,
}

_MONTHS = {
    m.lower(): i
    for i, m in enumerate(
        [
            "January",
            "February",
            "March",
            "April",
            "May",
            "June",
            "July",
            "August",
            "September",
            "October",
            "November",
            "December",
        ],
        start=1,
    )
}


def canon_leave(token: str | None) -> LeaveCode | None:
    if not token:
        return None
    return _LEAVE_MAP.get(token.strip().lower())


def canon_leaves(tokens: list[str]) -> list[LeaveCode]:
    out: list[LeaveCode] = []
    for t in tokens:
        c = canon_leave(t)
        if c and c not in out:
            out.append(c)
    return out


def canon_period(text: str | None) -> str | None:
    """Normalize a period to payroll form 'Month YYYY' (matches seed, e.g. 'June 2026').

    Accepts 'June 2026', 'Jun 2026', '2026-06', '06/2026', 'June-2026'.
    """
    if not text:
        return None
    text = str(text).strip()
    # YYYY-MM or YYYY/MM
    m = re.match(r"(\d{4})[-/](\d{1,2})$", text)
    if m:
        y, mo = int(m.group(1)), int(m.group(2))
    else:
        m = re.match(r"(\d{1,2})[-/](\d{4})$", text)  # MM/YYYY
        if m:
            mo, y = int(m.group(1)), int(m.group(2))
        else:
            m = re.match(r"([A-Za-z]+)[\s-]+(\d{4})$", text)  # Month YYYY
            if m:
                mo = _MONTHS.get(m.group(1).lower()[:3] and m.group(1).lower())
                if mo is None:
                    # try 3-letter abbrev
                    for name, idx in _MONTHS.items():
                        if name.startswith(m.group(1).lower()):
                            mo = idx
                            break
                y = int(m.group(2))
            else:
                return text  # leave untouched if unrecognized
    if not mo:
        return text
    month_name = dt.date(y, mo, 1).strftime("%B")
    return f"{month_name} {y}"


_TIME_RE = re.compile(r"(\d{1,2}):(\d{2})")


def _parse_time(s: str) -> float | None:
    m = _TIME_RE.search(s or "")
    if not m:
        return None
    return int(m.group(1)) + int(m.group(2)) / 60.0


def punch_to_day(punch_in: str | None, punch_out: str | None) -> tuple[float, float]:
    """Return (days_worked, hours) for one day given punch in/out strings.

    A valid in+out with out>in counts as 1 worked day; hours = out-in.
    Missing/invalid -> (0, 0).
    """
    ti, to = _parse_time(punch_in or ""), _parse_time(punch_out or "")
    if ti is None or to is None or to <= ti:
        return 0.0, 0.0
    return 1.0, round(to - ti, 2)


def summarize_punches(daily: list[tuple[str | None, str | None]]) -> tuple[float, float]:
    """Aggregate a month of (in,out) punches -> (total_days, total_hours)."""
    days = hours = 0.0
    for pin, pout in daily:
        d, h = punch_to_day(pin, pout)
        days += d
        hours += h
    return days, round(hours, 2)


def _demo() -> None:
    assert canon_leave("A/L") == LeaveCode.AL
    assert canon_leave("annual leave") == LeaveCode.AL
    assert canon_leave("S") == LeaveCode.SICK
    assert canon_leave("sick") == LeaveCode.SICK
    assert canon_leave("xyz") is None
    assert canon_leaves(["AL", "a/l", "Sick"]) == [LeaveCode.AL, LeaveCode.SICK]
    assert canon_period("2026-06") == "June 2026"
    assert canon_period("June 2026") == "June 2026"
    assert canon_period("Jun 2026") == "June 2026"
    assert canon_period("06/2026") == "June 2026"
    assert punch_to_day("09:00", "17:30") == (1.0, 8.5)
    assert punch_to_day("09:00", None) == (0.0, 0.0)
    assert punch_to_day("17:00", "09:00") == (0.0, 0.0)
    days, hours = summarize_punches([("09:00", "17:00"), ("08:30", "12:30"), (None, None)])
    assert days == 2.0 and hours == 12.0, (days, hours)
    print("canonicalize: all assertions passed")


if __name__ == "__main__":
    _demo()

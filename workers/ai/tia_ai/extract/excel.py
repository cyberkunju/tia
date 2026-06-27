"""Excel extractor (cases 5 and 7) — openpyxl, no LLM.

Two shapes, auto-detected from the header row:
  * clean (case 7): one row per employee with Emp ID / Name / Working Days / OT / Leave
  * punch (case 5): per-day In/Out time columns -> summarized to days+hours
"""

from __future__ import annotations

import re
from pathlib import Path

import openpyxl

from ..canonicalize import canon_leaves, canon_period, summarize_punches
from ..schema import TimesheetExtraction, TimesheetRow


def _norm(h) -> str:
    return re.sub(r"[^a-z0-9]", "", str(h).lower()) if h is not None else ""


def _find(headers: list[str], *names: str) -> int | None:
    norm = [_norm(h) for h in headers]
    for n in names:
        nn = _norm(n)
        for i, h in enumerate(norm):
            if h == nn:
                return i
        for i, h in enumerate(norm):
            if nn and nn in h:
                return i
    return None


def _num(v) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def extract_excel(path: str | Path) -> TimesheetExtraction:
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        return TimesheetExtraction()

    headers = [("" if c is None else str(c)) for c in rows[0]]
    data = rows[1:]

    out = TimesheetExtraction()
    # period / client may appear as columns
    pi = _find(headers, "period", "pay period", "month")
    ci = _find(headers, "client code", "client")
    if pi is not None:
        for r in data:
            if pi < len(r) and r[pi]:
                out.period = canon_period(r[pi])
                break
    if ci is not None:
        for r in data:
            if ci < len(r) and r[ci]:
                out.client_hint = str(r[ci]).strip()
                break

    # punch layout? -> columns containing 'in'/'out'
    in_cols = [
        i
        for i, h in enumerate(headers)
        if re.search(r"\bin\b|punchin|timein", _norm(h)) or _norm(h).endswith("in")
    ]
    out_cols = [
        i
        for i, h in enumerate(headers)
        if re.search(r"\bout\b|punchout|timeout", _norm(h)) or _norm(h).endswith("out")
    ]
    is_punch = len(in_cols) >= 2 and len(out_cols) >= 2

    emp_i = _find(headers, "emp id", "employee id", "empid")
    name_i = _find(headers, "full name", "employee name", "name")
    leave_i = _find(headers, "leave", "leave code", "leave type")

    if is_punch:
        in_cols.sort()
        out_cols.sort()
        pairs = list(zip(in_cols, out_cols, strict=False))
        for r in data:
            if not any(c is not None for c in r):
                continue
            daily = [
                (
                    str(r[i]) if i < len(r) and r[i] is not None else None,
                    str(r[o]) if o < len(r) and r[o] is not None else None,
                )
                for i, o in pairs
            ]
            days, hours = summarize_punches(daily)
            leave_tokens = []
            if leave_i is not None and leave_i < len(r) and r[leave_i]:
                leave_tokens = re.split(r"[;,]+", str(r[leave_i]))
            out.rows.append(
                TimesheetRow(
                    employee_name=str(r[name_i]).strip()
                    if name_i is not None and name_i < len(r) and r[name_i]
                    else "UNKNOWN",
                    emp_id=str(r[emp_i]).strip()
                    if emp_i is not None and emp_i < len(r) and r[emp_i]
                    else None,
                    days_worked=days,
                    hours=hours,
                    leave_codes=canon_leaves(leave_tokens),
                )
            )
        return out

    # clean layout
    days_i = _find(headers, "working days", "days worked", "days")
    ot_i = _find(headers, "ot hours", "overtime hours", "overtime")
    for r in data:
        if not any(c is not None for c in r):
            continue
        name = (
            str(r[name_i]).strip() if name_i is not None and name_i < len(r) and r[name_i] else None
        )
        emp = str(r[emp_i]).strip() if emp_i is not None and emp_i < len(r) and r[emp_i] else None
        if not name and not emp:
            continue
        leave_tokens = []
        if leave_i is not None and leave_i < len(r) and r[leave_i]:
            leave_tokens = re.split(r"[;,]+", str(r[leave_i]))
        out.rows.append(
            TimesheetRow(
                employee_name=name or (emp or "UNKNOWN"),
                emp_id=emp,
                days_worked=_num(r[days_i]) if days_i is not None and days_i < len(r) else None,
                ot_hours=_num(r[ot_i]) if ot_i is not None and ot_i < len(r) else None,
                leave_codes=canon_leaves(leave_tokens),
            )
        )
    return out

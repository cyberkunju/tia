"""Email-body extractor (cases 1, 2, 3, 6) — pure regex/heuristics, no LLM.

Handles the four email shapes from the brief:
  1. payout request: name + client + period + total, no Emp ID
  2. from employee: Emp ID + days, no client
  3. from client: client + list of names + days, no Emp IDs
  6. structured: Emp ID + leave + reimbursements (reason + amount) + month

Each field is parsed independently per line (not one brittle mega-regex), so a prose
sentence like "My employee id is EMP10001 and I worked 22 days" still yields the right
emp_id + days without mistaking words for a name.
"""

from __future__ import annotations

import re

from ..canonicalize import canon_leaves, canon_period
from ..schema import Reimbursement, TimesheetExtraction, TimesheetRow

EMP_RE = re.compile(r"\bEMP\d{4,}\b", re.IGNORECASE)
PERIOD_RE = re.compile(
    r"\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}|\d{4}[-/]\d{1,2})\b",
    re.IGNORECASE,
)
CLIENT_RE = re.compile(r"^\s*client\s*[:\-]\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
PERIODLINE_RE = re.compile(
    r"^\s*(?:period|month|pay period)\s*[:\-]\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE
)
SIGNED_RE = re.compile(
    r"^\s*(?:signed|authorised by|authorized by|approved by)\s*[,:\-]?\s*(.+?)\s*$",
    re.IGNORECASE | re.MULTILINE,
)

DAYS_RE = re.compile(r"(\d{1,2}(?:\.\d+)?)\s*(?:days?|d)\b", re.IGNORECASE)
OT_RE = re.compile(r"(\d{1,2}(?:\.\d+)?)\s*(?:ot|o/t|overtime)\b", re.IGNORECASE)
LEAVE_RE = re.compile(r"(?:leave|on)\s*[:\-]?\s*([A-Za-z/][A-Za-z/ ]*)", re.IGNORECASE)
# bare leave tokens at line end (markdown shape: "Ahmed Khan 20 days AL").
# Case-sensitive on purpose so "Al Rashid" (a name fragment) doesn't match "AL".
BARE_LEAVE_RE = re.compile(
    r"\b(AL|A/L|A-L|SL|S/L|SICK|UNPAID|LWP|PH|ABSENT|PRESENT|ANNUAL|HOLIDAY)\b"
)
REIMB_RE = re.compile(
    r"(?:reimbursement|reimburse|claim|expense)[^0-9]*?(?:AED\s*)?([0-9][0-9,]*\.?\d*)"
    r"(?:\s*for\s*([A-Za-z][A-Za-z ]+))?",
    re.IGNORECASE,
)
NAME_RE = re.compile(r"([A-Z][A-Za-z'’.\-]+(?:\s+[A-Z][A-Za-z'’.\-]+){0,3})")

_NOISE_PREFIXES = (
    "dear",
    "hi ",
    "hello",
    "subject",
    "regards",
    "thanks",
    "thank",
    "please",
    "from",
    "to ",
    "to:",
    "team",
    "client",
    "period",
    "month",
    "pay period",
    "the ",
    "this ",
    "approved",
    "signed",
    "authorised",
    "authorized",
    "finance",
    "operations",
    "site manager",
)
# words that look title-case but aren't names
_NAME_STOP = {"My", "I", "We", "Hi", "Dear", "Client", "Period", "Subject", "Regards", "AED"}


def _clean_num(s: str | None) -> float | None:
    if not s:
        return None
    try:
        return float(s.replace(",", ""))
    except ValueError:
        return None


def _leading_name(segment: str) -> str | None:
    """First run of 1-4 Capitalized words at the start of a segment, before any digit/dash."""
    seg = segment.strip().lstrip("-*•").strip()
    # cut at first digit or dash to avoid trailing "- 22 days"
    seg = re.split(r"[-–:]|\d", seg, maxsplit=1)[0].strip()
    m = NAME_RE.match(seg)
    if not m:
        return None
    name = m.group(1).strip()
    first = name.split()[0]
    if first in _NAME_STOP or len(name) < 3:
        return None
    return name


def extract_email(text: str) -> TimesheetExtraction:
    out = TimesheetExtraction()

    cm = CLIENT_RE.search(text)
    if cm:
        out.client_hint = cm.group(1).strip()
    pm = PERIODLINE_RE.search(text) or PERIOD_RE.search(text)
    if pm:
        out.period = canon_period(pm.group(1))
    sm = SIGNED_RE.search(text)
    if sm and len(sm.group(1)) < 60:
        out.signed_by = sm.group(1).strip()

    seen: set[str] = set()
    for raw in text.splitlines():
        line = raw.strip()
        low = line.lower()
        if len(line) < 3 or any(low.startswith(p) for p in _NOISE_PREFIXES):
            continue

        emp = EMP_RE.search(line)
        days = DAYS_RE.search(line)
        ot = OT_RE.search(line)
        lv = LEAVE_RE.search(line)
        reimb_hits = REIMB_RE.findall(line)

        if not (emp or days or reimb_hits):
            continue  # no timesheet signal on this line

        emp_id = emp.group(0).upper() if emp else None
        if emp:
            after = line[emp.end() :]
            name = _leading_name(after) or _leading_name(line[: emp.start()])
        else:
            name = _leading_name(line)
        if not emp_id and not name:
            continue  # can't attribute this row to anyone

        key = f"{name}|{emp_id}"
        if key in seen:
            continue
        seen.add(key)

        leave_codes = canon_leaves(re.split(r"[,/ ]+", lv.group(1))) if lv else []
        if not leave_codes:
            # fall back to bare leave tokens scanned across the whole line
            bare = BARE_LEAVE_RE.findall(line)
            if bare:
                leave_codes = canon_leaves(bare)
        reimb: list[Reimbursement] = []
        for amt, reason in reimb_hits:
            val = _clean_num(amt)
            if val:
                reimb.append(
                    Reimbursement(reason=(reason or "reimbursement").strip(), amount_aed=val)
                )

        out.rows.append(
            TimesheetRow(
                employee_name=name or (emp_id or "UNKNOWN"),
                emp_id=emp_id,
                days_worked=_clean_num(days.group(1)) if days else None,
                ot_hours=_clean_num(ot.group(1)) if ot else None,
                leave_codes=leave_codes,
                reimbursements=reimb,
            )
        )

    return out

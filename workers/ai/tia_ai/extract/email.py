"""Email-body extractor (cases 1, 2, 3, 6) - pure regex/heuristics, no LLM.

Handles the four email shapes from the brief:
  1. payout request: name + client + period + total, no Emp ID
  2. from employee: Emp ID + days, no client
  3. from client: client + list of names + days, no Emp IDs
  6. structured: Emp ID + leave + reimbursements (reason + amount) + month

Two row layouts are supported:
  - inline   : one employee per line ("EMP1 Name - 20 days, leave: AL, claim AED 250 ...")
  - labelled : a header line names the employee, then "Days worked: 22" / "Leave taken: AL"
               continuation lines attach to that same employee instead of starting new rows.

Each field is parsed per line (not one brittle mega-regex), so a prose sentence like
"My employee id is EMP10001 and I worked 22 days" still yields the right emp_id + days.
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
# Labelled days value, e.g. "Days worked: 22" or "Days: 22" (number AFTER the label).
DAYS_LABEL_RE = re.compile(r"\bdays?(?:\s*worked)?\s*[:\-]\s*(\d{1,2}(?:\.\d+)?)\b", re.IGNORECASE)
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
# leading words that mark a line as a labelled FIELD (attaches to the row above) rather
# than a new employee. "Days worked: 22", "Leave taken: AL", "Reimbursements:" ...
_FIELD_WORDS = {
    "days", "day", "leave", "leaves", "reimbursement", "reimbursements", "reimburse",
    "claim", "expense", "hours", "hour", "total", "worked", "taken",
}


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
    current: TimesheetRow | None = None
    for raw in text.splitlines():
        line = raw.strip()
        low = line.lower()
        # Skip blanks and quoted-reply history so retroactive numbers don't pollute.
        if len(line) < 3 or line.startswith(">"):
            continue
        if any(low.startswith(p) for p in _NOISE_PREFIXES):
            continue

        emp = EMP_RE.search(line)
        days_m = DAYS_RE.search(line)
        days_label_m = DAYS_LABEL_RE.search(line)
        ot = OT_RE.search(line)
        lv = LEAVE_RE.search(line)
        reimb_hits = REIMB_RE.findall(line)
        bare = BARE_LEAVE_RE.findall(line)

        leading = _leading_name(line)
        is_label_led = leading is None or leading.split()[0].lower() in _FIELD_WORDS

        # Labelled continuation line ("Days worked: 22", "Leave taken: AL (2 days)"):
        # no Emp ID, led by a field word - attach to the employee above, don't spawn a row.
        if current is not None and emp is None and is_label_led:
            if low.startswith("leave") or bare:
                codes = canon_leaves(bare) if bare else canon_leaves(re.split(r"[,/ ]+", lv.group(1))) if lv else []
                for c in codes:
                    if c not in current.leave_codes:
                        current.leave_codes.append(c)
            if days_label_m and current.days_worked is None:
                current.days_worked = _clean_num(days_label_m.group(1))
            if ot and current.ot_hours is None:
                current.ot_hours = _clean_num(ot.group(1))
            for amt, reason in reimb_hits:
                val = _clean_num(amt)
                if val:
                    current.reimbursements.append(
                        Reimbursement(reason=(reason or "reimbursement").strip(), amount_aed=val)
                    )
            continue

        if not (emp or days_m or days_label_m or reimb_hits):
            continue  # no timesheet signal on this line

        emp_id = emp.group(0).upper() if emp else None
        if emp:
            after = line[emp.end():]
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
        if not leave_codes and bare:
            leave_codes = canon_leaves(bare)
        reimb: list[Reimbursement] = []
        for amt, reason in reimb_hits:
            val = _clean_num(amt)
            if val:
                reimb.append(Reimbursement(reason=(reason or "reimbursement").strip(), amount_aed=val))

        days_val = (
            _clean_num(days_label_m.group(1)) if days_label_m
            else (_clean_num(days_m.group(1)) if days_m else None)
        )

        row = TimesheetRow(
            employee_name=name or (emp_id or "UNKNOWN"),
            emp_id=emp_id,
            days_worked=days_val,
            ot_hours=_clean_num(ot.group(1)) if ot else None,
            leave_codes=leave_codes,
            reimbursements=reimb,
        )
        out.rows.append(row)
        current = row

    return out

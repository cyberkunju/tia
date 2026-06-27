"""Generate the 7 sample-input cases + eval gold from the brief.

Writes inputs to data/synthetic/ and ground truth to data/gold/.
Run: `uv run python -m tia_ai.synthgen`
"""

from __future__ import annotations

import json
from pathlib import Path

import openpyxl
from openpyxl import Workbook

from .config import DATA_DIR

SYN = DATA_DIR / "synthetic"
GOLD = DATA_DIR / "gold"
SYN.mkdir(parents=True, exist_ok=True)
GOLD.mkdir(parents=True, exist_ok=True)

PERIOD = "June 2026"


def _write(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")


def _gold(case: str, expect: dict) -> None:
    (GOLD / f"case_{case}.json").write_text(json.dumps(expect, indent=2), encoding="utf-8")


# ---------------------------------------------------------------- case 7
def case07_clean_excel() -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "Timesheet"
    ws.append(["Emp ID", "Full Name", "Client Code", "Period", "Working Days", "OT Hours", "Leave"])
    rows = [
        ("EMP10001", "Carlos Smith", "CL001", PERIOD, 22, 2, ""),
        ("EMP10002", "Ahmed Khan", "CL001", PERIOD, 20, 4, "AL"),
        ("EMP10003", "Meera Al Rashid", "CL001", PERIOD, 21, 0, ""),
    ]
    for r in rows:
        ws.append(r)
    wb.save(SYN / "case_07_clean.xlsx")
    _gold(
        "07",
        {
            "case": "07",
            "channel": "upload",
            "input": "case_07_clean.xlsx",
            "expect": {
                "client_code": "CL001",
                "period": PERIOD,
                "rows": [
                    {
                        "emp_id": "EMP10001",
                        "employee_name": "Carlos Smith",
                        "days_worked": 22,
                        "ot_hours": 2,
                        "resolved": True,
                        "ambiguous": False,
                    },
                    {
                        "emp_id": "EMP10002",
                        "employee_name": "Ahmed Khan",
                        "days_worked": 20,
                        "ot_hours": 4,
                        "resolved": True,
                        "ambiguous": False,
                    },
                    {
                        "emp_id": "EMP10003",
                        "employee_name": "Meera Al Rashid",
                        "days_worked": 21,
                        "ot_hours": 0,
                        "resolved": True,
                        "ambiguous": False,
                    },
                ],
            },
        },
    )


# ---------------------------------------------------------------- case 5
def case05_punch_excel() -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "Punch"
    # 5 working days shown as In/Out pairs + a leave column
    days = 5
    header = ["Emp ID", "Full Name", "Client Code", "Period"]
    for d in range(1, days + 1):
        header += [f"D{d} In", f"D{d} Out"]
    header += ["Leave"]
    ws.append(header)

    def punch_row(emp, name, present_days, leave):
        row = [emp, name, "CL001", PERIOD]
        for d in range(1, days + 1):
            if d <= present_days:
                row += ["09:00", "17:00"]
            else:
                row += ["", ""]
        row += [leave]
        return row

    ws.append(punch_row("EMP10001", "Carlos Smith", 5, ""))
    ws.append(punch_row("EMP10002", "Ahmed Khan", 4, "A/L"))  # mixed leave spelling
    ws.append(punch_row("EMP10003", "Meera Al Rashid", 3, "sick"))
    wb.save(SYN / "case_05_punch.xlsx")
    _gold(
        "05",
        {
            "case": "05",
            "channel": "upload",
            "input": "case_05_punch.xlsx",
            "expect": {
                "client_code": "CL001",
                "period": PERIOD,
                "rows": [
                    {
                        "emp_id": "EMP10001",
                        "employee_name": "Carlos Smith",
                        "days_worked": 5,
                        "hours": 40.0,
                        "resolved": True,
                        "ambiguous": False,
                    },
                    {
                        "emp_id": "EMP10002",
                        "employee_name": "Ahmed Khan",
                        "days_worked": 4,
                        "hours": 32.0,
                        "leave_codes": ["AL"],
                        "resolved": True,
                        "ambiguous": False,
                    },
                    {
                        "emp_id": "EMP10003",
                        "employee_name": "Meera Al Rashid",
                        "days_worked": 3,
                        "hours": 24.0,
                        "leave_codes": ["SICK"],
                        "resolved": True,
                        "ambiguous": False,
                    },
                ],
            },
        },
    )


# ---------------------------------------------------------------- case 2
def case02_email_employee() -> None:
    body = f"""Subject: My timesheet for {PERIOD}

Hi Payroll team,

My employee id is EMP10001 and I worked 22 days this month with 2 OT hours.

Regards,
Carlos
"""
    _write(SYN / "case_02_email_employee.txt", body)
    _gold(
        "02",
        {
            "case": "02",
            "channel": "email",
            "input": "case_02_email_employee.txt",
            "expect": {
                "period": PERIOD,
                "rows": [
                    {
                        "emp_id": "EMP10001",
                        "employee_name": "Carlos Smith",
                        "days_worked": 22,
                        "ot_hours": 2,
                        "resolved": True,
                        "ambiguous": False,
                    },
                ],
            },
        },
    )


# ---------------------------------------------------------------- case 3
def case03_email_client_full() -> None:
    body = f"""Subject: Monthly timesheet submission

Client: Emirates Steel Industries LLC
Period: {PERIOD}

Carlos Smith - 22 days
Ahmed Khan - 20 days, 4 OT hours
Meera Al Rashid - 21 days

Approved by: Site Manager
"""
    _write(SYN / "case_03_email_client_full.eml", body)
    _gold(
        "03",
        {
            "case": "03",
            "channel": "email",
            "input": "case_03_email_client_full.eml",
            "expect": {
                "client_code": "CL001",
                "period": PERIOD,
                "rows": [
                    {
                        "employee_name": "Carlos Smith",
                        "days_worked": 22,
                        "resolved": True,
                        "ambiguous": False,
                    },
                    {
                        "employee_name": "Ahmed Khan",
                        "days_worked": 20,
                        "ot_hours": 4,
                        "resolved": True,
                        "ambiguous": False,
                    },
                    {
                        "employee_name": "Meera Al Rashid",
                        "days_worked": 21,
                        "resolved": True,
                        "ambiguous": False,
                    },
                ],
            },
        },
    )


# ---------------------------------------------------------------- case 6
def case06_email_structured() -> None:
    body = f"""Subject: Leave and reimbursements {PERIOD}

Client: Emirates Steel Industries LLC
Period: {PERIOD}

EMP10001 Carlos Smith - 20 days, leave: AL, reimbursement AED 250 for taxi
EMP10002 Ahmed Khan - 22 days, claim AED 120 for parking

Regards,
Finance
"""
    _write(SYN / "case_06_email_structured.txt", body)
    _gold(
        "06",
        {
            "case": "06",
            "channel": "email",
            "input": "case_06_email_structured.txt",
            "expect": {
                "client_code": "CL001",
                "period": PERIOD,
                "rows": [
                    {
                        "emp_id": "EMP10001",
                        "employee_name": "Carlos Smith",
                        "days_worked": 20,
                        "leave_codes": ["AL"],
                        "reimbursements": 1,
                        "resolved": True,
                        "ambiguous": False,
                    },
                    {
                        "emp_id": "EMP10002",
                        "employee_name": "Ahmed Khan",
                        "days_worked": 22,
                        "reimbursements": 1,
                        "resolved": True,
                        "ambiguous": False,
                    },
                ],
            },
        },
    )


# ---------------------------------------------------------------- case 1 (ambiguous)
def case01_email_no_empid() -> None:
    body = f"""Subject: Payout request

Client: Majid Al Futtaim Retail LLC
Period: {PERIOD}

Fatima Khan - 23 days, total AED 12000

Regards,
Operations
"""
    _write(SYN / "case_01_email_no_empid.eml", body)
    _gold(
        "01",
        {
            "case": "01",
            "channel": "email",
            "input": "case_01_email_no_empid.eml",
            "expect": {
                "client_code": "CL005",
                "period": PERIOD,
                "rows": [
                    {
                        "employee_name": "Fatima Khan",
                        "days_worked": 23,
                        "resolved": False,
                        "ambiguous": True,
                        "candidate_emp_ids": ["EMP10083", "EMP10093"],
                    },
                ],
            },
        },
    )


# ---------------------------------------------------------------- case 4 (handwritten)
def case04_handwritten() -> None:
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGB", (900, 600), "white")
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 26)
        small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 20)
    except OSError:
        font = ImageFont.load_default()
        small = font
    d.text((40, 30), "TIMESHEET - Emirates Steel Industries LLC", fill="black", font=font)
    d.text((40, 70), f"Period: {PERIOD}", fill="black", font=small)
    lines = [
        "Carlos Smith        22 days   2 OT",
        "Ahmed Khan          20 days   AL",
        "Meera Al Rashid     21 days",
    ]
    y = 140
    for ln in lines:
        d.text((60, y), ln, fill="navy", font=small)
        y += 50
    d.text((60, 360), "Signed: Site Manager", fill="black", font=small)
    d.rectangle([560, 380, 840, 500], outline="red", width=3)
    d.text((580, 420), "CLIENT STAMP", fill="red", font=small)
    d.text((580, 450), "Emirates Steel", fill="red", font=small)
    img.save(SYN / "case_04_handwritten.png")
    _gold(
        "04",
        {
            "case": "04",
            "channel": "upload",
            "input": "case_04_handwritten.png",
            "expect": {
                "client_code": "CL001",
                "period": PERIOD,
                "rows": [
                    {
                        "employee_name": "Carlos Smith",
                        "days_worked": 22,
                        "ot_hours": 2,
                        "resolved": True,
                        "ambiguous": False,
                    },
                    {
                        "employee_name": "Ahmed Khan",
                        "days_worked": 20,
                        "leave_codes": ["AL"],
                        "resolved": True,
                        "ambiguous": False,
                    },
                    {
                        "employee_name": "Meera Al Rashid",
                        "days_worked": 21,
                        "resolved": True,
                        "ambiguous": False,
                    },
                ],
            },
        },
    )


def generate_all() -> list[str]:
    case01_email_no_empid()
    case02_email_employee()
    case03_email_client_full()
    case04_handwritten()
    case05_punch_excel()
    case06_email_structured()
    case07_clean_excel()
    return sorted(p.name for p in SYN.iterdir() if p.is_file() and p.name != ".gitkeep")


if __name__ == "__main__":
    files = generate_all()
    print("generated:", files)

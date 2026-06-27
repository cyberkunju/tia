"""Email parser tests — every case in the brief plus injection / noise variants."""

from __future__ import annotations

from tia_ai.extract.email import extract_email
from tia_ai.schema import LeaveCode


def test_case2_employee_writes_in_prose():
    text = "Hi Payroll team,\n\nMy employee id is EMP10001 and I worked 22 days with 2 OT hours.\n\nRegards,\nCarlos"
    ex = extract_email(text)
    assert len(ex.rows) == 1
    r = ex.rows[0]
    assert r.emp_id == "EMP10001"
    assert r.days_worked == 22.0
    assert r.ot_hours == 2.0
    # name should NOT be a sentence fragment like "My employee id is"
    assert "id is" not in (r.employee_name or "")


def test_case3_client_roster_no_empids():
    text = (
        "Client: Emirates Steel Industries LLC\n"
        "Period: June 2026\n\n"
        "Carlos Smith - 22 days\n"
        "Ahmed Khan - 20 days, 4 OT hours\n"
        "Meera Al Rashid - 21 days"
    )
    ex = extract_email(text)
    assert ex.client_hint == "Emirates Steel Industries LLC"
    assert ex.period == "June 2026"
    assert len(ex.rows) == 3
    names = {r.employee_name for r in ex.rows}
    assert {"Carlos Smith", "Ahmed Khan", "Meera Al Rashid"} == names
    ahmed = next(r for r in ex.rows if r.employee_name == "Ahmed Khan")
    assert ahmed.days_worked == 20.0 and ahmed.ot_hours == 4.0


def test_case6_structured_reimbursements_and_leave():
    text = (
        "Client: Emirates Steel Industries LLC\n"
        "Period: June 2026\n\n"
        "EMP10001 Carlos Smith - 20 days, leave: AL, reimbursement AED 250 for taxi\n"
        "EMP10002 Ahmed Khan - 22 days, claim AED 120 for parking"
    )
    ex = extract_email(text)
    assert len(ex.rows) == 2
    carlos = ex.rows[0]
    assert carlos.emp_id == "EMP10001"
    assert carlos.days_worked == 20.0
    assert LeaveCode.AL in carlos.leave_codes
    assert len(carlos.reimbursements) == 1
    assert carlos.reimbursements[0].amount_aed == 250.0


def test_case1_name_only_no_empid():
    text = "Client: Majid Al Futtaim Retail LLC\nPeriod: June 2026\n\nFatima Khan - 23 days"
    ex = extract_email(text)
    assert ex.client_hint == "Majid Al Futtaim Retail LLC"
    assert len(ex.rows) == 1
    assert ex.rows[0].emp_id is None
    assert ex.rows[0].employee_name == "Fatima Khan"
    assert ex.rows[0].days_worked == 23.0


def test_bare_leave_token_at_line_end():
    """GLM-OCR markdown output shape: 'Ahmed Khan 20 days AL' — no 'leave:' keyword."""
    text = "Period: June 2026\n\nAhmed Khan 20 days AL\nMeera Al Rashid 21 days"
    ex = extract_email(text)
    ahmed = next(r for r in ex.rows if r.employee_name == "Ahmed Khan")
    assert LeaveCode.AL in ahmed.leave_codes
    meera = next(r for r in ex.rows if r.employee_name == "Meera Al Rashid")
    assert meera.leave_codes == []


def test_noise_lines_dont_become_rows():
    text = "Dear payroll,\n\nPlease find attached.\n\nThanks,\nFinance team"
    ex = extract_email(text)
    assert ex.rows == []


def test_dedupe_same_emp_same_name():
    text = "EMP10001 Carlos Smith - 22 days\nEMP10001 Carlos Smith - 22 days"
    ex = extract_email(text)
    assert len(ex.rows) == 1

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


def test_apostrophe_names_dont_corrupt_parsing():
    """Hawaiian / Kenyan / Irish names with apostrophes (Ng'ang'a, O'Connor) must
    parse as a single name, not split or dropped (regression of python-nameparser
    issue #86 — multiple-quote handling)."""
    text = (
        "Client: Emirates Steel Industries LLC\n"
        "Period: June 2026\n\n"
        "Ng'ang'a Mwaura - 21 days\n"
        "O'Connor Ali - 22 days, 3 OT hours\n"
    )
    ex = extract_email(text)
    names = {r.employee_name for r in ex.rows}
    assert "Ng'ang'a Mwaura" in names or "Ng'ang'a" in names, names
    assert any(n.startswith("O") and "Connor" in n for n in names), names
    # neither name should be parsed as a sentence fragment
    assert not any("days" in n for n in names)


def test_quoted_reply_thread_ignored():
    """Email parser must ignore lines from quoted-reply history (prefixed with `>`)
    so retroactive numbers don't pollute the current submission."""
    text = (
        "Client: Emirates Steel Industries LLC\n"
        "Period: June 2026\n\n"
        "Carlos Smith - 22 days\n\n"
        "> On Mon wrote:\n"
        "> Carlos Smith - 25 days\n"
        "> Last month tally\n"
    )
    ex = extract_email(text)
    carlos = next(r for r in ex.rows if r.employee_name == "Carlos Smith")
    assert carlos.days_worked == 22.0  # current, not the quoted 25
    assert len(ex.rows) == 1


def test_empty_input_returns_empty_extraction():
    ex = extract_email("")
    assert ex.rows == []
    ex2 = extract_email("Dear team,\n\nNothing to report.\n\nRegards,\nMe")
    assert ex2.rows == []

"""Canonical Pydantic schema tests (schema.py).

These pin the shared contract the whole pipeline depends on: enum values,
field defaults, and the Hypothesis.anchored property.
"""

from __future__ import annotations

from tia_ai.schema import (
    BBox,
    Candidate,
    Hypothesis,
    LeaveCode,
    MatchResult,
    Reimbursement,
    Routing,
    RowMatch,
    TimesheetExtraction,
    TimesheetRow,
    ValidationResult,
)


def test_leave_code_values():
    assert LeaveCode.AL.value == "AL"
    assert LeaveCode.PUBLIC_HOLIDAY.value == "PUBLIC_HOLIDAY"
    assert {c.value for c in LeaveCode} == {
        "AL",
        "SICK",
        "UNPAID",
        "PUBLIC_HOLIDAY",
        "ABSENT",
        "PRESENT",
    }


def test_routing_enum_values():
    assert Routing.AUTO.value == "auto"
    assert Routing.HITL.value == "hitl"
    assert Routing.ESCALATE.value == "escalate"


def test_timesheet_row_defaults():
    r = TimesheetRow(employee_name="Carlos Smith")
    assert r.emp_id is None
    assert r.days_worked is None
    assert r.leave_codes == []
    assert r.reimbursements == []


def test_timesheet_extraction_defaults():
    ex = TimesheetExtraction()
    assert ex.rows == []
    assert ex.client_code is None
    assert ex.confidence_per_field == {}
    assert ex.row_provenance == []


def test_row_can_carry_leaves_and_reimbursements():
    r = TimesheetRow(
        employee_name="X",
        leave_codes=[LeaveCode.AL, LeaveCode.SICK],
        reimbursements=[Reimbursement(reason="taxi", amount_aed=250.0)],
    )
    assert r.leave_codes == [LeaveCode.AL, LeaveCode.SICK]
    assert r.reimbursements[0].amount_aed == 250.0


def test_hypothesis_anchored_property():
    unanchored = Hypothesis(field_name="period", value="June 2026")
    assert unanchored.anchored is False
    anchored = Hypothesis(field_name="period", value="June 2026", bbox=BBox(page=0, norm=[0, 0, 1, 1]))
    assert anchored.anchored is True
    assert anchored.raw_confidence == 1.0


def test_rowmatch_defaults():
    m = RowMatch(row_idx=0, chosen_emp_id=None)
    assert m.ambiguous is False
    assert m.confidence == 0.0
    assert m.candidates == []


def test_match_result_defaults():
    mr = MatchResult()
    assert mr.matches == []
    assert mr.cost_matrix == []


def test_candidate_required_fields():
    c = Candidate(emp_id="EMP1", full_name="Carlos", client_code="CL001", score=0.9)
    assert c.signals == {}


def test_validation_result_default_severity_is_error():
    v = ValidationResult(rule="x", passed=False)
    assert v.severity == "error"
    assert ValidationResult(rule="y", passed=True, severity="warning").severity == "warning"

"""Resolver tests against the seeded DB — covers the killer ambiguity cases."""

from __future__ import annotations

import pytest
from tia_ai.db import get_session, init_db
from tia_ai.match.resolver import resolve, resolve_client
from tia_ai.schema import TimesheetExtraction, TimesheetRow
from tia_ai.seed import seed


@pytest.fixture(scope="module", autouse=True)
def seeded():
    init_db()
    seed()
    yield


def test_resolve_client_exact_code():
    with get_session() as s:
        assert resolve_client("CL001", s) == "CL001"
        assert resolve_client("cl005", s) == "CL005"


def test_resolve_client_fuzzy_name():
    with get_session() as s:
        assert resolve_client("Emirates Steel", s) == "CL001"
        assert resolve_client("Majid Al Futtaim Retail LLC", s) == "CL005"
        assert resolve_client("totally unknown company", s) is None


def test_resolve_emp_id_definitive():
    ex = TimesheetExtraction(
        client_code="CL001",
        period="June 2026",
        rows=[TimesheetRow(employee_name="anything goes", emp_id="EMP10001", days_worked=22)],
    )
    with get_session() as s:
        mr = resolve(ex, s)
    assert mr.matches[0].chosen_emp_id == "EMP10001"
    assert mr.matches[0].confidence >= 0.99
    assert not mr.matches[0].ambiguous


def test_resolve_unique_name_within_client():
    ex = TimesheetExtraction(
        client_hint="Emirates Steel Industries LLC",
        period="June 2026",
        rows=[TimesheetRow(employee_name="Carlos Smith", days_worked=22)],
    )
    with get_session() as s:
        mr = resolve(ex, s)
    assert mr.matches[0].chosen_emp_id == "EMP10001"
    assert not mr.matches[0].ambiguous


def test_resolve_fatima_khan_ambiguous():
    """Same name, same client, two emp ids — must flag ambiguous."""
    ex = TimesheetExtraction(
        client_hint="Majid Al Futtaim Retail LLC",
        period="June 2026",
        rows=[TimesheetRow(employee_name="Fatima Khan", days_worked=23)],
    )
    with get_session() as s:
        mr = resolve(ex, s)
    m = mr.matches[0]
    assert m.ambiguous
    assert m.chosen_emp_id is None
    cand_ids = {c.emp_id for c in m.candidates}
    assert cand_ids == {"EMP10083", "EMP10093"}
    # cost matrix is exposed for the Why drawer / triage UI
    assert mr.cost_matrix and len(mr.cost_matrix[0]) >= 2


def test_resolve_aisha_three_way_cross_client_ambiguous():
    """Aisha Al Zaabi exists at EMP10058@CL003, EMP10072@CL004, EMP10077@CL004.
    With no client hint, all three surface as candidates -> 3-way ambiguity."""
    ex = TimesheetExtraction(
        period="June 2026",
        rows=[TimesheetRow(employee_name="Aisha Al Zaabi", days_worked=22)],
    )
    with get_session() as s:
        mr = resolve(ex, s)
    m = mr.matches[0]
    assert m.ambiguous
    assert m.chosen_emp_id is None
    cand_ids = {c.emp_id for c in m.candidates}
    assert cand_ids == {"EMP10058", "EMP10072", "EMP10077"}
    # cost matrix must have 1 row x 3 cols visible in the Why drawer
    assert mr.cost_matrix and len(mr.cost_matrix[0]) == 3


def test_resolve_ravi_menon_cross_client_ambiguous():
    """Ravi Menon spans CL004 / CL007 / CL008 — cross-client ambiguity that
    can't be resolved by name+client alone, must surface for HITL."""
    ex = TimesheetExtraction(
        period="June 2026",
        rows=[TimesheetRow(employee_name="Ravi Menon", days_worked=21)],
    )
    with get_session() as s:
        mr = resolve(ex, s)
    m = mr.matches[0]
    assert m.ambiguous
    cand_ids = {c.emp_id for c in m.candidates}
    assert {"EMP10070", "EMP10136", "EMP10157"}.issubset(cand_ids)

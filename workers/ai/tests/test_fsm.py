"""Invoice FSM tests - the legal-transition guard that keeps invoice.status honest.

Without the FSM, status is a free string and an invoice could go
dispatched→generated or rejected→dispatched. These assert the exact transition
table in tia_ai/invoice/fsm.py plus the set_status DB writer.
"""

from __future__ import annotations

import uuid

import pytest

from tia_ai.db import SessionLocal
from tia_ai.invoice.fsm import (
    ALLOWED,
    LABELS,
    PRE_DISPATCH_STATES,
    InvalidTransition,
    assert_transition,
    set_status,
)
from tia_ai.models import Invoice


# ── legal transitions ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "current,target",
    [
        ("generated", "finance_approved"),
        ("generated", "client_approved"),
        ("generated", "rejected"),
        ("generated", "voided"),
        ("finance_approved", "client_approved"),
        ("finance_approved", "voided"),
        ("client_approved", "dispatched"),
        ("client_approved", "voided"),
        ("client_rejected", "generated"),  # reissue path
        ("dispatched", "superseded"),
        ("dispatched", "voided"),
        ("rejected", "voided"),
    ],
)
def test_legal_transitions_pass(current, target):
    assert_transition(current, target)  # must not raise


# ── illegal transitions ──────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "current,target",
    [
        ("dispatched", "generated"),
        ("rejected", "dispatched"),
        ("client_rejected", "dispatched"),
        ("voided", "dispatched"),
        ("superseded", "generated"),
        ("client_approved", "finance_approved"),  # can't walk backwards
        ("finance_approved", "dispatched"),  # must go through client_approved
    ],
)
def test_illegal_transitions_raise(current, target):
    with pytest.raises(InvalidTransition) as ei:
        assert_transition(current, target)
    # the error carries the offending pair for audit logging
    assert ei.value.current == current
    assert ei.value.target == target
    assert current in str(ei.value) and target in str(ei.value)


def test_same_state_is_idempotent():
    # same → same is silently allowed (no exception) for every known state
    for st in ALLOWED:
        assert_transition(st, st)


def test_pending_client_review_is_treated_as_generated():
    # the UI sub-state normalises onto 'generated' so it inherits generated's legal set
    assert_transition("pending_client_review", "client_approved")
    assert_transition("pending_client_review", "finance_approved")
    # and it cannot jump straight to dispatched (generated can't either)
    with pytest.raises(InvalidTransition):
        assert_transition("pending_client_review", "dispatched")


def test_unknown_current_state_does_not_block():
    # back-compat: an unrecognised current status is not enforced
    assert_transition("some_legacy_state", "dispatched")


def test_terminal_states_have_no_exits():
    assert ALLOWED["voided"] == set()
    assert ALLOWED["superseded"] == set()


def test_pre_dispatch_states_constant():
    # the void-vs-credit-note decision keys off this set
    assert "generated" in PRE_DISPATCH_STATES
    assert "client_approved" in PRE_DISPATCH_STATES
    assert "dispatched" not in PRE_DISPATCH_STATES


def test_labels_cover_every_state():
    for st in ALLOWED:
        assert st in LABELS and LABELS[st]


# ── set_status (DB writer) ───────────────────────────────────────────────────


def test_set_status_persists_and_returns_prev():
    s = SessionLocal()
    try:
        inv = Invoice(
            id=str(uuid.uuid4()),
            timesheet_id=f"fsm-test:{uuid.uuid4()}",
            client_code="CL001",
            amount=100.0,
            status="generated",
        )
        s.add(inv)
        s.flush()
        prev = set_status(s, inv, "client_approved")
        assert prev == "generated"
        assert inv.status == "client_approved"
    finally:
        s.rollback()
        s.close()


def test_set_status_blocks_illegal_and_leaves_state_untouched():
    s = SessionLocal()
    try:
        inv = Invoice(
            id=str(uuid.uuid4()),
            timesheet_id=f"fsm-test:{uuid.uuid4()}",
            client_code="CL001",
            amount=100.0,
            status="dispatched",
        )
        s.add(inv)
        s.flush()
        with pytest.raises(InvalidTransition):
            set_status(s, inv, "generated")
        # the model row keeps its original status after a blocked transition
        assert inv.status == "dispatched"
    finally:
        s.rollback()
        s.close()

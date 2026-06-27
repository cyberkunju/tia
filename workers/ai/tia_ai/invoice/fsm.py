"""Invoice state machine — enforces legal status transitions.

Without this, status is a free-form string and nothing prevents an invoice from
going `dispatched → generated` or `rejected → dispatched`. Real-product AP
systems all run on FSMs — this keeps our flow honest.

States:
  generated          — invoice rendered, awaiting next gate
  finance_approved   — passed Finance threshold check (only when amount > threshold)
  client_approved    — client signed off via /client-approve (or auto-dispatch fast path)
  client_rejected    — client raised a query / refused; awaiting correction
  dispatched         — Rust service wrote outbox + audit event
  rejected           — terminal "never going out" (FinOps decision or void)
  voided             — terminal: invoice was created in error (pre-dispatch clawback)
  superseded         — terminal: replaced by a reissued invoice (replaces_invoice_id chain)

Clawback (real-product AR semantics):
  - Pre-dispatch (generated / pending_client_review / client_approved / finance_approved)
    → VOID (status=voided): invoice never existed, AR reversal
  - Dispatched + no payment → CREDIT NOTE: invoice stays "dispatched", a credit-note
    record is attached (credit_note_*) and rendered as page 2 of the PDF.
    Status moves to "superseded" only when a corrected invoice replaces it.
  - Dispatched + paid → CREDIT NOTE + payment_refund_required event.
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import Invoice

ALLOWED: dict[str, set[str]] = {
    "generated": {"finance_approved", "client_approved", "rejected", "voided"},
    "finance_approved": {"client_approved", "rejected", "voided"},
    "client_approved": {"dispatched", "voided"},
    "client_rejected": {"generated", "voided"},
    "dispatched": {"superseded", "voided"},  # voided rarely; superseded after a reissue
    "rejected": {"voided"},
    "voided": set(),
    "superseded": set(),
}

# Friendly labels for the UI
LABELS: dict[str, str] = {
    "generated": "Generated",
    "finance_approved": "Finance approved",
    "pending_client_review": "Pending client approval",
    "client_approved": "Client approved",
    "client_rejected": "Client rejected",
    "dispatched": "Dispatched",
    "rejected": "Rejected",
    "voided": "Voided",
    "superseded": "Superseded (reissued)",
}

# Pre-dispatch states — clawback in any of these is a VOID, not a credit note.
PRE_DISPATCH_STATES: set[str] = {
    "generated",
    "pending_client_review",
    "finance_approved",
    "client_approved",
    "client_rejected",
}


class InvalidTransition(ValueError):
    """Raised when a status transition isn't allowed by the FSM."""

    def __init__(self, current: str, target: str):
        super().__init__(f"cannot transition invoice from '{current}' → '{target}'")
        self.current = current
        self.target = target


def assert_transition(current: str, target: str) -> None:
    """Raise InvalidTransition if `current → target` isn't allowed.

    Special cases:
      - same-state writes are silently allowed (idempotent)
      - 'pending_client_review' is a sub-state of 'generated' / 'finance_approved';
        we use it on the client UI side but the underlying invoice.status sits in
        the legal set — so we don't enforce it here.
    """
    if current == target:
        return  # idempotent — allowed
    current_norm = "generated" if current == "pending_client_review" else current
    target_norm = "generated" if target == "pending_client_review" else target
    if current_norm not in ALLOWED:
        return  # unknown current state — don't block (back-compat)
    if target_norm not in ALLOWED[current_norm]:
        raise InvalidTransition(current, target)


def set_status(session: Session, invoice: Invoice, target: str) -> str:
    """Transition + persist. Returns the previous status for audit logging.

    Caller is responsible for writing the audit event with before/after.
    """
    prev = invoice.status
    assert_transition(prev, target)
    invoice.status = target
    session.flush()
    return prev


def _demo() -> None:
    """Self-check the transition table — runs offline (no DB)."""
    # legal
    assert_transition("generated", "finance_approved")
    assert_transition("generated", "client_approved")
    assert_transition("finance_approved", "client_approved")
    assert_transition("client_approved", "dispatched")
    assert_transition("client_rejected", "generated")  # reissue path
    # idempotent
    assert_transition("dispatched", "dispatched")
    # illegal
    for current, target in [
        ("dispatched", "generated"),
        ("rejected", "dispatched"),
        ("client_rejected", "dispatched"),
        ("voided", "dispatched"),
    ]:
        try:
            assert_transition(current, target)
        except InvalidTransition:
            pass
        else:
            raise AssertionError(f"transition {current}->{target} should have been blocked")
    print("invoice FSM: all transition assertions passed")


if __name__ == "__main__":
    _demo()

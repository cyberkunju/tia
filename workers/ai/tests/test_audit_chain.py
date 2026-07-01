"""Tamper-evident audit chain (audit.py + orchestrator.log_event).

Asserts the hash chain links correctly across appended events, that
verify_audit_chain reports a clean chain, and that any mutation to a historical
event's payload is detected as a hash_mismatch.
"""

from __future__ import annotations

import uuid

from tia_ai.audit import _recompute_hash, verify_audit_chain
from tia_ai.db import SessionLocal
from tia_ai.models import Event
from tia_ai.orchestrator import log_event


def test_recompute_hash_is_deterministic_and_payload_sensitive():
    e = Event(
        id="x",
        actor="tester",
        entity_kind="invoice",
        entity_id="inv-1",
        action="generated",
        payload={"amount": 100},
        prev_hash=None,
    )
    h1 = _recompute_hash(e)
    h2 = _recompute_hash(e)
    assert h1 == h2
    e.payload = {"amount": 101}
    assert _recompute_hash(e) != h1  # any payload change moves the hash


def test_chain_links_prev_hash_to_previous_hash():
    s = SessionLocal()
    try:
        a = log_event(s, "tester", "system", f"chain-{uuid.uuid4()}", "step.a", {"n": 1})
        b = log_event(s, "tester", "system", f"chain-{uuid.uuid4()}", "step.b", {"n": 2})
        s.flush()
        # b's prev_hash must equal a's hash (append-only linkage)
        assert b.prev_hash == a.hash
        assert b.hash == _recompute_hash(b)
    finally:
        s.rollback()
        s.close()


def test_verify_clean_chain_reports_ok():
    s = SessionLocal()
    try:
        log_event(s, "tester", "system", f"ok-{uuid.uuid4()}", "step.ok", {"n": 1})
        s.commit()
        report = verify_audit_chain(s)
        assert report["ok"] is True
        assert report["errors"] == []
        assert report["total"] >= 1
        assert report["head"]  # publishable chain head
    finally:
        s.close()


def test_tamper_is_detected_as_hash_mismatch():
    s = SessionLocal()
    try:
        # ensure there is at least one event to tamper with
        log_event(s, "tester", "system", f"tamper-{uuid.uuid4()}", "step.t", {"n": 1})
        s.commit()
        ev = s.query(Event).order_by(Event.at.desc()).first()
        assert ev is not None
        # mutate payload WITHOUT recomputing the stored hash → tamper
        ev.payload = {**(ev.payload or {}), "_injected": "evil"}
        s.flush()  # visible to verify within this session
        report = verify_audit_chain(s)
        assert report["ok"] is False
        assert any(e["kind"] == "hash_mismatch" and e["event_id"] == ev.id for e in report["errors"])
    finally:
        s.rollback()  # never persist the tamper
        s.close()

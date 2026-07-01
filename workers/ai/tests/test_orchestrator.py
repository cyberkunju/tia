"""Orchestrator edge cases (orchestrator.py).

Covers the pieces the API-level tests don't isolate:
  - log_event idempotency replay (same key → same row, chain not re-extended)
  - ingest_file content-hash dedup keyed on the (content_hash, channel, uploaded_by)
    composite - different channel / uploader is NOT a dedup hit
  - process_doc routing decisions (clean → auto, empty → escalate)
  - _maybe_auto_dispatch tolerance gate (under-threshold + clean → dispatched,
    over-threshold or blocking rule → stays 'generated')

All DB work runs in a rolled-back session so it never pollutes the shared DB.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from tia_ai.config import DATA_DIR, STAGING_DIR
from tia_ai.db import SessionLocal
from tia_ai.models import Client, Event, Invoice
from tia_ai.orchestrator import (
    _maybe_auto_dispatch,
    ingest_file,
    log_event,
    process_doc,
)


@pytest.fixture()
def s():
    sess = SessionLocal()
    try:
        yield sess
    finally:
        sess.rollback()
        sess.close()


def _write_tmp(content: bytes, suffix: str) -> Path:
    p = Path(STAGING_DIR) / f"_orch_{uuid.uuid4().hex}{suffix}"
    p.write_bytes(content)
    return p


# ── log_event idempotency ─────────────────────────────────────────────────────


def test_log_event_idempotency_replay_returns_same_row(s):
    key = f"idem-{uuid.uuid4()}"
    a = log_event(s, "tester", "system", f"e-{uuid.uuid4()}", "step", {"n": 1}, idempotency_key=key)
    before = s.query(Event).count()
    b = log_event(s, "tester", "system", f"e-{uuid.uuid4()}", "step", {"n": 2}, idempotency_key=key)
    after = s.query(Event).count()
    # replay returns the ORIGINAL event and does not append a new one
    assert b.id == a.id
    assert b.payload == {"n": 1}
    assert after == before


def test_log_event_chain_links_prev_hash(s):
    a = log_event(s, "t", "system", f"c-{uuid.uuid4()}", "a", {"n": 1})
    b = log_event(s, "t", "system", f"c-{uuid.uuid4()}", "b", {"n": 2})
    assert b.prev_hash == a.hash
    assert a.hash != b.hash


# ── ingest_file dedup composite key ───────────────────────────────────────────


def test_ingest_dedup_same_composite_key_returns_same_doc(s):
    raw = f"dedup-body-{uuid.uuid4()}".encode()
    p = _write_tmp(raw, ".txt")
    d1 = ingest_file(s, p, channel="upload", mime="text/plain", uploaded_by="client")
    d2 = ingest_file(s, p, channel="upload", mime="text/plain", uploaded_by="client")
    # identical (content_hash, channel, uploaded_by) → deduped to one DocAsset
    assert d1.id == d2.id
    # the dedup was audit-logged
    assert (
        s.query(Event).filter(Event.entity_id == d1.id, Event.action == "ingest.dedup").count() >= 1
    )


def test_ingest_different_channel_is_not_a_dedup_hit(s):
    raw = f"channel-body-{uuid.uuid4()}".encode()
    p = _write_tmp(raw, ".txt")
    d_upload = ingest_file(s, p, channel="upload", mime="text/plain", uploaded_by="client")
    d_email = ingest_file(s, p, channel="email", mime="text/plain", uploaded_by="client")
    # same bytes, different channel → distinct docs (the composite key includes channel)
    assert d_upload.id != d_email.id
    assert d_upload.content_hash == d_email.content_hash


def test_ingest_different_uploader_is_not_a_dedup_hit(s):
    raw = f"uploader-body-{uuid.uuid4()}".encode()
    p = _write_tmp(raw, ".txt")
    a = ingest_file(s, p, channel="upload", mime="text/plain", uploaded_by="alice")
    b = ingest_file(s, p, channel="upload", mime="text/plain", uploaded_by="bob")
    assert a.id != b.id


def test_ingest_merges_fresh_meta_on_dedup(s):
    raw = f"meta-body-{uuid.uuid4()}".encode()
    p = _write_tmp(raw, ".eml")
    first = ingest_file(
        s, p, channel="email", uploaded_by="c", meta={"from_addr": "a@x.test", "subject": "one"}
    )
    second = ingest_file(
        s, p, channel="email", uploaded_by="c", meta={"from_addr": "b@y.test", "message_id": "m2"}
    )
    assert first.id == second.id
    # latest meta wins on the merge, older keys preserved
    assert second.meta["from_addr"] == "b@y.test"
    assert second.meta["subject"] == "one"
    assert second.meta["message_id"] == "m2"


# ── process_doc routing decisions ──────────────────────────────────────────────


def test_process_doc_clean_xlsx_routes_auto(s):
    p = DATA_DIR / "synthetic" / "case_07_clean.xlsx"
    if not p.exists():
        pytest.skip("synthetic seed data missing")
    doc = ingest_file(
        s,
        p,
        channel="upload",
        mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        uploaded_by=f"orch-{uuid.uuid4().hex[:6]}",
    )
    ts = process_doc(s, doc)
    assert ts.routing == "auto"
    assert ts.status == "invoice_generated"
    assert ts.confidence_calibrated >= 0.9
    # an invoice row was generated for this timesheet
    assert s.query(Invoice).filter(Invoice.timesheet_id == ts.id).count() == 1


def test_process_doc_empty_file_routes_escalate(s):
    p = _write_tmp(b"", ".xlsx")
    doc = ingest_file(
        s,
        p,
        channel="upload",
        mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        uploaded_by=f"orch-empty-{uuid.uuid4().hex[:6]}",
    )
    ts = process_doc(s, doc)
    assert ts.routing == "escalate"
    assert ts.status == "awaiting_review"
    assert ts.confidence_calibrated == 0.0
    assert ts.hitl_reason == "no rows extracted from document"


# ── _maybe_auto_dispatch tolerance gate ───────────────────────────────────────


def _generated_invoice(s, amount=1000.0) -> Invoice:
    inv = Invoice(
        id=str(uuid.uuid4()),
        timesheet_id=f"orch-disp:{uuid.uuid4()}",
        client_code="CL001",
        period="June 2026",
        amount=amount,
        currency="AED",
        line_items=[{"emp_id": "EMP10001", "amount": amount}],
        status="generated",
        invoice_sequence_no=f"TIA-ORCH-{uuid.uuid4().hex[:8]}",
    )
    s.add(inv)
    s.flush()
    return inv


def test_auto_dispatch_under_threshold_and_clean_rules_dispatches(s):
    inv = _generated_invoice(s, amount=1000.0)
    client = s.get(Client, "CL001")
    rules = [{"rule_id": "R7", "passed": True, "severity": "info"}]
    _maybe_auto_dispatch(s, inv, client, rules)
    assert inv.status == "dispatched"
    assert inv.dispatch_idempotency_key == f"auto:{inv.id}"
    # the tolerance-decision event carries the rationale
    ev = (
        s.query(Event)
        .filter(Event.entity_id == inv.id, Event.action == "auto_dispatched_within_tolerance")
        .first()
    )
    assert ev is not None
    assert ev.payload["amount"] <= ev.payload["threshold"]


def test_auto_dispatch_over_threshold_defers_to_finance(s):
    # amount above the 50k default threshold → stays generated (finance queue owns it)
    inv = _generated_invoice(s, amount=90000.0)
    client = s.get(Client, "CL001")
    _maybe_auto_dispatch(s, inv, client, [{"rule_id": "R7", "passed": True, "severity": "info"}])
    assert inv.status == "generated"
    assert inv.dispatch_idempotency_key is None


def test_auto_dispatch_blocking_rule_defers(s):
    inv = _generated_invoice(s, amount=1000.0)
    client = s.get(Client, "CL001")
    rules = [{"rule_id": "R1", "passed": False, "severity": "error"}]
    _maybe_auto_dispatch(s, inv, client, rules)
    assert inv.status == "generated"


def test_auto_dispatch_warning_only_still_dispatches(s):
    inv = _generated_invoice(s, amount=1000.0)
    client = s.get(Client, "CL001")
    # a warning is not a blocking failure → touchless dispatch proceeds
    rules = [
        {"rule_id": "R7", "passed": True, "severity": "info"},
        {"rule_id": "R15", "passed": True, "severity": "warning"},
    ]
    _maybe_auto_dispatch(s, inv, client, rules)
    assert inv.status == "dispatched"

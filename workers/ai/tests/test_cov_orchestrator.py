"""Remaining orchestrator branches: ingest concurrency-race dedup, process_doc
no-staged-file guard, email-body client_hint fill + parse-failure swallow,
has_failed_validation routing, auto-approval-disabled routing, and every
_maybe_auto_dispatch guard/exception path. Hermetic (rolled-back sessions)."""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from tia_ai.config import DATA_DIR, STAGING_DIR
from tia_ai.db import SessionLocal
from tia_ai.models import Client, DocAsset, Event, Invoice
from tia_ai import orchestrator as O


@pytest.fixture()
def s():
    sess = SessionLocal()
    try:
        yield sess
    finally:
        sess.rollback()
        sess.close()


def _tmp(content: bytes, suffix: str) -> Path:
    p = Path(STAGING_DIR) / f"_covorch_{uuid.uuid4().hex}{suffix}"
    p.write_bytes(content)
    return p


# ── ingest_file concurrency race → IntegrityError → dedup-hit (192-199) ────────


class _MissOnceQuery:
    """Wraps a real Query but returns None the FIRST time .first() is called,
    simulating the lost-race window where the dedup SELECT misses a row another
    worker is about to (or just did) INSERT."""

    def __init__(self, real_q, state):
        self._q = real_q
        self._state = state

    def filter_by(self, **kw):
        return _MissOnceQuery(self._q.filter_by(**kw), self._state)

    def filter(self, *a, **k):
        return _MissOnceQuery(self._q.filter(*a, **k), self._state)

    def order_by(self, *a, **k):
        return _MissOnceQuery(self._q.order_by(*a, **k), self._state)

    def first(self):
        if not self._state["missed"]:
            self._state["missed"] = True
            return None
        return self._q.first()

    def one(self):
        return self._q.one()

    def all(self):
        return self._q.all()


class _RaceSession:
    def __init__(self, real):
        self._real = real
        self._state = {"missed": False}

    def query(self, *models):
        q = self._real.query(*models)
        if models and models[0] is DocAsset:
            return _MissOnceQuery(q, self._state)
        return q

    def __getattr__(self, name):
        return getattr(self._real, name)


def test_ingest_file_integrity_race_resolves_to_winner(s):
    raw = f"race-body-{uuid.uuid4()}".encode()
    p = _tmp(raw, ".txt")
    content_hash = O._hash_file(p)
    channel, uploader = "upload", f"racer-{uuid.uuid4().hex[:6]}"
    # pre-insert the "winner" row (the other worker that won the INSERT race)
    winner = DocAsset(
        id=str(uuid.uuid4()),
        content_hash=content_hash,
        source_channel=channel,
        uploaded_by=uploader,
        staging_path=str(p),
        filename=p.name,
    )
    s.add(winner)
    s.flush()
    # now ingest the SAME (hash, channel, uploader): dedup SELECT is forced to miss,
    # the INSERT collides on the composite unique → IntegrityError → dedup-hit(winner)
    got = O.ingest_file(_RaceSession(s), p, channel=channel, uploaded_by=uploader)
    assert got.id == winner.id
    assert (
        s.query(Event).filter(Event.entity_id == winner.id, Event.action == "ingest.dedup").count()
        >= 1
    )


# ── process_doc: no staged file (223) ──────────────────────────────────────────


def test_process_doc_without_staged_file_raises(s):
    doc = DocAsset(
        id=str(uuid.uuid4()), content_hash=uuid.uuid4().hex, source_channel="upload",
        staging_path=None,
    )
    s.add(doc)
    s.flush()
    with pytest.raises(ValueError):
        O.process_doc(s, doc)


# ── process_doc: email-body fills client_hint (249) ────────────────────────────


def test_process_doc_body_fills_client_hint(s):
    csv = b"Emp ID,Full Name,Working Days,OT Hours\nEMP10001,Carlos Smith,22,5\n"
    p = _tmp(csv, ".csv")
    doc = O.ingest_file(
        s, p, channel="email", mime="text/csv",
        uploaded_by=f"covorch-{uuid.uuid4().hex[:6]}",
        meta={"email_body": "Client: ACME Steel Co", "from_addr": "a@x.test"},
    )
    O.process_doc(s, doc)
    ev = (
        s.query(Event)
        .filter(Event.entity_id == doc.id, Event.action == "extracted")
        .order_by(Event.at.desc())
        .first()
    )
    assert ev is not None
    assert ev.payload.get("client_hint") == "ACME Steel Co"  # line 249 filled it


def test_process_doc_body_parse_failure_swallowed(monkeypatch, s):
    import tia_ai.extract.email as email_mod

    csv = b"Emp ID,Full Name,Working Days,OT Hours\nEMP10001,Carlos Smith,22,5\n"
    p = _tmp(csv, ".csv")
    doc = O.ingest_file(
        s, p, channel="email", mime="text/csv",
        uploaded_by=f"covorch-{uuid.uuid4().hex[:6]}",
        meta={"email_body": "Client: ACME"},  # no period → enters body block
    )
    monkeypatch.setattr(
        email_mod, "extract_email", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
    )
    ts = O.process_doc(s, doc)  # 252-254 swallow the failure; pipeline continues
    assert ts.id


# ── process_doc: validation-failed routing (401-404) ───────────────────────────


def test_process_doc_validation_failure_routes_hitl(monkeypatch, s):
    p = DATA_DIR / "synthetic" / "case_07_clean.xlsx"
    if not p.exists():
        pytest.skip("synthetic seed missing")
    real_bi = O.build_invoice

    def fake_bi(ex, m, sess):
        inv = real_bi(ex, m, sess)
        inv["validations"] = list(inv["validations"]) + [
            {"rule": "math_net", "passed": False, "severity": "error", "message": "forced fail"}
        ]
        return inv

    monkeypatch.setattr(O, "build_invoice", fake_bi)
    doc = O.ingest_file(
        s, p, channel="upload",
        mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        uploaded_by=f"covorch-vf-{uuid.uuid4().hex[:6]}",
    )
    ts = O.process_doc(s, doc)
    assert ts.routing == "hitl"
    assert ts.hitl_reason == "validation failed"
    assert ts.confidence_calibrated == 0.5


# ── process_doc: auto-approval disabled routing (416-419) ──────────────────────


def test_process_doc_auto_approve_disabled_routes_hitl(monkeypatch, s):
    p = DATA_DIR / "synthetic" / "case_07_clean.xlsx"
    if not p.exists():
        pytest.skip("synthetic seed missing")
    monkeypatch.setattr(O, "TIA_AUTO_APPROVE", False)
    doc = O.ingest_file(
        s, p, channel="upload",
        mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        uploaded_by=f"covorch-na-{uuid.uuid4().hex[:6]}",
    )
    ts = O.process_doc(s, doc)
    assert ts.routing == "hitl"
    assert ts.hitl_reason == "manual approval required (auto-approval disabled)"
    assert ts.status == "awaiting_review"


# ── _maybe_auto_dispatch guards ────────────────────────────────────────────────


def _gen_invoice(s, amount=1000.0, status="generated") -> Invoice:
    inv = Invoice(
        id=str(uuid.uuid4()),
        timesheet_id=f"covdisp:{uuid.uuid4()}",
        client_code="CL001",
        period="June 2026",
        amount=amount,
        currency="AED",
        line_items=[{"emp_id": "EMP10001", "amount": amount}],
        status=status,
        invoice_sequence_no=f"TIA-COVD-{uuid.uuid4().hex[:8]}",
    )
    s.add(inv)
    s.flush()
    return inv


def test_auto_dispatch_non_generated_returns_early(s):
    inv = _gen_invoice(s, status="client_approved")
    O._maybe_auto_dispatch(s, inv, s.get(Client, "CL001"), [{"rule_id": "R7", "passed": True}])
    assert inv.status == "client_approved"  # untouched (567 early return)


def test_auto_dispatch_bad_threshold_falls_back_to_default(s):
    inv = _gen_invoice(s, amount=1000.0)

    class _FakeClient:
        settings = {"validation_threshold_aed": "not-a-number"}

    O._maybe_auto_dispatch(s, inv, _FakeClient(), [{"rule_id": "R7", "passed": True, "severity": "info"}])
    # bad threshold → except → default 50000 → 1000 under → dispatched (572-573)
    assert inv.status == "dispatched"


def test_auto_dispatch_rule_without_id_is_skipped(s):
    inv = _gen_invoice(s, amount=1000.0)
    # a rule dict with neither rule_id nor rule → continue (584); no blocking → dispatches
    O._maybe_auto_dispatch(s, inv, s.get(Client, "CL001"), [{"passed": True}])
    assert inv.status == "dispatched"


def test_auto_dispatch_counts_warning_rule(s):
    inv = _gen_invoice(s, amount=1000.0)
    rules = [{"rule_id": "R15", "passed": False, "severity": "warning"}]  # warned_ids (588)
    O._maybe_auto_dispatch(s, inv, s.get(Client, "CL001"), rules)
    assert inv.status == "dispatched"
    ev = (
        s.query(Event)
        .filter(Event.entity_id == inv.id, Event.action == "auto_dispatched_within_tolerance")
        .first()
    )
    assert ev.payload["rules_warned_count"] == 1


def test_auto_dispatch_client_approved_fsm_block_defers(monkeypatch, s):
    import tia_ai.invoice.fsm as fsm

    inv = _gen_invoice(s, amount=1000.0)
    monkeypatch.setattr(
        fsm, "set_status", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("fsm blocked"))
    )
    O._maybe_auto_dispatch(s, inv, s.get(Client, "CL001"), [{"rule_id": "R7", "passed": True}])
    assert inv.status == "generated"  # 603-604 return without dispatch


def test_auto_dispatch_dispatch_fsm_block_defers(monkeypatch, s):
    import tia_ai.invoice.fsm as fsm

    inv = _gen_invoice(s, amount=1000.0)
    real = fsm.set_status

    def _selective(session, invoice, target):
        if target == "dispatched":
            raise RuntimeError("cannot dispatch")
        return real(session, invoice, target)

    monkeypatch.setattr(fsm, "set_status", _selective)
    O._maybe_auto_dispatch(s, inv, s.get(Client, "CL001"), [{"rule_id": "R7", "passed": True}])
    # client_approved succeeded, dispatched raised → 643-644 return
    assert inv.status == "client_approved"


def test_auto_dispatch_email_send_failure_is_logged(monkeypatch, s):
    import tia_ai.mailbox.sender as sender

    inv = _gen_invoice(s, amount=1000.0)
    monkeypatch.setattr(
        sender, "send_invoice_email", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("smtp"))
    )
    O._maybe_auto_dispatch(s, inv, s.get(Client, "CL001"), [{"rule_id": "R7", "passed": True}])
    assert inv.status == "dispatched"
    assert (
        s.query(Event)
        .filter(Event.entity_id == inv.id, Event.action == "email.invoice_send_failed")
        .count()
        >= 1
    )

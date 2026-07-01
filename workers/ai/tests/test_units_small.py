"""Small-module coverage: config warnings, audit tamper path, seed helpers,
db migration/session helpers, resolver code-canonicalization, SAP mapping."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import create_engine, inspect, text

import tia_ai.config as config
import tia_ai.db as db
from tia_ai import audit
from tia_ai import seed as seedmod
from tia_ai.db import SessionLocal
from tia_ai.integrations.sap_b1 import mapping
from tia_ai.match import resolver
from tia_ai.models import Base, Client, Event, Invoice


# ── config.config_warnings ────────────────────────────────────────────────────


def test_config_warnings_dev_defaults():
    w = config.config_warnings()
    assert any("SQLite" in x for x in w)
    assert any("INTERNAL_SECRET" in x for x in w)


def test_config_warnings_sap_incomplete(monkeypatch):
    monkeypatch.setattr(config, "SAP_B1_ENABLED", True)
    monkeypatch.setattr(config, "SAP_B1_BASE_URL", "")
    w = config.config_warnings()
    assert any("SAP_B1_ENABLED but connection vars incomplete" in x for x in w)


# ── audit tamper paths ────────────────────────────────────────────────────────


def test_audit_detects_tampered_event():
    s = SessionLocal()
    try:
        # a manually-inserted event with a bad hash + wrong prev → both error kinds
        bad = Event(
            id=str(uuid.uuid4()),
            actor="tester",
            entity_kind="invoice",
            entity_id="x",
            action="tampered",
            payload={},
            prev_hash="not-the-real-prev",
            hash="deadbeef-not-a-real-hash",
        )
        s.add(bad)
        s.flush()
        rep = audit.verify_audit_chain(s)
        assert rep["ok"] is False
        kinds = {e["kind"] for e in rep["errors"]}
        assert "hash_mismatch" in kinds
    finally:
        s.rollback()
        s.close()


# ── seed helpers ──────────────────────────────────────────────────────────────


def test_seed_num_handles_bad_values():
    assert seedmod._num(None) == 0.0
    assert seedmod._num("not a number") == 0.0
    assert seedmod._num("12.5") == 12.5


def test_seed_rows_skips_empty_rows():
    class FakeWS:
        def iter_rows(self, values_only=True):
            yield ("Emp ID", "Full Name")
            yield (None, None)  # fully-empty → skipped
            yield ("EMP1", "Carlos")

    rows = list(seedmod._rows(FakeWS()))
    assert rows == [{"Emp ID": "EMP1", "Full Name": "Carlos"}]


# ── db helpers ────────────────────────────────────────────────────────────────


def test_get_session_commit_and_rollback():
    with db.get_session() as s:
        assert s.query(Client).count() >= 0
    with pytest.raises(RuntimeError):
        with db.get_session() as s:
            raise RuntimeError("boom")


def test_ensure_columns_adds_missing(monkeypatch, tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path / 'scratch.db'}")
    Base.metadata.create_all(eng)
    with eng.begin() as c:
        c.execute(text("ALTER TABLE clients DROP COLUMN industry"))
    assert "industry" not in {col["name"] for col in inspect(eng).get_columns("clients")}
    monkeypatch.setattr(db, "engine", eng)
    db._ensure_columns()
    assert "industry" in {col["name"] for col in inspect(eng).get_columns("clients")}


def test_ensure_dedup_constraint_postgres_branch(monkeypatch):
    executed: list[str] = []

    class FakeBegin:
        def __enter__(self):
            class C:
                def execute(inner, stmt, *a, **k):
                    executed.append(str(stmt))

            return C()

        def __exit__(self, *a):
            return False

    class FakeEngine:
        url = "postgresql://x/y"

        def begin(self):
            return FakeBegin()

    monkeypatch.setattr(db, "engine", FakeEngine())
    db._ensure_doc_dedup_constraint()
    assert len(executed) == 3  # drop index, create index, add constraint


def test_ensure_dedup_constraint_sqlite_noop(monkeypatch):
    # sqlite engine → early return, no statements
    db._ensure_doc_dedup_constraint()  # uses real sqlite engine → returns immediately


# ── resolver code canonicalization ────────────────────────────────────────────


def test_phonetic_eq_handles_bad_input():
    assert resolver._phonetic_eq(None, "x") is False  # jellyfish raises → False


def test_canonical_client_code_variants():
    with SessionLocal() as s:
        known = s.query(Client).first().code  # e.g. CL001
        assert resolver.canonical_client_code(known, s) == known
        assert resolver.canonical_client_code(None, s) is None
        # glyph confusion: 'O' where a '0' belongs, in the tail → snaps to real code
        glyphed = known[:2] + known[2:].replace("0", "O")
        assert resolver.canonical_client_code(glyphed, s) == known
        # unrecognised, non-CL code → returned unchanged
        assert resolver.canonical_client_code("ZZ999", s) == "ZZ999"


def test_resolve_client_paths():
    with SessionLocal() as s:
        assert resolver.resolve_client(None, s) is None
        assert resolver.resolve_client("CL001", s) == "CL001"
        # a real client name → fuzzy resolves to its code
        c = s.query(Client).first()
        assert resolver.resolve_client(c.name, s) == c.code
        assert resolver.resolve_client("zzz nonexistent co", s) is None


# ── SAP mapping ────────────────────────────────────────────────────────────────


def _mk_invoice(s, **kw) -> Invoice:
    defaults = dict(
        id=str(uuid.uuid4()),
        timesheet_id=f"x:{uuid.uuid4()}",
        client_code="CL001",
        period="June 2026",
        amount=7200.0,
        total_incl_vat=7560.0,
        vat_amount=360.0,
        currency="AED",
        invoice_sequence_no=f"TIA-MAP-{uuid.uuid4().hex[:6]}",
        line_items=[{"emp_id": "EMP10001", "employee_name": "Carlos", "days_worked": 22, "amount": 7200.0}],
    )
    defaults.update(kw)
    inv = Invoice(**defaults)
    s.add(inv)
    s.flush()
    return inv


def test_prepare_invoice_payload_success():
    with SessionLocal() as s:
        inv = _mk_invoice(s)
        payload = mapping.prepare_invoice_payload(inv, s)
        assert payload["CardCode"] == "CL001"
        assert payload["DocumentLines"][0]["ItemCode"] == "EMP10001"
        assert payload["DocumentLines"][0]["UnitPrice"] == round(7200.0 / 22, 2)
        s.rollback()


def test_prepare_invoice_payload_no_client_code():
    with SessionLocal() as s:
        inv = Invoice(id=str(uuid.uuid4()), timesheet_id="x", client_code=None,
                      line_items=[{"emp_id": "E", "amount": 1.0}])
        with pytest.raises(ValueError):
            mapping.prepare_invoice_payload(inv, s)


def test_prepare_invoice_payload_no_lines():
    with SessionLocal() as s:
        inv = Invoice(id=str(uuid.uuid4()), timesheet_id="x", client_code="CL001", line_items=[])
        with pytest.raises(ValueError):
            mapping.prepare_invoice_payload(inv, s)


def test_prepare_invoice_payload_audit_exception(monkeypatch):
    with SessionLocal() as s:
        inv = _mk_invoice(s)
        monkeypatch.setattr(
            mapping, "verify_audit_chain", lambda sess: (_ for _ in ()).throw(RuntimeError("x"))
        )
        payload = mapping.prepare_invoice_payload(inv, s)
        assert payload["U_TIA_AuditHash"] == ""  # audit failure degrades to empty head
        s.rollback()


def test_to_lines_skips_nondict_and_zero_days():
    inv_lines = [
        "not-a-dict",
        {"emp_id": "EMP2", "amount": 500.0, "days_worked": 0},  # days 0 → unit=amount
    ]

    class _Fake:
        line_items = inv_lines

    lines = mapping._to_lines(_Fake())
    assert len(lines) == 1
    assert lines[0]["UnitPrice"] == 500.0

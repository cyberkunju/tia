"""Alembic migration runner + legacy adoption (tia_ai/migrate.py).

Hermetic: every case runs against its own throwaway SQLite file, so nothing
touches the shared test DB or the deploy. Covers a fresh upgrade, adoption of a
pre-Alembic DB (stamp), a no-op re-run, and the flag-gated init_schema() both
ways.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from sqlalchemy import create_engine, inspect

from tia_ai import migrate
from tia_ai.models import Base


def _tmp_url() -> str:
    d = tempfile.mkdtemp(prefix="tia-mig-")
    return f"sqlite:///{d}/t.db"


def test_fresh_db_upgrades_and_creates_tables():
    url = _tmp_url()
    action = migrate.run_migrations(url)
    assert action == "upgraded"
    tables = set(inspect(create_engine(url)).get_table_names())
    assert "alembic_version" in tables
    assert "invoices" in tables and "doc_assets" in tables


def test_pre_alembic_db_is_stamped_not_recreated():
    url = _tmp_url()
    # Simulate a legacy DB: tables created directly, no alembic_version yet.
    Base.metadata.create_all(create_engine(url))
    action = migrate.run_migrations(url)
    assert action == "stamped"
    assert "alembic_version" in set(inspect(create_engine(url)).get_table_names())


def test_rerun_on_stamped_db_is_upgrade_noop():
    url = _tmp_url()
    migrate.run_migrations(url)  # upgraded + stamped
    assert migrate.run_migrations(url) == "upgraded"  # already at head → no-op


def test_has_app_tables_and_is_stamped_helpers():
    url = _tmp_url()
    assert migrate._has_app_tables(url) is False
    assert migrate._is_stamped(url) is False
    migrate.run_migrations(url)
    assert migrate._has_app_tables(url) is True
    assert migrate._is_stamped(url) is True


def test_init_schema_legacy_default(monkeypatch):
    monkeypatch.delenv("TIA_MIGRATE", raising=False)
    # legacy path calls init_db() (idempotent create_all on the shared test DB)
    assert migrate.init_schema() == "legacy"


def test_init_schema_alembic_branch(monkeypatch):
    monkeypatch.setenv("TIA_MIGRATE", "alembic")
    called = {}

    def _fake_run():
        called["ran"] = True
        return "upgraded"

    monkeypatch.setattr(migrate, "run_migrations", _fake_run)
    assert migrate.init_schema() == "upgraded"
    assert called.get("ran") is True

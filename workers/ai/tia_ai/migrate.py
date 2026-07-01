"""Alembic migration runner with legacy-DB adoption.

Opt-in: the entrypoint runs this only when TIA_MIGRATE=alembic; the default
startup still uses init_db() (create_all + additive column ensure), so existing
deploys are unchanged until you flip the flag (after a backup).

run_migrations():
  - fresh DB (no app tables)        -> `upgrade head`  (creates everything)
  - pre-Alembic DB (tables, no       -> `stamp head`    (adopt without re-running
    alembic_version table)                                the baseline DDL)
  - already-stamped DB               -> `upgrade head`  (applies any new revisions)
"""

from __future__ import annotations

import os
from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from sqlalchemy import create_engine, inspect

from .config import DATABASE_URL

_MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"


def _config(url: str) -> Config:
    """Build an Alembic Config programmatically (no dependency on alembic.ini at
    runtime). env.py reads the URL from TIA_ALEMBIC_URL."""
    cfg = Config()
    cfg.set_main_option("script_location", str(_MIGRATIONS_DIR))
    cfg.set_main_option("sqlalchemy.url", url)
    os.environ["TIA_ALEMBIC_URL"] = url
    return cfg


def _has_app_tables(url: str) -> bool:
    engine = create_engine(url)
    try:
        names = set(inspect(engine).get_table_names())
        return bool(names - {"alembic_version"})
    finally:
        engine.dispose()


def _is_stamped(url: str) -> bool:
    engine = create_engine(url)
    try:
        with engine.connect() as conn:
            return MigrationContext.configure(conn).get_current_revision() is not None
    finally:
        engine.dispose()


def run_migrations(url: str | None = None) -> str:
    """Bring the DB to head. Returns the action taken: 'stamped' or 'upgraded'."""
    target = url or DATABASE_URL
    cfg = _config(target)
    if _has_app_tables(target) and not _is_stamped(target):
        # Adopt a pre-Alembic database: mark it at head without re-creating tables.
        command.stamp(cfg, "head")
        return "stamped"
    command.upgrade(cfg, "head")
    return "upgraded"


def init_schema() -> str:
    """Startup schema initialisation. Default (TIA_MIGRATE unset) keeps the legacy
    create_all + additive-column path — zero change for existing deploys. Set
    TIA_MIGRATE=alembic to make Alembic the authority (fresh DBs upgrade to head;
    a pre-Alembic DB is stamped). Returns the path taken."""
    if os.getenv("TIA_MIGRATE", "").lower() == "alembic":
        return run_migrations()
    from .db import init_db

    init_db()
    return "legacy"

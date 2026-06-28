"""Engine + session factory. `init_db` creates tables; `get_session` yields a session."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import Session, sessionmaker

from .config import DATABASE_URL
from .models import Base

_connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, echo=False, connect_args=_connect_args)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, class_=Session)


def _ensure_columns() -> None:
    """Add ORM columns that are missing from already-existing tables.

    `create_all` creates brand-new tables but never ALTERs an existing one, so once a
    table has rows in prod, adding a model column silently diverges the DB until this
    runs. We introspect each mapped table and add any missing column as NULLable
    (existing rows get NULL; new inserts use the ORM default). Portable across SQLite
    and Postgres; indexes/FKs are intentionally not back-filled (correctness over
    optimisation - `create_all` covers them on a fresh DB).
    """
    insp = inspect(engine)
    for table in Base.metadata.sorted_tables:
        if not insp.has_table(table.name):
            continue  # create_all handles new tables in full
        existing = {c["name"] for c in insp.get_columns(table.name)}
        for col in table.columns:
            if col.name in existing:
                continue
            ddl_type = col.type.compile(dialect=engine.dialect)
            with engine.begin() as conn:
                conn.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {ddl_type}'))


def _ensure_doc_dedup_constraint() -> None:
    """Migrate doc_assets dedup from GLOBAL content_hash uniqueness to a
    per-(content, channel, sender) unique key. Idempotent; Postgres only (dev
    SQLite is recreated fresh from the model).

    Why: a global UNIQUE(content_hash) collapsed identical content from different
    senders/channels onto the FIRST uploader — so a timesheet someone else sent (or
    an email submission) had its invoice mis-delivered to whoever first sent that
    exact file, and leaked email submissions onto that person's WhatsApp. Scoping
    the unique key by (content_hash, source_channel, uploaded_by) gives each sender
    their own doc + correctly-routed invoice, while same-sender re-delivery still
    dedups (idempotent on retries)."""
    if not str(engine.url).startswith("postgresql"):
        return
    statements = (
        # the legacy global unique was an index (unique=True, index=True)
        "DROP INDEX IF EXISTS ix_doc_assets_content_hash",
        # keep a non-unique index for fast content lookups
        "CREATE INDEX IF NOT EXISTS ix_doc_assets_content_hash ON doc_assets (content_hash)",
        # the new per-sender composite unique (existing rows already satisfy it)
        "ALTER TABLE doc_assets ADD CONSTRAINT uq_doc_content_per_sender "
        "UNIQUE (content_hash, source_channel, uploaded_by)",
    )
    for sql in statements:
        try:
            with engine.begin() as conn:
                conn.execute(text(sql))
        except Exception:  # noqa: BLE001 — already applied / not present: idempotent
            pass


def init_db() -> None:
    Base.metadata.create_all(engine)
    _ensure_columns()
    _ensure_doc_dedup_constraint()


@contextmanager
def get_session() -> Iterator[Session]:
    s = SessionLocal()
    try:
        yield s
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()

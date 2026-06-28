"""Forward-safety: init_db must back-fill ORM columns added to an existing table.

Reproduces the real hazard - a table created by an older schema, then a new model
column added - and asserts _ensure_columns ALTERs it in (so prod doesn't silently
break when create_all alone can't migrate).
"""

from __future__ import annotations

from sqlalchemy import inspect, text

from tia_ai.db import _ensure_columns, engine, init_db


def test_ensure_columns_backfills_missing_column():
    init_db()  # full schema present
    insp = inspect(engine)
    cols = {c["name"] for c in insp.get_columns("invoices")}
    assert "vat_amount" in cols and "invoice_sequence_no" in cols

    # Simulate an old DB: drop a column that the ORM model still declares.
    # (SQLite >= 3.35 and Postgres both support DROP COLUMN.)
    with engine.begin() as conn:
        conn.execute(text('ALTER TABLE invoices DROP COLUMN vat_amount'))
    assert "vat_amount" not in {c["name"] for c in inspect(engine).get_columns("invoices")}

    _ensure_columns()  # should add it back
    assert "vat_amount" in {c["name"] for c in inspect(engine).get_columns("invoices")}

    # idempotent - second run is a no-op, no error
    _ensure_columns()

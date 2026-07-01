"""Alembic environment. Target metadata is the app's ORM models; the DB URL comes
from TIA_ALEMBIC_URL (set by tia_ai.migrate at runtime, or by you for the CLI) and
falls back to the app's configured DATABASE_URL. No credentials live in alembic.ini.
"""

from __future__ import annotations

import os

from alembic import context
from sqlalchemy import engine_from_config, pool

from tia_ai.models import Base

config = context.config
target_metadata = Base.metadata


def _url() -> str:
    return (
        os.environ.get("TIA_ALEMBIC_URL")
        or config.get_main_option("sqlalchemy.url")
        or _fallback_url()
    )


def _fallback_url() -> str:
    from tia_ai.config import DATABASE_URL

    return DATABASE_URL


def run_migrations_offline() -> None:
    context.configure(
        url=_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    section = config.get_section(config.config_ini_section) or {}
    section["sqlalchemy.url"] = _url()
    connectable = engine_from_config(section, prefix="sqlalchemy.", poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()

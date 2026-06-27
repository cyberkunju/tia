"""Shared pytest fixtures.

Uses a per-test-session sqlite file under /tmp so tests don't depend on whatever's
in the local dev DB. Honours DATABASE_URL if set (CI can point at Postgres).
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

# Pin a clean DB before any tia_ai module imports `engine`.
if not os.environ.get("TIA_KEEP_DB"):
    _tmp = Path(tempfile.gettempdir()) / "tia-tests.db"
    if _tmp.exists():
        _tmp.unlink()
    os.environ.setdefault("DATABASE_URL", f"sqlite:///{_tmp}")


@pytest.fixture(scope="session", autouse=True)
def _ensure_db_initialised():
    from tia_ai.db import init_db
    from tia_ai.seed import seed

    init_db()
    seed()  # seed master data + contracts so end-to-end tests have a substrate
    yield

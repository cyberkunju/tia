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

# Hermetic tests: never let production credentials from a local .env leak in and
# cause real network calls (Azure chat, GLM-OCR, OpenAI). Force them empty BEFORE
# tia_ai.config loads the .env, so the chat degrades to regex routing / "not
# configured" and the vision eval case is skipped — fast and deterministic.
for _k in ("GLM_OCR_API_KEY", "OPENAI_API_KEY", "AZURE_AI_ENDPOINT", "AZURE_AI_KEY"):
    os.environ[_k] = ""
# Background WhatsApp delivery must not reach a live bridge/Meta during tests.
os.environ["WHATSAPP_BRIDGE_URL"] = "http://127.0.0.1:9"
# Hermetic routing: pin the touchless auto-approval path ON regardless of the
# local/deploy .env (which may set TIA_AUTO_APPROVE=false for the demo). The
# suite asserts auto-routing/auto-dispatch behaviour, so it must not depend on
# whatever the developer's .env happens to contain.
os.environ["TIA_AUTO_APPROVE"] = "true"


@pytest.fixture(scope="session", autouse=True)
def _ensure_db_initialised():
    from tia_ai.db import init_db
    from tia_ai.seed import seed

    init_db()
    seed()  # seed master data + contracts so end-to-end tests have a substrate
    yield

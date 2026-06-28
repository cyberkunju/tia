"""Data-isolation: a client-scoped chat must not read another client's data.

The scope boundary is enforced in the tool functions (the server injects `scope`,
never the model), so we test the tools directly - no LLM required.
"""

from __future__ import annotations

import pytest

from tia_ai.db import SessionLocal, init_db
from tia_ai.qa.agent import (
    tool_get_client_settings,
    tool_get_contract,
    tool_search_employees,
)
from tia_ai.seed import seed


@pytest.fixture(scope="module", autouse=True)
def _prepare():
    init_db()
    seed()
    yield


def _two_client_codes(s) -> tuple[str, str]:
    from tia_ai.models import Client

    codes = [c.code for c in s.query(Client).order_by(Client.code).limit(2).all()]
    assert len(codes) >= 2
    return codes[0], codes[1]


def test_client_settings_denied_outside_scope():
    with SessionLocal() as s:
        a, b = _two_client_codes(s)
        assert tool_get_client_settings(s, a, scope=a)["found"] is True
        denied = tool_get_client_settings(s, b, scope=a)
        assert denied["found"] is False and denied.get("access") == "denied"


def test_contract_denied_outside_scope():
    with SessionLocal() as s:
        a, b = _two_client_codes(s)
        denied = tool_get_contract(s, b, scope=a)
        assert denied.get("access") == "denied"


def test_employee_search_scoped_to_own_client():
    with SessionLocal() as s:
        a, _ = _two_client_codes(s)
        res = tool_search_employees(s, "a", limit=50, scope=a)
        # every returned employee must belong to the in-scope client
        assert all(m["client_code"] == a for m in res["matches"])


def test_unscoped_search_spans_clients():
    with SessionLocal() as s:
        res = tool_search_employees(s, "a", limit=50, scope=None)
        clients = {m["client_code"] for m in res["matches"]}
        assert len(clients) >= 1  # no scope filter applied

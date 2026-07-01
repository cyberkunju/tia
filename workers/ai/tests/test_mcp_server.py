"""MCP tool wrappers (mcp/server.py) — invoke every wrapper through its own
short-lived session. Reads hit seeded master data; writes use not-found ids so
we exercise the wrapper body deterministically without heavy render/email."""

from __future__ import annotations

import pytest

from tia_ai import mcp as mcp_pkg
from tia_ai.mcp import server as srv


def _call(fn, *args, **kwargs):
    """Call a wrapper whether @mcp.tool returned the raw fn or a FunctionTool."""
    target = getattr(fn, "fn", fn)
    return target(*args, **kwargs)


def test_read_wrappers_execute():
    assert _call(srv.get_client_settings, "CL001").get("found") in (True, False)
    assert _call(srv.get_contract, "CL001").get("found") in (True, False)
    assert _call(srv.get_invoice, "nope")["found"] is False
    assert _call(srv.get_timesheet, "nope")["found"] is False
    assert "found" in _call(srv.get_events, "nope")
    assert "found" in _call(srv.search_employees, "a")
    assert _call(srv.get_employee_history, "nope")["found"] is False
    assert "period" in _call(srv.find_revenue_leakage, "June 2026")
    assert "ok" in _call(srv.verify_audit_chain)
    assert "rate" in _call(srv.metrics_stp)
    assert "found" in _call(srv.list_clients)
    assert "invoices" in _call(srv.list_invoices)
    assert _call(srv.prepare_sap_b1_payload, "nope")["found"] is False
    assert "documents" in _call(srv.list_documents)
    assert "queue" in _call(srv.finance_queue)


def test_write_wrappers_execute_notfound_paths():
    assert _call(srv.recover_leakage, "EMP_NOPE", "June 2026")["ok"] is False
    assert _call(srv.dispatch_invoice, "nope")["ok"] is False
    assert _call(srv.clawback_invoice, "nope")["ok"] is False
    assert _call(srv.approve_timesheet, "nope")["ok"] is False
    assert _call(srv.reject_timesheet, "nope", "some reason")["ok"] is False
    assert _call(srv.resend_invoice_email, "nope")["ok"] is False


def test_session_rolls_back_on_error(monkeypatch):
    # force the inner tool to raise → _session must roll back and re-raise
    import tia_ai.mcp.server as s

    monkeypatch.setattr(s, "tool_get_invoice", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    with pytest.raises(RuntimeError):
        _call(srv.get_invoice, "x")


def test_run_stdio_invokes_mcp_run(monkeypatch):
    called = {}
    monkeypatch.setattr(mcp_pkg.mcp, "run", lambda: called.setdefault("ran", True))
    mcp_pkg.run_stdio()
    assert called.get("ran") is True

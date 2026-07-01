"""Remaining qa/agent, qa/streaming and whatsapp branches. Hermetic (no LLM/network)."""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid

import pytest

from tia_ai.db import SessionLocal
from tia_ai.models import DocAsset, Employee, Invoice, Payroll, Timesheet
from tia_ai.qa import agent as A
from tia_ai.qa import streaming as S
from tia_ai import whatsapp as W

from .fake_llm import FakeAsyncClient, tool_call


@pytest.fixture()
def s():
    sess = SessionLocal()
    try:
        yield sess
    finally:
        sess.rollback()
        sess.close()


# ── qa/agent ───────────────────────────────────────────────────────────────────


def test_tool_get_timesheet_success(s):
    ts = Timesheet(
        id=str(uuid.uuid4()),
        client_code="CL001",
        period="June 2026",
        status="awaiting_review",
        routing="hitl",
        hitl_reason="ambiguous",
        confidence_calibrated=0.6,
        extraction={"rows": [{"employee_name": "Carlos"}]},
        validations=[{"rule": "math_net", "passed": False, "message": "bad"}],
        created_at=dt.datetime.now(dt.timezone.utc),
    )
    s.add(ts)
    s.flush()
    res = A.tool_get_timesheet(s, ts.id)  # lines 354-355 success path
    assert res["found"] is True
    assert res["id"] == ts.id
    assert res["routing"] == "hitl"
    assert res["failed_validations"] and res["failed_validations"][0]["rule"] == "math_net"


def test_tool_get_timesheet_not_found_and_scope(s):
    assert A.tool_get_timesheet(s, "nope")["found"] is False
    ts = Timesheet(id=str(uuid.uuid4()), client_code="CL001", created_at=dt.datetime.now(dt.timezone.utc))
    s.add(ts)
    s.flush()
    assert A.tool_get_timesheet(s, ts.id, scope="CL999").get("access") == "denied"


def test_tool_get_employee_history_hits_billed_limit(s):
    emp = s.query(Employee).filter(Employee.client_code == "CL001").first()
    # 6 invoices across distinct periods, each billing this emp → billed_periods
    # reaches the limit and both breaks (495 inner, 497 outer) fire.
    for i in range(6):
        s.add(
            Invoice(
                id=str(uuid.uuid4()),
                timesheet_id=f"hist:{uuid.uuid4()}",
                client_code="CL001",
                period=f"HIST-{i:02d} 2099",
                amount=1000.0 + i,
                currency="AED",
                status="generated",
                invoice_sequence_no=f"TIA-HIST-{uuid.uuid4().hex[:8]}",
                line_items=[{"emp_id": emp.emp_id, "amount": 1000.0 + i, "days_worked": 22}],
                created_at=dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=i),
            )
        )
    s.flush()
    res = A.tool_get_employee_history(s, emp.emp_id, limit=6)
    assert res["found"] is True
    assert len(res["billed_history"]) == 6


def test_tool_find_revenue_leakage_scope_sets_client_code(s):
    # scope set, client_code None → line 529 forces client_code = scope
    res = A.tool_find_revenue_leakage(s, period="NO-SUCH-PERIOD-8899", scope="CL001")
    assert res["period"] == "NO-SUCH-PERIOD-8899"
    assert res.get("access") != "denied"


def test_tool_recover_leakage_audit_head_failure_swallowed(monkeypatch, s):
    import tia_ai.audit as audit

    emp = s.query(Employee).filter(Employee.client_code == "CL001").first()
    period = "RECOV 2099"
    s.add(
        Payroll(
            id=str(uuid.uuid4()), emp_id=emp.emp_id, employee_name=emp.full_name,
            client_code="CL001", period=period, gross=10000.0, basic=10000.0, ot_hours=0,
            ot_amount=0, net_pay=10000.0, currency="AED", working_days=22,
        )
    )
    s.flush()
    monkeypatch.setattr(
        audit, "verify_audit_chain", lambda sess: (_ for _ in ()).throw(RuntimeError("audit down"))
    )
    res = A.tool_recover_leakage(s, emp_id=emp.emp_id, period=period, reason="no_timesheet")
    # recovery succeeded; the audit-head fetch failure (722-723) was swallowed
    assert res["ok"] is True
    assert res["invoice_id"]


def test_tool_list_documents_routing_filter_excludes(s):
    # a routing value nothing matches → every row hits the routing `continue` (1477)
    res = A.tool_list_documents(s, routing="zzz-nonexistent-routing")
    assert res["found"] is False
    assert res["documents"] == []


# ── qa/streaming defensive branches (190-191 bad json args, 202-203 flush) ─────


def _drain(agen) -> list[dict]:
    async def _collect():
        return [ev async for ev in agen]

    return asyncio.run(_collect())


def test_stream_bad_tool_args_default_to_empty(monkeypatch, s):
    # invalid JSON in the tool_call arguments → args={} (190-191)
    script = [
        [tool_call("metrics_stp", "{not valid json}")],
        "the touchless rate is reported.",
    ]
    fake = FakeAsyncClient(script)
    monkeypatch.setattr(S, "_chat_configured", lambda: True)
    monkeypatch.setattr(S, "_async_client_and_model", lambda: (fake, "fake-model"))
    events = _drain(S.stream_answer(s, "stp?"))
    tool_running = [e for e in events if e["type"] == "tool" and e["status"] == "running"]
    assert tool_running and tool_running[0]["args"] == {}


def test_stream_flush_failure_is_swallowed(monkeypatch, s):
    # make session.flush raise during the tool loop → except: pass (202-203)
    inv = Invoice(
        id=str(uuid.uuid4()),
        timesheet_id=f"st:{uuid.uuid4()}",
        client_code="CL001",
        period="June 2026",
        amount=500.0,
        currency="AED",
        status="generated",
        invoice_sequence_no=f"TIA-STF-{uuid.uuid4().hex[:8]}",
        line_items=[{"emp_id": "EMP10001", "amount": 500.0}],
        created_at=dt.datetime.now(dt.timezone.utc),
    )
    s.add(inv)
    s.flush()

    script = [
        [tool_call("get_invoice", f'{{"invoice_id": "{inv.id}"}}')],
        "final answer here.",
    ]
    fake = FakeAsyncClient(script)
    monkeypatch.setattr(S, "_chat_configured", lambda: True)
    monkeypatch.setattr(S, "_async_client_and_model", lambda: (fake, "fake-model"))

    real_flush = s.flush
    calls = {"n": 0}

    def _flush_raises(*a, **k):
        calls["n"] += 1
        # the loop's post-tool flush (first flush call inside the generator) raises
        raise RuntimeError("flush boom")

    monkeypatch.setattr(s, "flush", _flush_raises)
    events = _drain(S.stream_answer(s, "invoice total?"))
    # the flush error was swallowed and the run still completed with a done event
    assert events[-1]["type"] == "done"


# ── whatsapp branches (98, 116, 134-135, 408-409) ──────────────────────────────


def test_classify_inbound_text_default_timesheet():
    # non-empty, not greeting, no timesheet signal, not a question → "timesheet" (98)
    assert W.classify_inbound_text("the quick brown fox jumps") == "timesheet"


def test_route_message_empty_is_greeting():
    assert W.route_message("") == "greeting"  # line 116


def test_route_message_ambiguous_router_raises_falls_back_to_chat(monkeypatch):
    import tia_ai.qa.agent as agent_mod

    # "both signals" ambiguous message routes to the LLM router; make it raise → chat (134-135)
    monkeypatch.setattr(
        agent_mod, "route_intent", lambda t: (_ for _ in ()).throw(RuntimeError("router down"))
    )
    # a message that is BOTH question-like and timesheet-like → ambiguous branch
    msg = "why is EMP10001 invoice 22 days?"
    assert W.route_message(msg) == "chat"


def test_notify_whatsapp_result_logs_exception_swallowed(monkeypatch, s):
    import tia_ai.orchestrator as orch

    doc = DocAsset(
        id=str(uuid.uuid4()),
        content_hash=uuid.uuid4().hex,
        source_channel="whatsapp",
        uploaded_by="+9715550001",
    )
    s.add(doc)
    s.flush()
    ts = Timesheet(
        id=str(uuid.uuid4()),
        doc_id=doc.id,
        client_code="CL001",
        period="June 2026",
        routing="hitl",
        status="awaiting_review",
        created_at=dt.datetime.now(dt.timezone.utc),
    )
    s.add(ts)
    s.flush()
    # log_event raising must be swallowed (408-409); notify_bridge already fails
    # gracefully against the unreachable bridge (127.0.0.1:9 from conftest).
    monkeypatch.setattr(
        orch, "log_event", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("audit down"))
    )
    res = W.notify_whatsapp_result(s, ts, phone="+9715550001")
    assert res is not None  # returned the review-notice result despite the log failure

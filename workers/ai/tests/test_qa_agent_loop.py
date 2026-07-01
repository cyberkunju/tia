"""LLM tool-calling loop in qa/agent.py — fully mocked client (no network).

Covers: _client_and_model provider selection, route_intent, the answer() multi-step
tool loop, malformed args, unknown tool, tool exceptions, create() failure,
max-steps, grounding guard, blank-refusal rewrite, entity_context + history +
scope message assembly, and the write/queue tools reachable via direct call.
"""

from __future__ import annotations

import datetime as dt
import uuid

import pytest

from tia_ai.db import SessionLocal
from tia_ai.models import DocAsset, Invoice, Timesheet
from tia_ai.qa import agent as A
from tia_ai.qa import answer

from .fake_llm import FakeClient, tool_call


@pytest.fixture()
def s():
    sess = SessionLocal()
    try:
        yield sess
    finally:
        sess.rollback()
        sess.close()


def _use_client(monkeypatch, script, model="fake-chat-model"):
    fake = FakeClient(script)
    monkeypatch.setattr(A, "_chat_configured", lambda: True)
    monkeypatch.setattr(A, "_client_and_model", lambda: (fake, model))
    return fake


def _seed_invoice(s, *, client_code="CL001", status="generated", amount=1234.0) -> Invoice:
    inv = Invoice(
        id=str(uuid.uuid4()),
        timesheet_id=f"qa:{uuid.uuid4()}",
        client_code=client_code,
        period="June 2026",
        amount=amount,
        currency="AED",
        status=status,
        invoice_sequence_no=f"TIA-LOOP-{uuid.uuid4().hex[:8]}",
        vat_amount=round(amount * 0.05, 2),
        total_excl_vat=amount,
        total_incl_vat=round(amount * 1.05, 2),
        line_items=[{"emp_id": "EMP10001", "employee_name": "Carlos", "days_worked": 22, "amount": amount}],
        rule_results=[{"rule_id": "R7", "passed": True, "severity": "info", "message": "ok"}],
        created_at=dt.datetime.now(dt.timezone.utc),
    )
    s.add(inv)
    s.flush()
    return inv


# ── _client_and_model / _client provider seams ────────────────────────────────


def test_client_and_model_prefers_azure(monkeypatch):
    monkeypatch.setattr(A, "AZURE_AI_ENDPOINT", "https://azure.test/")
    monkeypatch.setattr(A, "AZURE_AI_KEY", "k")
    monkeypatch.setattr(A, "AZURE_CHAT_MODEL", "gpt-5.4-nano")
    client, model = A._client_and_model()
    assert model == "gpt-5.4-nano"
    assert client is not None
    # back-compat shim returns just the client
    assert A._client() is not None


def test_client_and_model_openai_fallback(monkeypatch):
    monkeypatch.setattr(A, "AZURE_AI_ENDPOINT", "")
    monkeypatch.setattr(A, "AZURE_AI_KEY", "")
    monkeypatch.setattr(A, "OPENAI_API_KEY", "sk-test")
    monkeypatch.setattr(A, "OPENAI_MODEL", "")
    client, model = A._client_and_model()
    assert model == "gpt-4o-mini"  # default when OPENAI_MODEL blank
    assert client is not None


# ── route_intent ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "word,expected",
    [("TIMESHEET", "timesheet"), ("GREETING", "greeting"), ("CHAT", "chat")],
)
def test_route_intent_classifies(monkeypatch, word, expected):
    _use_client(monkeypatch, [word])
    assert A.route_intent("some inbound text") == expected


def test_route_intent_unknown_word_returns_none(monkeypatch):
    _use_client(monkeypatch, ["POTATO"])
    assert A.route_intent("???") is None


def test_route_intent_swallows_exceptions(monkeypatch):
    _use_client(monkeypatch, [RuntimeError("model down")])
    assert A.route_intent("boom") is None


# ── answer() loop mechanics ────────────────────────────────────────────────────


def test_answer_single_tool_then_final(monkeypatch, s):
    inv = _seed_invoice(s)
    script = [
        [tool_call("get_invoice", f'{{"invoice_id": "{inv.id}"}}')],
        f"The invoice total is confirmed [invoice:{inv.id}].",
    ]
    fake = _use_client(monkeypatch, script)
    res = answer(s, "what is my invoice total?")
    assert res["model"] == "fake-chat-model"
    assert res["tool_calls"][0]["name"] == "get_invoice"
    assert {"kind": "invoice", "id": inv.id} in res["citations"]
    # reasoning-model check adds temperature for a non-reasoning model
    assert fake.calls[0]["temperature"] == 0.1
    assert fake.calls[0]["tool_choice"] == "auto"


def test_answer_multi_step_tool_loop(monkeypatch, s):
    inv = _seed_invoice(s)
    script = [
        [tool_call("list_invoices", '{"client_code": "CL001"}')],
        [tool_call("get_invoice", f'{{"invoice_id": "{inv.id}"}}')],
        "Done, two tool rounds completed.",
    ]
    _use_client(monkeypatch, script)
    res = answer(s, "walk me through it", max_steps=5)
    assert [t["name"] for t in res["tool_calls"]] == ["list_invoices", "get_invoice"]
    assert "two tool rounds" in res["answer"]


def test_answer_reasoning_model_omits_temperature(monkeypatch, s):
    fake = _use_client(monkeypatch, ["hi there"], model="gpt-5.4-nano")
    answer(s, "hello")
    assert "temperature" not in fake.calls[0]


def test_answer_malformed_tool_args_default_to_empty(monkeypatch, s):
    # invalid JSON in arguments → args={} → tool runs with defaults
    script = [
        [tool_call("metrics_stp", "{not valid json}")],
        "touchless rate reported.",
    ]
    _use_client(monkeypatch, script)
    res = answer(s, "what is the STP rate?")
    assert res["tool_calls"][0]["name"] == "metrics_stp"
    assert res["tool_calls"][0]["args"] == {}


def test_answer_unknown_tool_returns_error_result(monkeypatch, s):
    script = [
        [tool_call("nonexistent_tool", "{}")],
        "handled the unknown tool gracefully.",
    ]
    _use_client(monkeypatch, script)
    res = answer(s, "call something weird")
    # unknown tool → _invoke_tool returns {"error": ...}; loop continues to final
    assert res["tool_calls"][0]["name"] == "nonexistent_tool"
    assert "gracefully" in res["answer"]


def test_answer_tool_raises_is_caught(monkeypatch, s):
    # get_invoice with a missing required arg → TypeError inside _invoke_tool → {"error"}
    script = [
        [tool_call("get_invoice", "{}")],
        "recovered from the tool error.",
    ]
    _use_client(monkeypatch, script)
    res = answer(s, "boom")
    assert "recovered" in res["answer"]


def test_answer_create_failure_returns_soft_error(monkeypatch, s):
    _use_client(monkeypatch, [RuntimeError("upstream 500")])
    res = answer(s, "anything")
    assert res["error"] is True
    assert "trouble reaching" in res["answer"].lower()


def test_answer_max_steps_without_final(monkeypatch, s):
    inv = _seed_invoice(s)
    # every turn asks for another tool → never a final message
    script = [[tool_call("get_invoice", f'{{"invoice_id": "{inv.id}"}}')]] * 6
    _use_client(monkeypatch, script)
    res = answer(s, "loop forever", max_steps=2)
    assert "max tool-call steps" in res["answer"]


def test_answer_grounding_blocks_invented_citation(monkeypatch, s):
    # cite an invoice id that doesn't exist within scope → grounding_blocked
    script = ["See invoice [invoice:deadbeefdeadbeef] for the figure."]
    _use_client(monkeypatch, script)
    res = answer(s, "totals?", client_scope="CL001")
    assert res["grounding_blocked"] is True
    assert res["citations"] == []


def test_answer_blank_refusal_is_rewritten(monkeypatch, s):
    _use_client(monkeypatch, ["I don't know."])
    res = answer(s, "hi")
    assert "I can help with your invoices" in res["answer"]


def test_answer_builds_scope_context_and_history(monkeypatch, s):
    fake = _use_client(monkeypatch, ["hello!"])
    history = [
        {"role": "user", "content": "prior q"},
        {"role": "assistant", "content": "prior a"},
        {"role": "system", "content": "ignored"},  # dropped
        {"role": "user", "content": ""},  # blank dropped
        "not-a-dict",  # dropped
    ]
    answer(
        s,
        "current question",
        entity_context={"kind": "invoice", "id": "abc"},
        client_scope="CL001",
        history=history,
    )
    msgs = fake.calls[0]["messages"]
    roles_contents = [(m["role"], m["content"]) for m in msgs]
    assert any("[scope]" in c for _, c in roles_contents)
    assert any("[context]" in c for _, c in roles_contents)
    assert any(c == "prior q" for _, c in roles_contents)
    assert any(c == "prior a" for _, c in roles_contents)
    assert not any(c == "ignored" for _, c in roles_contents)
    assert roles_contents[-1] == ("user", "current question")


def test_answer_not_configured_short_circuits(monkeypatch, s):
    monkeypatch.setattr(A, "_chat_configured", lambda: False)
    res = answer(s, "hi")
    assert "not configured" in res["answer"].lower()


# ── tool_list_documents / tool_finance_queue / tool_reject_timesheet ───────────


def test_tool_list_documents_lists_and_filters(s):
    doc = DocAsset(
        id=str(uuid.uuid4()),
        content_hash=uuid.uuid4().hex,
        source_channel="upload",
        uploaded_by="tester",
    )
    s.add(doc)
    s.flush()
    ts = Timesheet(
        id=str(uuid.uuid4()),
        doc_id=doc.id,
        client_code="CL001",
        period="June 2026",
        status="awaiting_review",
        routing="hitl",
        created_at=dt.datetime.now(dt.timezone.utc),
    )
    s.add(ts)
    s.flush()
    res = A.tool_list_documents(s, status="awaiting_review", routing="hitl")
    assert res["found"] is True
    assert any(d["doc_id"] == doc.id for d in res["documents"])
    # filter that matches nothing
    empty = A.tool_list_documents(s, status="no_such_status")
    assert empty["found"] is False


def test_tool_list_documents_scope_filters_other_clients(s):
    doc = DocAsset(
        id=str(uuid.uuid4()),
        content_hash=uuid.uuid4().hex,
        source_channel="upload",
        uploaded_by="tester",
    )
    s.add(doc)
    s.flush()
    ts = Timesheet(
        id=str(uuid.uuid4()),
        doc_id=doc.id,
        client_code="CL001",
        period="June 2026",
        status="ingested",
        routing="auto",
        created_at=dt.datetime.now(dt.timezone.utc),
    )
    s.add(ts)
    s.flush()
    res = A.tool_list_documents(s, scope="CL999")
    assert all(d.get("client_code") != "CL001" for d in res["documents"])


def test_tool_finance_queue_surfaces_over_threshold(s):
    # a big invoice → over the default 50k threshold → appears in the queue
    inv = _seed_invoice(s, amount=99999.0, status="generated")
    res = A.tool_finance_queue(s)
    assert res["found"] is True
    assert any(x["id"] == inv.id for x in res["queue"])


def test_tool_finance_queue_scope(s):
    _seed_invoice(s, amount=99999.0, client_code="CL001")
    res = A.tool_finance_queue(s, scope="CL999")
    assert all(x["client_code"] != "CL001" for x in res["queue"])


def test_tool_reject_timesheet_not_found(s):
    assert A.tool_reject_timesheet(s, "nope", reason="bad")["ok"] is False


def test_tool_reject_timesheet_scope_denied(s):
    ts = Timesheet(
        id=str(uuid.uuid4()),
        client_code="CL001",
        period="June 2026",
        status="awaiting_review",
        routing="hitl",
        created_at=dt.datetime.now(dt.timezone.utc),
    )
    s.add(ts)
    s.flush()
    denied = A.tool_reject_timesheet(s, ts.id, reason="x", scope="CL999")
    assert denied.get("access") == "denied"

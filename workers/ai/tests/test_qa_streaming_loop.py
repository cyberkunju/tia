"""Streaming agent loop in qa/streaming.py — mocked async client (no network).

Drives the async generator with asyncio.run (no pytest-asyncio needed) and
asserts the emitted event sequence for every branch: not-configured, tool
running/done/error, token stream + done, empty final, create() failure, and
max-steps. Also covers _async_client_and_model provider selection and the
remaining _result_summary branches.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid

import pytest

from tia_ai.db import SessionLocal
from tia_ai.models import Invoice
from tia_ai.qa import streaming as S
from tia_ai.qa.streaming import _result_summary

from .fake_llm import FakeAsyncClient, tool_call


@pytest.fixture()
def s():
    sess = SessionLocal()
    try:
        yield sess
    finally:
        sess.rollback()
        sess.close()


def _use_async(monkeypatch, script, model="fake-chat-model"):
    fake = FakeAsyncClient(script)
    monkeypatch.setattr(S, "_chat_configured", lambda: True)
    monkeypatch.setattr(S, "_async_client_and_model", lambda: (fake, model))
    return fake


def _drain(agen) -> list[dict]:
    async def _collect():
        return [ev async for ev in agen]

    return asyncio.run(_collect())


def _seed_invoice(s) -> Invoice:
    inv = Invoice(
        id=str(uuid.uuid4()),
        timesheet_id=f"qa:{uuid.uuid4()}",
        client_code="CL001",
        period="June 2026",
        amount=500.0,
        currency="AED",
        status="generated",
        invoice_sequence_no=f"TIA-ST-{uuid.uuid4().hex[:8]}",
        vat_amount=25.0,
        total_excl_vat=500.0,
        total_incl_vat=525.0,
        line_items=[{"emp_id": "EMP10001", "amount": 500.0}],
        rule_results=[{"rule_id": "R7", "passed": True, "severity": "info", "message": "ok"}],
        created_at=dt.datetime.now(dt.timezone.utc),
    )
    s.add(inv)
    s.flush()
    return inv


# ── provider seam ──────────────────────────────────────────────────────────────


def test_async_client_and_model_azure(monkeypatch):
    monkeypatch.setattr(S, "AZURE_AI_ENDPOINT", "https://azure.test/")
    monkeypatch.setattr(S, "AZURE_AI_KEY", "k")
    monkeypatch.setattr(S, "AZURE_CHAT_MODEL", "gpt-5.4-nano")
    client, model = S._async_client_and_model()
    assert model == "gpt-5.4-nano" and client is not None


def test_async_client_and_model_openai(monkeypatch):
    monkeypatch.setattr(S, "AZURE_AI_ENDPOINT", "")
    monkeypatch.setattr(S, "AZURE_AI_KEY", "")
    monkeypatch.setattr(S, "OPENAI_API_KEY", "sk-x")
    monkeypatch.setattr(S, "OPENAI_MODEL", "gpt-4o-mini")
    client, model = S._async_client_and_model()
    assert model == "gpt-4o-mini" and client is not None


# ── stream_answer event sequences ───────────────────────────────────────────────


def test_stream_not_configured(monkeypatch, s):
    monkeypatch.setattr(S, "_chat_configured", lambda: False)
    events = _drain(S.stream_answer(s, "hi"))
    assert events == [
        {"type": "error", "message": "Chat agent is not configured (no Azure or OpenAI credentials)."}
    ]


def test_stream_tool_then_tokens_then_done(monkeypatch, s):
    inv = _seed_invoice(s)
    script = [
        [tool_call("get_invoice", f'{{"invoice_id": "{inv.id}"}}')],
        f"Here is the total for invoice [invoice:{inv.id}].",
    ]
    _use_async(monkeypatch, script)
    events = _drain(S.stream_answer(s, "invoice total?"))
    types = [e["type"] for e in events]
    assert "tool" in types and "token" in types and types[-1] == "done"
    running = [e for e in events if e["type"] == "tool" and e["status"] == "running"]
    done = [e for e in events if e["type"] == "tool" and e["status"] == "done"]
    assert running and done and "result_summary" in done[0]
    final = events[-1]
    assert final["model"] == "fake-chat-model"
    assert {"kind": "invoice", "id": inv.id} in final["citations"]
    # tokens reassemble into the final prose
    text = "".join(e["content"] for e in events if e["type"] == "token")
    assert f"[invoice:{inv.id}]" in text


def test_stream_tool_error_event(monkeypatch, s):
    # unknown tool → _invoke_tool returns {"error": ...} → status=error event
    script = [
        [tool_call("no_such_tool", "{}")],
        "final after error",
    ]
    _use_async(monkeypatch, script)
    events = _drain(S.stream_answer(s, "x"))
    err = [e for e in events if e["type"] == "tool" and e["status"] == "error"]
    assert err and "error" in err[0]


def test_stream_empty_final_answer(monkeypatch, s):
    _use_async(monkeypatch, [""])  # empty content, no tool_calls
    events = _drain(S.stream_answer(s, "x"))
    assert events[-1] == {"type": "error", "message": "Empty final answer from the model."}


def test_stream_create_failure(monkeypatch, s):
    _use_async(monkeypatch, [RuntimeError("upstream down")])
    events = _drain(S.stream_answer(s, "x"))
    assert events[-1]["type"] == "error" and "OpenAI call failed" in events[-1]["message"]


def test_stream_max_steps(monkeypatch, s):
    inv = _seed_invoice(s)
    script = [[tool_call("get_invoice", f'{{"invoice_id": "{inv.id}"}}')]] * 4
    _use_async(monkeypatch, script)
    events = _drain(S.stream_answer(s, "loop", max_steps=2))
    assert events[-1] == {"type": "error", "message": "Reached max tool-call steps without a final answer."}


# ── _result_summary remaining branches ──────────────────────────────────────────


def test_result_summary_remaining_branches():
    assert _result_summary({"invoice_sequence_no": "TIA-1", "ok": True, "amount_aed": 1200}).startswith(
        "invoice TIA-1 AED"
    )
    assert _result_summary({"invoice_sequence_no": "TIA-2", "ok": True}) == "invoice TIA-2"
    assert _result_summary({"head_hash": "abcdef1234567890", "ok": True}).startswith("chain ok=True")
    assert _result_summary({"head_hash": None, "ok": True}).startswith("chain ok=True")
    assert _result_summary({"events": [1, 2, 3]}) == "3 events"
    assert _result_summary({"rate_cards": [1, 2]}) == "contract found, 2 rate cards"
    assert _result_summary({"ok": True, "status": "voided"}) == "status=voided"
    assert _result_summary({"action_taken": "requires_console"}) == "requires_console"
    assert _result_summary({"unmatched": "shape"}) == "ok"

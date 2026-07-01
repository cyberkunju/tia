"""ai/llm.py — provider-agnostic chat + embeddings client seam (respx, no network)."""

from __future__ import annotations

import asyncio

import httpx
import pytest
import respx

from tia_ai.ai import llm


def _run(coro):
    return asyncio.run(coro)


# ── pure helpers ────────────────────────────────────────────────────────────


def test_is_reasoning_model():
    assert llm.is_reasoning_model("gpt-5.4-nano") is True
    assert llm.is_reasoning_model("o1-preview") is True
    assert llm.is_reasoning_model("vendor/gpt-5-mini") is True
    assert llm.is_reasoning_model("gpt-4o-mini") is False


def test_build_chat_request_body_reasoning_vs_standard():
    msgs = [llm.ChatMessage("user", "hi")]
    reasoning = llm.build_chat_request_body(
        "gpt-5.4-nano", msgs, max_output_tokens=100, temperature=0.5, json=True
    )
    assert reasoning["max_completion_tokens"] == 100
    assert "temperature" not in reasoning
    assert reasoning["response_format"] == {"type": "json_object"}

    standard = llm.build_chat_request_body(
        "gpt-4o-mini", msgs, max_output_tokens=100, temperature=0.5, json=False
    )
    assert standard["max_tokens"] == 100
    assert standard["temperature"] == 0.5
    assert "response_format" not in standard


def test_build_chat_request_body_no_tokens():
    body = llm.build_chat_request_body(
        "gpt-4o-mini", [llm.ChatMessage("user", "x")], max_output_tokens=None, temperature=None, json=False
    )
    assert "max_tokens" not in body and "temperature" not in body


def test_extract_content_branches():
    assert llm.extract_content("not a dict") is None
    assert llm.extract_content({}) is None
    assert llm.extract_content({"choices": "x"}) is None
    assert llm.extract_content({"choices": [123]}) is None
    assert llm.extract_content({"choices": [{"message": "x"}]}) is None
    assert llm.extract_content({"choices": [{"message": {"content": 5}}]}) is None
    assert llm.extract_content({"choices": [{"message": {"content": "   "}}]}) is None
    assert llm.extract_content({"choices": [{"message": {"content": " hi "}}]}) == "hi"


# ── ChatModelClient ──────────────────────────────────────────────────────────


def test_chat_client_url_and_headers():
    c = llm.ChatModelClient(base_url="https://x/v1", api_key="k", model="m")
    assert c._url() == "https://x/v1/chat/completions"
    c2 = llm.ChatModelClient(base_url="https://x/v1/chat/completions", api_key="k", model="m")
    assert c2._url() == "https://x/v1/chat/completions"
    assert c._headers()["Authorization"] == "Bearer k"
    az = llm.ChatModelClient(base_url="https://x", api_key="k", model="m", api_style="azure")
    assert az._headers()["api-key"] == "k"


def test_chat_unconfigured():
    c = llm.ChatModelClient(base_url="", api_key="", model="")
    assert c.configured is False
    res = _run(c.complete([llm.ChatMessage("user", "hi")]))
    assert res.ok is False and res.kind == "unconfigured"


@respx.mock
def test_chat_complete_success():
    respx.post("https://x/v1/chat/completions").mock(
        return_value=httpx.Response(200, json={"choices": [{"message": {"content": "hello"}}]})
    )
    c = llm.ChatModelClient(base_url="https://x/v1", api_key="k", model="gpt-4o-mini")
    res = _run(c.complete([llm.ChatMessage("user", "hi")], max_output_tokens=10, temperature=0.2))
    assert res.ok is True and res.content == "hello"


@respx.mock
def test_chat_complete_http_error():
    respx.post("https://x/v1/chat/completions").mock(return_value=httpx.Response(500, text="err"))
    c = llm.ChatModelClient(base_url="https://x/v1", api_key="k", model="m")
    res = _run(c.complete([llm.ChatMessage("user", "hi")]))
    assert res.ok is False and res.kind == "http" and res.status == 500


@respx.mock
def test_chat_complete_empty_content():
    respx.post("https://x/v1/chat/completions").mock(
        return_value=httpx.Response(200, json={"choices": [{"message": {"content": ""}}]})
    )
    c = llm.ChatModelClient(base_url="https://x/v1", api_key="k", model="m")
    res = _run(c.complete([llm.ChatMessage("user", "hi")]))
    assert res.ok is False and res.kind == "empty"


@respx.mock
def test_chat_complete_timeout():
    respx.post("https://x/v1/chat/completions").mock(side_effect=httpx.TimeoutException("slow"))
    c = llm.ChatModelClient(base_url="https://x/v1", api_key="k", model="m")
    res = _run(c.complete([llm.ChatMessage("user", "hi")]))
    assert res.ok is False and res.kind == "timeout"


@respx.mock
def test_chat_complete_network_error():
    respx.post("https://x/v1/chat/completions").mock(side_effect=httpx.ConnectError("down"))
    c = llm.ChatModelClient(base_url="https://x/v1", api_key="k", model="m")
    res = _run(c.complete([llm.ChatMessage("user", "hi")]))
    assert res.ok is False and res.kind == "network"


# ── EmbeddingsClient ─────────────────────────────────────────────────────────


def test_embeddings_url_and_zero():
    e = llm.EmbeddingsClient(base_url="https://x/v1", api_key="k", model="m", dim=3)
    assert e._url() == "https://x/v1/embeddings"
    assert e._zero() == [0.0, 0.0, 0.0]
    e2 = llm.EmbeddingsClient(base_url="https://x/v1/embeddings", api_key="k", model="m")
    assert e2._url() == "https://x/v1/embeddings"


def test_embeddings_empty_and_unconfigured():
    e = llm.EmbeddingsClient(base_url="https://x/v1", api_key="k", model="m", dim=2)
    assert _run(e.embed("")) == [0.0, 0.0]
    e2 = llm.EmbeddingsClient(base_url="", api_key="", model="", dim=2)
    assert _run(e2.embed("hi")) == [0.0, 0.0]


@respx.mock
def test_embeddings_success():
    respx.post("https://x/v1/embeddings").mock(
        return_value=httpx.Response(200, json={"data": [{"embedding": [1.0, 2.0, 3.0]}]})
    )
    e = llm.EmbeddingsClient(base_url="https://x/v1", api_key="k", model="m", dim=3)
    assert _run(e.embed("hi")) == [1.0, 2.0, 3.0]


@respx.mock
def test_embeddings_http_error_returns_zero():
    respx.post("https://x/v1/embeddings").mock(return_value=httpx.Response(500))
    e = llm.EmbeddingsClient(base_url="https://x/v1", api_key="k", model="m", dim=2)
    assert _run(e.embed("hi")) == [0.0, 0.0]


@respx.mock
def test_embeddings_bad_vector_returns_zero():
    respx.post("https://x/v1/embeddings").mock(
        return_value=httpx.Response(200, json={"data": [{"embedding": [1.0]}]})  # wrong dim
    )
    e = llm.EmbeddingsClient(base_url="https://x/v1", api_key="k", model="m", dim=3)
    assert _run(e.embed("hi")) == [0.0, 0.0, 0.0]


@respx.mock
def test_embeddings_exception_returns_zero():
    respx.post("https://x/v1/embeddings").mock(side_effect=httpx.ConnectError("down"))
    e = llm.EmbeddingsClient(base_url="https://x/v1", api_key="k", model="m", dim=2)
    assert _run(e.embed("hi")) == [0.0, 0.0]


# ── config factories ─────────────────────────────────────────────────────────


def test_config_factories(monkeypatch):
    llm.get_llm_config.cache_clear()
    monkeypatch.setenv("LLM_BASE_URL", "https://llm/v1")
    monkeypatch.setenv("LLM_API_KEY", "sk")
    monkeypatch.setenv("LLM_MODEL", "gpt-4o-mini")
    cfg = llm.get_llm_config()
    assert cfg.chat_base_url == "https://llm/v1"
    chat = llm.create_chat_client(cfg)
    assert chat.model == "gpt-4o-mini"
    emb = llm.create_embeddings_client(cfg)
    assert emb.dim == 1536
    llm.get_llm_config.cache_clear()

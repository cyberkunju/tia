import asyncio
import json

import httpx

from tia_ai.ai.llm import (
    ChatMessage,
    ChatModelClient,
    EmbeddingsClient,
    build_chat_request_body,
    extract_content,
    is_reasoning_model,
)


def test_reasoning_model_detection():
    assert is_reasoning_model("gpt-5-mini")
    assert is_reasoning_model("openai/gpt-5")
    assert is_reasoning_model("o3-mini")
    assert is_reasoning_model("o1")
    assert not is_reasoning_model("gpt-4o-mini")
    assert not is_reasoning_model("qwen2.5-7b-instruct")


def test_request_body_normalizes_reasoning_params():
    msgs = [ChatMessage("user", "hi")]
    r = build_chat_request_body("gpt-5-mini", msgs, max_output_tokens=100, temperature=0.2, json=True)
    assert r["max_completion_tokens"] == 100
    assert "max_tokens" not in r
    assert "temperature" not in r  # reasoning models reject custom temperature
    assert r["response_format"] == {"type": "json_object"}

    c = build_chat_request_body("gpt-4o-mini", msgs, max_output_tokens=100, temperature=0.2, json=False)
    assert c["max_tokens"] == 100
    assert c["temperature"] == 0.2
    assert "response_format" not in c


def test_extract_content():
    payload = {"choices": [{"message": {"content": "  hello  "}}]}
    assert extract_content(payload) == "hello"
    assert extract_content({"choices": []}) is None
    assert extract_content({}) is None
    assert extract_content({"choices": [{"message": {"content": "   "}}]}) is None


def _client_with(handler) -> ChatModelClient:
    transport = httpx.MockTransport(handler)
    ac = httpx.AsyncClient(transport=transport)
    return ChatModelClient(base_url="http://fake/v1", api_key="k", model="gpt-4o-mini", client=ac)


def test_complete_success():
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path.endswith("/chat/completions")
        return httpx.Response(200, json={"choices": [{"message": {"content": "the total is 100"}}]})
    res = asyncio.run(_client_with(handler).complete([ChatMessage("user", "q")]))
    assert res.ok and res.content == "the total is 100"


def test_complete_http_error():
    res = asyncio.run(_client_with(lambda r: httpx.Response(500, json={}))
                      .complete([ChatMessage("user", "q")]))
    assert not res.ok and res.kind == "http" and res.status == 500


def test_complete_unconfigured():
    client = ChatModelClient(base_url="", api_key="", model="")
    res = asyncio.run(client.complete([ChatMessage("user", "q")]))
    assert not res.ok and res.kind == "unconfigured"


def test_embed_success_and_graceful_degradation():
    def ok_handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"embedding": [0.1, 0.2, 0.3]}]})
    ac = httpx.AsyncClient(transport=httpx.MockTransport(ok_handler))
    emb = EmbeddingsClient(base_url="http://fake/v1", api_key="k", model="e", dim=3, client=ac)
    assert asyncio.run(emb.embed("hello")) == [0.1, 0.2, 0.3]
    # empty input → zero vector, no call
    assert asyncio.run(emb.embed("")) == [0.0, 0.0, 0.0]

    # wrong dimension → zero vector (shape-stable)
    def bad_dim(req): return httpx.Response(200, json={"data": [{"embedding": [0.1, 0.2]}]})
    emb2 = EmbeddingsClient(base_url="http://fake/v1", api_key="k", model="e", dim=3,
                            client=httpx.AsyncClient(transport=httpx.MockTransport(bad_dim)))
    assert asyncio.run(emb2.embed("hi")) == [0.0, 0.0, 0.0]

    # unconfigured → zero vector
    emb3 = EmbeddingsClient(base_url="", api_key="", model="", dim=3)
    assert asyncio.run(emb3.embed("hi")) == [0.0, 0.0, 0.0]

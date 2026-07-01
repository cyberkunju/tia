"""OCR client (ocr/__init__.py) — respx-mocked GLM + Mistral HTTP (no network).

Covers the pure helpers, _call, glm_markdown success + GLM→Mistral failover +
not-configured raise, glm_kie, glm_layout shape tolerance, and mistral_markdown
image/pdf branches.
"""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from tia_ai import ocr


@pytest.fixture()
def glm(monkeypatch):
    monkeypatch.setattr(ocr, "GLM_OCR_BASE_URL", "https://glm.test/v1")
    monkeypatch.setattr(ocr, "GLM_OCR_MODEL", "glm-ocr")
    monkeypatch.setattr(ocr, "GLM_OCR_API_KEY", "glmkey")
    monkeypatch.setattr(ocr, "GLM_OCR_CONNECT_TIMEOUT", 5.0)


@pytest.fixture()
def mistral(monkeypatch):
    monkeypatch.setattr(ocr, "MISTRAL_OCR_ENDPOINT", "https://mistral.test/ocr")
    monkeypatch.setattr(ocr, "MISTRAL_OCR_API_KEY", "mkey")
    monkeypatch.setattr(ocr, "MISTRAL_OCR_MODEL", "mistral-ocr")


GLM_URL = "https://glm.test/v1/chat/completions"


def _glm_response(content: str) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})


# ── pure helpers ────────────────────────────────────────────────────────────


def test_headers_with_and_without_key(monkeypatch):
    monkeypatch.setattr(ocr, "GLM_OCR_API_KEY", "abc")
    assert ocr._headers()["Authorization"] == "Bearer abc"
    monkeypatch.setattr(ocr, "GLM_OCR_API_KEY", "")
    assert "Authorization" not in ocr._headers()


def test_b64_data_url():
    url = ocr._b64_data_url(b"hello", "image/png")
    assert url.startswith("data:image/png;base64,")


def test_completions_url_both_forms(monkeypatch):
    monkeypatch.setattr(ocr, "GLM_OCR_BASE_URL", "https://x.test/v1")
    assert ocr._completions_url() == "https://x.test/v1/chat/completions"
    monkeypatch.setattr(ocr, "GLM_OCR_BASE_URL", "https://x.test")
    assert ocr._completions_url() == "https://x.test/v1/chat/completions"


def test_dedupe_looped_branches():
    assert ocr._dedupe_looped("") == ""
    assert ocr._dedupe_looped("a clean long transcription line here") == "a clean long transcription line here"
    # opens with a fence → longest fenced block wins
    text = "```\nshort\n```\n```\nthis fenced block is the longest one here\n```"
    assert "longest one here" in ocr._dedupe_looped(text)
    # tiny head, no usable fenced block → strip fences
    assert ocr._dedupe_looped("```x```") == "x"


def test_strip_json_variants():
    assert ocr._strip_json('```json\n{"a": 1}\n```') == '{"a": 1}'
    assert ocr._strip_json('prefix {"b": 2} suffix') == '{"b": 2}'


def test_mistral_configured(monkeypatch):
    monkeypatch.setattr(ocr, "MISTRAL_OCR_ENDPOINT", "")
    assert ocr._mistral_configured() is False


# ── glm_markdown ────────────────────────────────────────────────────────────


@respx.mock
def test_glm_markdown_success(glm):
    respx.post(GLM_URL).mock(return_value=_glm_response("# Timesheet\nCarlos Smith 22 days"))
    md = ocr.glm_markdown(b"imgbytes")
    assert "Carlos Smith" in md


@respx.mock
def test_glm_markdown_failover_to_mistral(glm, mistral):
    respx.post(GLM_URL).mock(return_value=httpx.Response(500, text="glm down"))
    respx.post("https://mistral.test/ocr").mock(
        return_value=httpx.Response(200, json={"pages": [{"markdown": "from mistral"}]})
    )
    md = ocr.glm_markdown(b"imgbytes")
    assert md == "from mistral"


@respx.mock
def test_glm_markdown_failure_reraises_when_no_mistral(glm, monkeypatch):
    monkeypatch.setattr(ocr, "MISTRAL_OCR_ENDPOINT", "")
    respx.post(GLM_URL).mock(return_value=httpx.Response(500, text="down"))
    with pytest.raises(httpx.HTTPStatusError):
        ocr.glm_markdown(b"imgbytes")


# ── mistral_markdown ────────────────────────────────────────────────────────


def test_mistral_markdown_not_configured_raises(monkeypatch):
    monkeypatch.setattr(ocr, "MISTRAL_OCR_ENDPOINT", "")
    with pytest.raises(RuntimeError):
        ocr.mistral_markdown(b"x")


@respx.mock
def test_mistral_markdown_image(mistral):
    route = respx.post("https://mistral.test/ocr").mock(
        return_value=httpx.Response(200, json={"pages": [{"markdown": "p1"}, {"markdown": "p2"}]})
    )
    md = ocr.mistral_markdown(b"x", mime="image/png")
    assert md == "p1\n\np2"
    body = json.loads(route.calls[-1].request.content)
    assert body["document"]["type"] == "image_url"


@respx.mock
def test_mistral_markdown_pdf(mistral):
    route = respx.post("https://mistral.test/ocr").mock(
        return_value=httpx.Response(200, json={"pages": [{"markdown": "pg"}]})
    )
    ocr.mistral_markdown(b"%PDF", mime="application/pdf")
    body = json.loads(route.calls[-1].request.content)
    assert body["document"]["type"] == "document_url"


# ── glm_kie ──────────────────────────────────────────────────────────────────


@respx.mock
def test_glm_kie_parses_schema_json(glm):
    payload = {
        "client_code": "CL001",
        "period": "June 2026",
        "rows": [{"employee_name": "Carlos", "days_worked": 22}],
    }
    respx.post(GLM_URL).mock(return_value=_glm_response(json.dumps(payload)))
    ex = ocr.glm_kie(b"x")
    assert ex.client_code == "CL001"
    assert ex.rows[0].employee_name == "Carlos"


# ── glm_layout ────────────────────────────────────────────────────────────────


@respx.mock
def test_glm_layout_array(glm):
    blocks = [{"bbox": [0, 0, 10, 10], "category": "Text", "text": "hi"}]
    respx.post(GLM_URL).mock(return_value=_glm_response(json.dumps(blocks)))
    assert ocr.glm_layout(b"x") == blocks


@respx.mock
def test_glm_layout_blocks_wrapper(glm):
    respx.post(GLM_URL).mock(
        return_value=_glm_response(json.dumps({"blocks": [{"bbox": [0, 0, 1, 1], "text": "a"}]}))
    )
    out = ocr.glm_layout(b"x")
    assert out and out[0]["text"] == "a"


@respx.mock
def test_glm_layout_single_object(glm):
    respx.post(GLM_URL).mock(
        return_value=_glm_response(json.dumps({"bbox": [0, 0, 1, 1], "text": "solo"}))
    )
    out = ocr.glm_layout(b"x")
    assert out[0]["text"] == "solo"


@respx.mock
def test_glm_layout_invalid_json_returns_empty(glm):
    respx.post(GLM_URL).mock(return_value=_glm_response("not json at all !!!"))
    assert ocr.glm_layout(b"x") == []


@respx.mock
def test_glm_layout_unexpected_scalar_returns_empty(glm):
    respx.post(GLM_URL).mock(return_value=_glm_response("42"))
    assert ocr.glm_layout(b"x") == []

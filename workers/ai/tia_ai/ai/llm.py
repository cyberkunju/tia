"""Provider-agnostic LLM + embeddings clients — the single seam for all model calls.

One injectable port so the agent/RAG are testable with no network. Works against any
OpenAI-compatible endpoint: hosted OpenAI, Azure, or a self-hosted vLLM gateway (the team's
open-weight stance). Two responsibilities, mirroring the proven design:

  1. Normalize reasoning-model params. Newer reasoning models (the gpt-5 / o-series family) take
     `max_completion_tokens` (not `max_tokens`) and reject a custom `temperature`.
     `build_chat_request_body` emits the right shape so callers always pass the same logical request.
  2. Be the one place HTTP happens. Structured failures, never exceptions, so a model outage
     degrades to a deterministic reply instead of a 500. No fallback model is invented silently.

Embeddings degrade gracefully to a zero vector when unconfigured/failed, keeping call sites
shape-stable (the semantic search just returns nothing useful rather than crashing).
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from functools import lru_cache

import httpx

CHAT_TIMEOUT_S = 20.0
EMBED_TIMEOUT_S = 20.0
_REASONING_RE = re.compile(r"^(gpt-5(\b|[.\-])|o[1-9](\b|[.\-]))")


@dataclass(frozen=True)
class ChatMessage:
    role: str  # 'system' | 'user' | 'assistant'
    content: str


@dataclass(frozen=True)
class ChatResult:
    ok: bool
    content: str = ""
    kind: str = ""  # 'http' | 'network' | 'timeout' | 'empty' | 'unconfigured'
    reason: str = ""
    status: int | None = None


def is_reasoning_model(model: str) -> bool:
    name = model.strip().lower()
    bare = name.split("/")[-1] if "/" in name else name
    return bool(_REASONING_RE.match(bare))


def build_chat_request_body(
    model: str,
    messages: list[ChatMessage],
    *,
    max_output_tokens: int | None,
    temperature: float | None,
    json: bool,
) -> dict:
    body: dict = {"model": model, "messages": [{"role": m.role, "content": m.content} for m in messages]}
    reasoning = is_reasoning_model(model)
    if max_output_tokens is not None:
        body["max_completion_tokens" if reasoning else "max_tokens"] = max_output_tokens
    if not reasoning and temperature is not None:
        body["temperature"] = temperature
    if json:
        body["response_format"] = {"type": "json_object"}
    return body


def extract_content(payload: object) -> str | None:
    if not isinstance(payload, dict):
        return None
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    if not isinstance(message, dict):
        return None
    content = message.get("content")
    if not isinstance(content, str):
        return None
    trimmed = content.strip()
    return trimmed or None


@dataclass
class ChatModelClient:
    base_url: str
    api_key: str
    model: str
    api_style: str = "openai"  # 'openai' (Bearer) | 'azure' (api-key header)
    timeout_s: float = CHAT_TIMEOUT_S
    client: httpx.AsyncClient | None = None

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.model)

    def _url(self) -> str:
        base = self.base_url.rstrip("/")
        # Azure / fully-qualified endpoints already include the path; OpenAI-style appends it.
        return base if base.endswith("/chat/completions") else f"{base}/chat/completions"

    def _headers(self) -> dict:
        if self.api_style == "azure":
            return {"Content-Type": "application/json", "api-key": self.api_key}
        return {"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"}

    async def complete(
        self,
        messages: list[ChatMessage],
        *,
        max_output_tokens: int | None = None,
        temperature: float | None = None,
        json: bool = False,
    ) -> ChatResult:
        if not self.configured:
            return ChatResult(ok=False, kind="unconfigured", reason="no LLM endpoint configured")
        body = build_chat_request_body(
            self.model, messages, max_output_tokens=max_output_tokens, temperature=temperature, json=json
        )
        client = self.client or httpx.AsyncClient(timeout=self.timeout_s)
        owns = self.client is None
        try:
            res = await client.post(self._url(), headers=self._headers(), json=body)
            if res.status_code >= 400:
                return ChatResult(ok=False, kind="http", status=res.status_code,
                                  reason=f"model returned status {res.status_code}")
            content = extract_content(res.json())
            if content is None:
                return ChatResult(ok=False, kind="empty", reason="no usable content")
            return ChatResult(ok=True, content=content)
        except httpx.TimeoutException:
            return ChatResult(ok=False, kind="timeout", reason="model request timed out")
        except Exception as exc:  # noqa: BLE001 — model call must never raise into the pipeline
            return ChatResult(ok=False, kind="network", reason=f"model request failed: {type(exc).__name__}")
        finally:
            if owns:
                await client.aclose()


@dataclass
class EmbeddingsClient:
    base_url: str
    api_key: str
    model: str
    dim: int = 1536
    timeout_s: float = EMBED_TIMEOUT_S
    client: httpx.AsyncClient | None = None

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.model)

    def _zero(self) -> list[float]:
        return [0.0] * self.dim

    def _url(self) -> str:
        base = self.base_url.rstrip("/")
        return base if base.endswith("/embeddings") else f"{base}/embeddings"

    async def embed(self, text: str) -> list[float]:
        trimmed = (text or "").strip()
        if not trimmed or not self.configured:
            return self._zero()
        client = self.client or httpx.AsyncClient(timeout=self.timeout_s)
        owns = self.client is None
        try:
            res = await client.post(
                self._url(),
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"},
                json={"model": self.model, "input": [trimmed]},  # array form is provider-safe
            )
            if res.status_code >= 400:
                return self._zero()
            data = res.json().get("data") if isinstance(res.json(), dict) else None
            vec = data[0].get("embedding") if isinstance(data, list) and data else None
            if not isinstance(vec, list) or len(vec) != self.dim:
                return self._zero()
            return [float(x) for x in vec]
        except Exception:  # noqa: BLE001 — graceful degradation
            return self._zero()
        finally:
            if owns:
                await client.aclose()


@dataclass(frozen=True)
class LLMConfig:
    chat_base_url: str
    chat_api_key: str
    chat_model: str
    chat_api_style: str
    embed_base_url: str
    embed_api_key: str
    embed_model: str
    embed_dim: int


@lru_cache
def get_llm_config() -> LLMConfig:
    chat_base = os.environ.get("LLM_BASE_URL", "").strip()
    chat_key = os.environ.get("LLM_API_KEY", "").strip()
    return LLMConfig(
        chat_base_url=chat_base,
        chat_api_key=chat_key,
        chat_model=os.environ.get("LLM_MODEL", "gpt-4o-mini").strip(),
        chat_api_style=os.environ.get("LLM_API_STYLE", "openai").strip(),
        embed_base_url=os.environ.get("EMBED_BASE_URL", chat_base).strip(),
        embed_api_key=os.environ.get("EMBED_API_KEY", chat_key).strip(),
        embed_model=os.environ.get("EMBED_MODEL", "text-embedding-3-small").strip(),
        embed_dim=int(os.environ.get("EMBED_DIM", "1536")),
    )


def create_chat_client(cfg: LLMConfig | None = None) -> ChatModelClient:
    c = cfg or get_llm_config()
    return ChatModelClient(base_url=c.chat_base_url, api_key=c.chat_api_key, model=c.chat_model, api_style=c.chat_api_style)


def create_embeddings_client(cfg: LLMConfig | None = None) -> EmbeddingsClient:
    c = cfg or get_llm_config()
    return EmbeddingsClient(base_url=c.embed_base_url, api_key=c.embed_api_key, model=c.embed_model, dim=c.embed_dim)

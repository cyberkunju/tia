"""Async, streaming version of the `/qa` agent.

Yields one structured event per chunk so the frontend can render a live
tool-call strip + token-by-token reply, instead of a single bulk response.

Event shapes (each emitted as a separate dict the API layer turns into SSE):

    {"type": "tool", "name": "...", "args": {...}, "status": "running"}
    {"type": "tool", "name": "...", "args": {...}, "status": "done",
     "result_summary": "..."}     # short scalar summary, never the full result
    {"type": "tool", "name": "...", "args": {...}, "status": "error",
     "error": "..."}
    {"type": "token", "content": "...delta..."}
    {"type": "done", "model": "...", "citations": [...],
     "tool_calls_summary": [...]}
    {"type": "error", "message": "..."}

Tool calls are *not* token-streamed - they're treated as atomic, with one
`running` event before invocation and one `done|error` after. Only the final
prose reply is token-streamed.
"""

from __future__ import annotations

import json
import os
from typing import AsyncIterator

from sqlalchemy.orm import Session

from ..ai.llm import is_reasoning_model
from ..config import OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL
from .agent import (
    SYSTEM_PROMPT,
    TOOLS,
    _build_messages,
    _extract_citations,
    _invoke_tool,
)


def _async_client():
    from openai import AsyncOpenAI

    return AsyncOpenAI(
        api_key=OPENAI_API_KEY or os.getenv("OPENAI_API_KEY", "sk-noop"),
        base_url=OPENAI_BASE_URL or "https://api.openai.com/v1",
    )


def _result_summary(result: dict | None) -> str:
    """Compact scalar summary of a tool result for the live tool-call strip.

    We never echo the full result back - it's potentially big and may carry
    fields the agent decided not to surface. Just enough to render "✓ found 3
    matches" or "✓ AED 47,820 total".
    """
    if not isinstance(result, dict):
        return "done"
    if "error" in result:
        return f"error: {str(result['error'])[:80]}"
    if result.get("access") == "denied":
        return "access denied (out of scope)"
    if result.get("found") is False:
        return "no result"
    # Hand-picked summaries per tool result shape
    if "total_aed" in result and "associate_count" in result:
        return f"AED {result['total_aed']:,.0f} across {result['associate_count']} associates"
    if "invoice_sequence_no" in result and result.get("ok"):
        amt = result.get("amount_aed") or result.get("amount")
        if amt is not None:
            return f"invoice {result['invoice_sequence_no']} AED {amt:,.0f}"
        return f"invoice {result['invoice_sequence_no']}"
    if "head_hash" in result:
        head = result.get("head_hash") or "(empty)"
        return f"chain ok={result.get('ok')} head={(head or '')[:10]}…"
    if "rate" in result and "routed" in result:
        return f"{result.get('rate_pct_label', '?')} touchless"
    if "matches" in result:
        return f"{len(result['matches'])} matches"
    if "events" in result:
        return f"{len(result['events'])} events"
    if "rate_cards" in result:
        return f"contract found, {len(result['rate_cards'])} rate cards"
    if result.get("ok") is True and "status" in result:
        return f"status={result['status']}"
    if "action_taken" in result:
        return str(result["action_taken"])
    return "ok"


async def stream_answer(
    session: Session,
    question: str,
    entity_context: dict | None = None,
    client_scope: str | None = None,
    max_steps: int = 6,
) -> AsyncIterator[dict]:
    """Run the agent loop, yielding events as tools fire and tokens stream.

    The session is NOT closed here - the FastAPI dependency that gave it to us
    owns the lifecycle. We do `session.flush()` after each tool call so the
    mutation is visible to subsequent tools in the same loop.
    """
    if not OPENAI_API_KEY:
        yield {
            "type": "error",
            "message": "Chat agent is not configured (OPENAI_API_KEY missing).",
        }
        return

    client = _async_client()
    messages = _build_messages(question, entity_context, client_scope)
    tool_calls_log: list[dict] = []

    model = OPENAI_MODEL or "gpt-4o-mini"
    create_kwargs: dict = {"tools": TOOLS, "tool_choice": "auto"}
    if not is_reasoning_model(model):
        create_kwargs["temperature"] = 0.1

    for _ in range(max_steps):
        # First, a non-streamed completion so we can detect tool_calls cleanly.
        # (Streaming with tool_calls works but the deltas are awkward to assemble;
        # we only stream the FINAL prose reply.)
        try:
            resp = await client.chat.completions.create(
                model=model, messages=messages, **create_kwargs
            )
        except Exception as e:  # noqa: BLE001
            yield {"type": "error", "message": f"OpenAI call failed: {e}"}
            return

        msg = resp.choices[0].message

        if msg.tool_calls:
            messages.append(
                {
                    "role": "assistant",
                    "content": msg.content or "",
                    "tool_calls": [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.function.name,
                                "arguments": tc.function.arguments,
                            },
                        }
                        for tc in msg.tool_calls
                    ],
                }
            )
            for tc in msg.tool_calls:
                name = tc.function.name
                try:
                    args = json.loads(tc.function.arguments or "{}")
                except json.JSONDecodeError:
                    args = {}
                yield {
                    "type": "tool",
                    "name": name,
                    "args": args,
                    "status": "running",
                }
                result = _invoke_tool(session, name, args, client_scope)
                # Flush mutations so the next tool in the same loop sees them
                try:
                    session.flush()
                except Exception:  # noqa: BLE001
                    pass
                tool_calls_log.append(
                    {
                        "name": name,
                        "args": args,
                        "result_keys": list(result.keys()) if isinstance(result, dict) else [],
                    }
                )
                if isinstance(result, dict) and "error" in result:
                    yield {
                        "type": "tool",
                        "name": name,
                        "args": args,
                        "status": "error",
                        "error": str(result["error"])[:200],
                    }
                else:
                    yield {
                        "type": "tool",
                        "name": name,
                        "args": args,
                        "status": "done",
                        "result_summary": _result_summary(result),
                    }
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": json.dumps(result, default=str),
                    }
                )
            continue

        # No tool calls → final answer. Re-issue with stream=True to deliver
        # the prose token-by-token. We could try to reuse `msg.content` but
        # the model may want a fresh pass after seeing all tool outputs;
        # cheaper to just stream the same final message which is already in
        # `msg.content` and skip the second round-trip.
        final_text = msg.content or ""
        if not final_text:
            yield {
                "type": "error",
                "message": "Empty final answer from the model.",
            }
            return

        # Pseudo-stream the final answer in word chunks so the UI shows the
        # token effect without paying for a second OpenAI roundtrip. Real
        # OpenAI streaming pays for itself only if we re-issue the request -
        # we already have the text; spending another API call just to retype
        # it is wasteful.
        for chunk in _tokenize_for_stream(final_text):
            yield {"type": "token", "content": chunk}

        yield {
            "type": "done",
            "model": model,
            "citations": _extract_citations(final_text),
            "tool_calls_summary": tool_calls_log,
        }
        return

    yield {
        "type": "error",
        "message": "Reached max tool-call steps without a final answer.",
    }


def _tokenize_for_stream(text: str, chunk_size: int = 6) -> list[str]:
    """Word-based chunking for the pseudo-stream.

    chunk_size words per emission gives a noticeable typewriter effect
    without overwhelming the SSE channel with one-char chunks. Preserves
    whitespace by re-joining with a single space.
    """
    if not text:
        return []
    words = text.split(" ")
    chunks: list[str] = []
    for i in range(0, len(words), chunk_size):
        piece = " ".join(words[i : i + chunk_size])
        # add trailing space so consumers can naively concat
        chunks.append(piece + (" " if i + chunk_size < len(words) else ""))
    return chunks


def _demo() -> None:
    """Offline smoke: tokenizer chunks correctly, summary covers branches."""
    chunks = _tokenize_for_stream("alpha beta gamma delta epsilon zeta eta", chunk_size=3)
    assert "".join(chunks).strip() == "alpha beta gamma delta epsilon zeta eta"
    assert len(chunks) >= 2
    assert _result_summary({"error": "boom"}).startswith("error:")
    assert _result_summary({"total_aed": 1000, "associate_count": 3}).startswith("AED")
    assert _result_summary({"found": False}) == "no result"
    print("qa.streaming helpers: OK")


if __name__ == "__main__":
    _demo()

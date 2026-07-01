"""Tiny fakes for the OpenAI-compatible chat client seam used by qa/agent.py,
qa/streaming.py, and extract/vision.py's LLM fallback.

The production code only touches:
    resp.choices[0].message.content
    resp.choices[0].message.tool_calls  -> [tc.id, tc.function.name, tc.function.arguments]

so we model exactly that surface. A "script" is a list of turns the fake
returns in order from successive `.create(...)` calls; each turn is either a
final-answer string, a list of ToolCall specs, or an Exception to raise.
"""

from __future__ import annotations

from typing import Any


class _Fn:
    def __init__(self, name: str, arguments: str):
        self.name = name
        self.arguments = arguments


class _ToolCall:
    def __init__(self, id: str, name: str, arguments: str):
        self.id = id
        self.type = "function"
        self.function = _Fn(name, arguments)


class _Msg:
    def __init__(self, content: str | None = None, tool_calls: list | None = None):
        self.content = content
        self.tool_calls = tool_calls or None


class _Choice:
    def __init__(self, msg: _Msg):
        self.message = msg
        self.delta = msg  # streaming reuse


class _Resp:
    def __init__(self, msg: _Msg):
        self.choices = [_Choice(msg)]


def tool_call(name: str, arguments: str = "{}", id: str | None = None) -> dict:
    """Spec for one tool call in a scripted turn."""
    return {"name": name, "arguments": arguments, "id": id or f"call_{name}"}


def _turn_to_resp(turn: Any) -> _Resp:
    if isinstance(turn, str):
        return _Resp(_Msg(content=turn))
    if isinstance(turn, dict) and turn.get("__final__") is not None:
        return _Resp(_Msg(content=turn["__final__"]))
    # a list of tool_call() dicts
    tcs = [_ToolCall(t["id"], t["name"], t["arguments"]) for t in turn]
    return _Resp(_Msg(content="", tool_calls=tcs))


class _Completions:
    def __init__(self, script: list[Any]):
        self._script = list(script)
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        turn = self._script.pop(0) if self._script else "done"
        if isinstance(turn, Exception):
            raise turn
        return _turn_to_resp(turn)


class _AsyncCompletions:
    def __init__(self, script: list[Any]):
        self._script = list(script)
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        turn = self._script.pop(0) if self._script else "done"
        if isinstance(turn, Exception):
            raise turn
        return _turn_to_resp(turn)


class FakeClient:
    """Sync fake OpenAI client. `client.chat.completions.create(...)`."""

    def __init__(self, script: list[Any]):
        self.chat = type("C", (), {"completions": _Completions(script)})()

    @property
    def calls(self) -> list[dict]:
        return self.chat.completions.calls


class FakeAsyncClient:
    """Async fake OpenAI client for streaming."""

    def __init__(self, script: list[Any]):
        self.chat = type("C", (), {"completions": _AsyncCompletions(script)})()

    @property
    def calls(self) -> list[dict]:
        return self.chat.completions.calls

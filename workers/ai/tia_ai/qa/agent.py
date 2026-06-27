"""TIA `/qa` chat agent — context-aware Q&A grounded in the DB.

Brief §4.8 cross-cutting requirement: "context-aware AI chat assistant that
understands the current client/invoice/timesheet context."

Design:
- LLM is OpenAI-compatible (env: OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL).
- We use **tool-calling**: the model can only call our 5 read-only DB tools.
- The system prompt forces a citation contract: every factual claim must be
  backed by a tool result, and if no tool returns relevant data the model
  must answer "no evidence in TIA's database."
- Returns: {answer, citations:[{kind,id,snippet}], tool_calls:[...]}
- Swap-ready for local models — point OPENAI_BASE_URL at a vLLM/Ollama server.
"""

from __future__ import annotations

import json
import os
from typing import Any

from sqlalchemy.orm import Session

from ..config import OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL
from ..ai.llm import is_reasoning_model
from ..models import (
    Client,
    Contract,
    Employee,
    Event,
    Invoice,
    RateCard,
    SOW,
    Timesheet,
)

SYSTEM_PROMPT = """You are TIA's grounded answer agent. TIA = Touchless Invoice Agent
for TASC Outsourcing UAE. You answer questions about timesheets, invoices,
contracts, and rules by calling the read-only database tools provided.

STRICT RULES:
1. Every factual claim MUST come from a tool result. Never invent IDs, amounts,
   names, or rules.
2. If no tool returns relevant data, answer EXACTLY: "I have no evidence in TIA's
   database for this question."
3. Cite your sources as [kind:id] inline, e.g. "Invoice [invoice:9c2d...] failed
   rule R4 with OT 50h vs cap 20%."
4. Prefer the smallest tool call set. Don't dump everything.
5. **REPLY IN PLAIN PROSE. NO MARKDOWN.** Do not use **bold**, *italics*,
   numbered lists, bullet points, headers (#), backticks, or any other markdown
   formatting. Just plain sentences. Use semicolons or paragraph breaks for
   structure if needed. The chat UI renders text verbatim — markdown leaks as
   raw asterisks which looks broken.
6. Be concise: short paragraphs, no marketing tone.
7. If you call get_invoice / get_contract / get_events / get_client_settings,
   you may use their `rule_results` / `payload` / `settings` JSON to cite specific
   rule IDs (R1..R10) or events.
"""


def _client() -> Any:
    from openai import OpenAI

    return OpenAI(
        api_key=OPENAI_API_KEY or os.getenv("OPENAI_API_KEY", "sk-noop"),
        base_url=OPENAI_BASE_URL or "https://api.openai.com/v1",
    )


# ---------- Tool implementations (DB-grounded, no LLM in here) ----------
#
# Every tool takes `scope` (a client_code or None). When scope is set — i.e. a Client
# persona is asking — the tool refuses to return data belonging to any other client.
# This is the data-isolation boundary: the LLM cannot widen its own scope because the
# server injects `scope`, never the model.

_DENIED = {"found": False, "access": "denied", "reason": "outside your client scope"}


def _inv_client(session: Session, entity_id: str) -> str | None:
    """Resolve the owning client_code for an invoice/timesheet/client entity id."""
    inv = (
        session.get(Invoice, entity_id)
        or session.query(Invoice).filter(Invoice.invoice_sequence_no == entity_id).first()
    )
    if inv:
        return inv.client_code
    ts = session.get(Timesheet, entity_id)
    if ts:
        return ts.client_code
    c = session.get(Client, entity_id)
    if c:
        return c.code
    return None


def tool_get_client_settings(session: Session, client_code: str, scope: str | None = None) -> dict:
    if scope and client_code != scope:
        return _DENIED
    c = session.get(Client, client_code)
    if not c:
        return {"found": False, "client_code": client_code}
    return {
        "found": True,
        "client_code": c.code,
        "name": c.name,
        "city": c.city,
        "industry": c.industry,
        "currency_default": c.currency_default,
        "settings": c.settings or {},
    }


def tool_get_contract(session: Session, client_code: str, scope: str | None = None) -> dict:
    if scope and client_code != scope:
        return _DENIED
    contract = (
        session.query(Contract)
        .filter(Contract.client_code == client_code, Contract.active.is_(True))
        .first()
    )
    if not contract:
        return {"found": False, "client_code": client_code}
    cards = session.query(RateCard).filter(RateCard.contract_id == contract.id).limit(20).all()
    sows = session.query(SOW).filter(SOW.contract_id == contract.id).all()
    return {
        "found": True,
        "id": contract.id,
        "client_code": contract.client_code,
        "name": contract.name,
        "type": contract.type,
        "jurisdiction": contract.jurisdiction,
        "currency": contract.currency,
        "vat_rate": contract.vat_rate,
        "sac_code": contract.sac_code,
        "markup_pct": contract.markup_pct,
        "max_ot_pct": contract.max_ot_pct,
        "payment_terms_days": contract.payment_terms_days,
        "billing_cadence": contract.billing_cadence,
        "start_date": contract.start_date,
        "end_date": contract.end_date,
        "authorized_emp_count": len(contract.authorized_emp_ids or []),
        "rate_cards": [
            {
                "labor_category": rc.labor_category,
                "regular_rate": rc.regular_rate,
                "ot_rate": rc.ot_rate,
                "night_rate": rc.night_rate,
                "holiday_rate": rc.holiday_rate,
            }
            for rc in cards
        ],
        "sows": [
            {
                "deliverable": s.deliverable,
                "hours_expected": s.hours_expected,
                "hours_consumed": s.hours_consumed,
                "status": s.status,
                "completed_at": s.completed_at,
            }
            for s in sows
        ],
    }


def tool_get_invoice(session: Session, invoice_id: str, scope: str | None = None) -> dict:
    inv = session.get(Invoice, invoice_id)
    if not inv:
        # also accept a sequence_no
        inv = session.query(Invoice).filter(Invoice.invoice_sequence_no == invoice_id).first()
    if not inv:
        return {"found": False, "invoice_id": invoice_id}
    if scope and inv.client_code != scope:
        return _DENIED
    return {
        "found": True,
        "id": inv.id,
        "invoice_sequence_no": inv.invoice_sequence_no,
        "client_code": inv.client_code,
        "period": inv.period,
        "amount": inv.amount,
        "vat_amount": inv.vat_amount,
        "total_incl_vat": inv.total_incl_vat,
        "currency": inv.currency,
        "status": inv.status,
        "client_approval_status": inv.client_approval_status,
        "line_item_count": len(inv.line_items or []),
        "rule_results": [
            {
                "rule_id": r.get("rule_id"),
                "rule_name": r.get("rule_name"),
                "passed": r.get("passed"),
                "severity": r.get("severity"),
                "message": r.get("message"),
            }
            for r in (inv.rule_results or [])
        ],
    }


def tool_get_timesheet(session: Session, timesheet_id: str, scope: str | None = None) -> dict:
    """Explain one timesheet: status, routing, confidence, why it was flagged, and a
    summary of its validations — so users can ask 'why is this in review?'."""
    ts = session.get(Timesheet, timesheet_id)
    if not ts:
        return {"found": False, "timesheet_id": timesheet_id}
    if scope and ts.client_code != scope:
        return _DENIED
    vals = ts.validations or []
    return {
        "found": True,
        "id": ts.id,
        "client_code": ts.client_code,
        "period": ts.period,
        "status": ts.status,
        "routing": ts.routing,
        "confidence": ts.confidence_calibrated,
        "hitl_reason": ts.hitl_reason,
        "row_count": len((ts.extraction or {}).get("rows", [])),
        "failed_validations": [
            {"rule": v.get("rule"), "message": v.get("message")}
            for v in vals
            if isinstance(v, dict) and v.get("passed") is False
        ],
    }


def tool_get_events(
    session: Session, entity_id: str, limit: int = 20, scope: str | None = None
) -> dict:
    if scope:
        owner = _inv_client(session, entity_id)
        # deny if the entity isn't resolvable to the caller's client
        if owner != scope:
            return _DENIED
    rows = (
        session.query(Event)
        .filter(Event.entity_id == entity_id)
        .order_by(Event.at.asc())
        .limit(limit)
        .all()
    )
    return {
        "found": bool(rows),
        "entity_id": entity_id,
        "events": [
            {
                "at": e.at.isoformat() if e.at else None,
                "actor": e.actor,
                "action": e.action,
                "payload_summary": (
                    {
                        k: v
                        for k, v in (e.payload or {}).items()
                        if k
                        in (
                            "amount",
                            "vat_amount",
                            "engine",
                            "client",
                            "reason",
                            "rules_run",
                            "blocking_failures",
                            "channel",
                            "outbox_path",
                            "sequence_no",
                        )
                    }
                ),
            }
            for e in rows
        ],
    }


def tool_search_employees(
    session: Session, query: str, limit: int = 8, scope: str | None = None
) -> dict:
    q = query.strip()
    qry = session.query(Employee).filter(
        (Employee.full_name.ilike(f"%{q}%"))
        | (Employee.emp_id.ilike(f"%{q}%"))
        | (Employee.email.ilike(f"%{q}%"))
    )
    if scope:
        qry = qry.filter(Employee.client_code == scope)
    rows = qry.limit(limit).all()
    return {
        "found": bool(rows),
        "query": query,
        "matches": [
            {
                "emp_id": e.emp_id,
                "full_name": e.full_name,
                "client_code": e.client_code,
                "job_title": e.job_title,
                "email": e.email,
            }
            for e in rows
        ],
    }


# ---------- OpenAI tool schema ----------


TOOLS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "get_client_settings",
            "description": "Lookup client by code. Returns name, jurisdiction, currency, TRN, watched mailboxes, dispatch rules.",
            "parameters": {
                "type": "object",
                "properties": {"client_code": {"type": "string", "description": "e.g. CL001"}},
                "required": ["client_code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_contract",
            "description": "Active contract for a client: rate card, SOWs, OT cap, markup, VAT rate, SAC code.",
            "parameters": {
                "type": "object",
                "properties": {"client_code": {"type": "string"}},
                "required": ["client_code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_invoice",
            "description": "Fetch invoice by UUID or sequence_no. Returns totals, status, and rule_results (R1..R10).",
            "parameters": {
                "type": "object",
                "properties": {"invoice_id": {"type": "string"}},
                "required": ["invoice_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_timesheet",
            "description": "Explain one timesheet by id: status, routing (auto/hitl/escalate), confidence, why it was flagged, and failed validations.",
            "parameters": {
                "type": "object",
                "properties": {"timesheet_id": {"type": "string"}},
                "required": ["timesheet_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_events",
            "description": "Append-only audit timeline for a doc/timesheet/invoice/client. Use after get_invoice to explain history.",
            "parameters": {
                "type": "object",
                "properties": {
                    "entity_id": {"type": "string"},
                    "limit": {"type": "integer", "default": 20},
                },
                "required": ["entity_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_employees",
            "description": "Fuzzy search employees by name, emp_id, or email.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "limit": {"type": "integer", "default": 8},
                },
                "required": ["query"],
            },
        },
    },
]

_DISPATCH = {
    "get_client_settings": tool_get_client_settings,
    "get_contract": tool_get_contract,
    "get_invoice": tool_get_invoice,
    "get_timesheet": tool_get_timesheet,
    "get_events": tool_get_events,
    "search_employees": tool_search_employees,
}


# ---------- Agent loop ----------


def answer(
    session: Session,
    question: str,
    entity_context: dict | None = None,
    max_steps: int = 5,
    client_scope: str | None = None,
) -> dict:
    """Run a tool-calling loop until the model returns a final answer.

    entity_context (optional): {"kind": "invoice|client|timesheet", "id": "..."}.
    If supplied, it's injected as a user-side hint so the agent doesn't have to
    guess which entity to look up first.

    client_scope (optional): a client_code. When set (Client persona), every tool is
    constrained to that client — the model cannot read another client's data. The
    server injects this into each tool call; the LLM never controls it.
    """
    if not OPENAI_API_KEY:
        return {
            "answer": "Chat agent is not configured (OPENAI_API_KEY missing).",
            "citations": [],
            "tool_calls": [],
        }

    client = _client()
    messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
    if client_scope:
        messages.append(
            {
                "role": "user",
                "content": (
                    f"[scope] You are answering for client {client_scope}. You may only "
                    f"discuss this client's data; anything else is access-denied."
                ),
            }
        )
    if entity_context:
        messages.append(
            {
                "role": "user",
                "content": (
                    f"[context] currently viewing {entity_context.get('kind')} "
                    f"id={entity_context.get('id')}"
                ),
            }
        )
    messages.append({"role": "user", "content": question})

    tool_calls_log: list[dict] = []

    model = OPENAI_MODEL or "gpt-4o-mini"
    # GPT-5 / o-series reasoning models reject a custom temperature (only the
    # default is allowed). Omit it for those; keep it deterministic elsewhere.
    create_kwargs: dict = {"tools": TOOLS, "tool_choice": "auto"}
    if not is_reasoning_model(model):
        create_kwargs["temperature"] = 0.1

    for _ in range(max_steps):
        resp = client.chat.completions.create(
            model=model,
            messages=messages,
            **create_kwargs,
        )
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
                fn = _DISPATCH.get(name)
                if not fn:
                    result = {"error": f"unknown tool {name}"}
                else:
                    try:
                        # scope is injected server-side, never from the model
                        result = fn(session, scope=client_scope, **args)
                    except Exception as e:  # noqa: BLE001
                        result = {"error": str(e)}
                tool_calls_log.append(
                    {
                        "name": name,
                        "args": args,
                        "result_keys": list(result.keys()) if isinstance(result, dict) else [],
                    }
                )
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": json.dumps(result, default=str),
                    }
                )
            continue
        # final answer
        return {
            "answer": msg.content or "",
            "citations": _extract_citations(msg.content or ""),
            "tool_calls": tool_calls_log,
            "model": model,
        }

    return {
        "answer": "Reached max tool-call steps without a final answer.",
        "citations": [],
        "tool_calls": tool_calls_log,
    }


_CITE_PAT = __import__("re").compile(r"\[(?P<kind>[a-zA-Z_]+):(?P<id>[A-Za-z0-9._\-]+)\]")


def _extract_citations(text: str) -> list[dict]:
    seen = set()
    out: list[dict] = []
    for m in _CITE_PAT.finditer(text or ""):
        k, i = m.group("kind"), m.group("id")
        key = (k, i)
        if key in seen:
            continue
        seen.add(key)
        out.append({"kind": k, "id": i})
    return out


def _demo() -> None:
    """Offline smoke: regex citation extraction works."""
    cites = _extract_citations("This invoice [invoice:abc123] failed [rule:R4].")
    assert {"kind": "invoice", "id": "abc123"} in cites
    assert {"kind": "rule", "id": "R4"} in cites
    print("qa agent citation regex: OK")


if __name__ == "__main__":
    _demo()

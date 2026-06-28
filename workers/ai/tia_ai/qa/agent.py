"""TIA `/qa` chat agent - context-aware Q&A grounded in the DB.

Brief §4.8 cross-cutting requirement: "context-aware AI chat assistant that
understands the current client/invoice/timesheet context."

Design:
- LLM is OpenAI-compatible (env: OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL).
- We use **tool-calling**: the model can call our read-only DB tools and a
  smaller set of mutating tools (recover_leakage, dispatch_invoice,
  clawback_invoice, approve_timesheet, resend_invoice_email).
- The system prompt forces a citation contract: every factual claim must be
  backed by a tool result, and if no tool returns relevant data the model
  must answer "no evidence in TIA's database."
- Every write tool emits `agent.<name>_invoked` to the audit chain so the
  agentic-mutation trail is provable.
- Returns: {answer, citations:[{kind,id,snippet}], tool_calls:[...]}
"""

from __future__ import annotations

import hashlib
import json
import os
import uuid
from typing import Any

from sqlalchemy.orm import Session

from ..ai.llm import is_reasoning_model
from ..config import OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL
from ..models import (
    Client,
    Contract,
    Employee,
    Event,
    Invoice,
    Payroll,
    RateCard,
    SOW,
    Timesheet,
)

SYSTEM_PROMPT = """You are TIA's grounded answer agent. TIA = Touchless Invoice Agent
for TASC Outsourcing UAE. You answer questions about timesheets, invoices,
contracts, rules, revenue leakage, and the audit chain by calling the tools
provided.

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
   structure if needed. The chat UI renders text verbatim - markdown leaks as
   raw asterisks which looks broken.
6. Be concise: short paragraphs, no marketing tone.
7. If you call get_invoice / get_contract / get_events / get_client_settings,
   you may use their `rule_results` / `payload` / `settings` JSON to cite specific
   rule IDs (R1..R10) or events.
8. WRITE TOOLS (`recover_leakage`, `dispatch_invoice`, `clawback_invoice`,
   `approve_timesheet`, `resend_invoice_email`) MUTATE state. Only call them
   when the user explicitly asks for an action - never speculatively. When you
   do, report the new sequence_no / status / chain head from the tool result.
"""


def _client() -> Any:
    from openai import OpenAI

    return OpenAI(
        api_key=OPENAI_API_KEY or os.getenv("OPENAI_API_KEY", "sk-noop"),
        base_url=OPENAI_BASE_URL or "https://api.openai.com/v1",
    )


# ---------- Tool implementations (DB-grounded) ----------
#
# Every tool takes `scope` (a client_code or None). When scope is set - i.e. a Client
# persona is asking - the tool refuses to return data belonging to any other client.
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


def _agent_caller(by_user: str | None) -> str:
    return by_user or "agent"


def _log_agent_invocation(
    session: Session,
    tool_name: str,
    entity_id: str,
    args: dict,
    result_status: str,
    by_user: str | None = None,
) -> None:
    """Append `agent.<tool>_invoked` to the audit chain.

    This is the agentic-mutation proof: every time the chat agent fires a write
    tool, the chain records who/what/when in a tamper-evident way. Result
    payload is kept tiny (just a status hint + args hash) - the full effect is
    captured by the underlying mutation's own event."""
    from ..orchestrator import log_event

    args_repr = json.dumps(args, sort_keys=True, default=str)
    args_hash = hashlib.sha256(args_repr.encode()).hexdigest()[:12]
    try:
        log_event(
            session,
            _agent_caller(by_user),
            "agent",
            entity_id,
            f"agent.{tool_name}_invoked",
            {
                "tool": tool_name,
                "args_hash": args_hash,
                "result_status": result_status,
            },
        )
    except Exception:  # noqa: BLE001
        pass


# ---------- Existing read tools (unchanged from prior shape) ---------------


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
    summary of its validations - so users can ask 'why is this in review?'."""
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


# ---------- New read tools ---------------------------------------------------


def tool_get_employee_history(
    session: Session, emp_id: str, limit: int = 6, scope: str | None = None
) -> dict:
    """Payroll + invoice-line history for one employee. Used by the agent to
    decide whether a leakage row is a one-off or a chronic miss."""
    emp = session.get(Employee, emp_id)
    if not emp:
        return {"found": False, "emp_id": emp_id}
    if scope and emp.client_code != scope:
        return _DENIED

    payrolls = (
        session.query(Payroll)
        .filter(Payroll.emp_id == emp_id)
        .order_by(Payroll.period.desc())
        .limit(limit)
        .all()
    )
    # Find invoice lines that billed this emp
    billed_periods: list[dict] = []
    seen_periods: set[str] = set()
    for inv in (
        session.query(Invoice)
        .filter(Invoice.voided_at.is_(None))
        .order_by(Invoice.created_at.desc())
        .all()
    ):
        for li in inv.line_items or []:
            if isinstance(li, dict) and li.get("emp_id") == emp_id:
                if inv.period and inv.period in seen_periods:
                    continue
                seen_periods.add(inv.period or "")
                billed_periods.append(
                    {
                        "period": inv.period,
                        "invoice_sequence_no": inv.invoice_sequence_no,
                        "amount": li.get("amount"),
                        "days_worked": li.get("days_worked"),
                        "ot_hours": li.get("ot_hours"),
                        "status": inv.status,
                    }
                )
                if len(billed_periods) >= limit:
                    break
        if len(billed_periods) >= limit:
            break
    return {
        "found": True,
        "emp_id": emp.emp_id,
        "full_name": emp.full_name,
        "client_code": emp.client_code,
        "job_title": emp.job_title,
        "total_ctc": emp.total_ctc,
        "payroll_history": [
            {
                "period": p.period,
                "gross": p.gross,
                "ot_hours": p.ot_hours,
                "ot_amount": p.ot_amount,
                "net_pay": p.net_pay,
                "working_days": p.working_days,
            }
            for p in payrolls
        ],
        "billed_history": billed_periods,
    }


def tool_find_revenue_leakage(
    session: Session, period: str, client_code: str | None = None, scope: str | None = None
) -> dict:
    """Walk the period's payroll and flag every associate that wasn't fully
    billed back to the client. Returns the LeakageReport as a dict."""
    if scope:
        # Client persona can only ask about their own client
        if client_code and client_code != scope:
            return _DENIED
        client_code = scope
    from ..finance import compute_revenue_leakage

    report = compute_revenue_leakage(session, period=period, client_code=client_code)
    d = report.model_dump()
    # Don't dump 200+ entries into the model context; keep the top 10
    d["entries"] = d["entries"][:10]
    d["total_entries_truncated_to"] = 10
    return d


def tool_verify_audit_chain(session: Session, scope: str | None = None) -> dict:  # noqa: ARG001
    """Re-walk the audit chain and report tamper-evidence + chain head.

    Not scoped - the chain is system-wide. Returns counts only, no per-event
    payload, so it's safe to expose to any persona.
    """
    from ..audit import verify_audit_chain

    rep = verify_audit_chain(session) or {}
    return {
        "ok": bool(rep.get("ok")),
        "total_events": int(rep.get("total") or 0),
        "head_hash": rep.get("head"),
        "error_count": len(rep.get("errors") or []),
        "errors": (rep.get("errors") or [])[:5],
    }


def tool_metrics_stp(session: Session, scope: str | None = None) -> dict:  # noqa: ARG001
    """Touchless / straight-through rate over routed documents.

    Mirrors `/metrics/stp`. Returns the rate as 0..1 plus the routed/auto counts.
    """
    from ..models import Timesheet as Ts

    rows = session.query(Ts).filter(Ts.routing.is_not(None)).all()
    routed = len(rows)
    auto = sum(1 for r in rows if r.routing == "auto")
    rate = (auto / routed) if routed else 0.0
    return {
        "routed": routed,
        "auto": auto,
        "rate": round(rate, 4),
        "rate_pct_label": f"{rate * 100:.1f}%",
    }


def tool_list_clients(session: Session, scope: str | None = None) -> dict:
    """List clients TASC bills. Scoped: a Client persona only sees themselves."""
    q = session.query(Client)
    if scope:
        q = q.filter(Client.code == scope)
    rows = q.all()
    return {
        "found": bool(rows),
        "clients": [
            {
                "code": c.code,
                "name": c.name,
                "industry": c.industry,
                "city": c.city,
                "currency": c.currency_default,
            }
            for c in rows
        ],
    }


def tool_prepare_sap_b1_payload(
    session: Session, invoice_id: str, scope: str | None = None
) -> dict:
    """Generate the SAP Business One A/R Invoice OData v4 payload for this
    invoice. Read-only (we don't POST to SAP from here).
    """
    inv = session.get(Invoice, invoice_id)
    if not inv:
        inv = session.query(Invoice).filter(Invoice.invoice_sequence_no == invoice_id).first()
    if not inv:
        return {"found": False, "invoice_id": invoice_id}
    if scope and inv.client_code != scope:
        return _DENIED

    from ..integrations.sap_b1 import prepare_invoice_payload

    try:
        payload = prepare_invoice_payload(inv, session)
    except ValueError as e:
        return {"found": True, "ok": False, "error": str(e)}
    return {
        "found": True,
        "ok": True,
        "invoice_id": inv.id,
        "invoice_sequence_no": inv.invoice_sequence_no,
        "endpoint": "POST /b1s/v2/Invoices",
        "payload": payload,
    }


# ---------- Write tools (each logs agent.<name>_invoked) -------------------


def tool_recover_leakage(
    session: Session,
    emp_id: str,
    period: str,
    reason: str = "no_timesheet",
    scope: str | None = None,
) -> dict:
    """Issue a catch-up "recovery" invoice for one (emp, period) and chain the
    audit event. Returns the new invoice_sequence_no + amount + chain head."""
    emp = session.get(Employee, emp_id)
    if not emp:
        return {"ok": False, "reason": f"unknown employee {emp_id}"}
    if scope and emp.client_code != scope:
        return _DENIED

    from ..finance import build_recovery_invoice
    from ..finance.leakage import LeakageReason

    try:
        invoice = build_recovery_invoice(
            session,
            emp_id=emp_id,
            period=period,
            reason=LeakageReason(reason) if isinstance(reason, str) else reason,
            by_user="agent",
        )
    except (ValueError, KeyError) as e:
        _log_agent_invocation(
            session, "recover_leakage", emp_id, {"period": period, "reason": reason}, "error"
        )
        return {"ok": False, "reason": str(e)}

    _log_agent_invocation(
        session,
        "recover_leakage",
        invoice.id,
        {"emp_id": emp_id, "period": period, "reason": reason},
        "ok",
    )

    # Fetch fresh audit head
    audit_head = None
    try:
        from ..audit import verify_audit_chain

        audit_head = (verify_audit_chain(session) or {}).get("head")
    except Exception:  # noqa: BLE001
        pass

    return {
        "ok": True,
        "invoice_id": invoice.id,
        "invoice_sequence_no": invoice.invoice_sequence_no,
        "amount_aed": invoice.amount,
        "status": invoice.status,
        "audit_chain_head": audit_head,
    }


def tool_dispatch_invoice(session: Session, invoice_id: str, scope: str | None = None) -> dict:
    """Force-dispatch an invoice (idempotent on the invoice id). Useful when an
    invoice is generated but never auto-dispatched (over-threshold / awaiting
    finance approval that already happened off-system)."""
    from ..orchestrator import dispatch_invoice as _dispatch

    inv = session.get(Invoice, invoice_id) or (
        session.query(Invoice).filter(Invoice.invoice_sequence_no == invoice_id).first()
    )
    if not inv:
        return {"ok": False, "reason": f"invoice {invoice_id} not found"}
    if scope and inv.client_code != scope:
        return _DENIED

    key = f"agent-dispatch:{inv.id}:{uuid.uuid4().hex[:8]}"
    try:
        result = _dispatch(session, inv, by_user="agent", idempotency_key=key)
    except Exception as e:  # noqa: BLE001
        _log_agent_invocation(
            session, "dispatch_invoice", inv.id, {"invoice_id": invoice_id}, "error"
        )
        return {"ok": False, "reason": str(e)}

    _log_agent_invocation(session, "dispatch_invoice", inv.id, {"invoice_id": invoice_id}, "ok")
    return {"ok": True, "invoice_id": inv.id, **result}


def tool_clawback_invoice(
    session: Session,
    invoice_id: str,
    reason_code: str = "PRICING_ERROR",
    partial_amount: float | None = None,
    scope: str | None = None,
) -> dict:
    """Clawback - simplified agent path.

    Pre-dispatch invoices get voided in-place; dispatched invoices return a
    `requires_console` action since the credit-note path needs the FinOps UI
    for reason text + adjustment_type selection.
    """
    import datetime as dt

    from ..invoice.fsm import PRE_DISPATCH_STATES, InvalidTransition, set_status

    inv = session.get(Invoice, invoice_id) or (
        session.query(Invoice).filter(Invoice.invoice_sequence_no == invoice_id).first()
    )
    if not inv:
        return {"ok": False, "reason": f"invoice {invoice_id} not found"}
    if scope and inv.client_code != scope:
        return _DENIED
    if inv.status in {"voided", "superseded"}:
        return {"ok": True, "action_taken": "already_settled", "status": inv.status}

    if inv.status in PRE_DISPATCH_STATES:
        before = {"status": inv.status}
        try:
            set_status(session, inv, "voided")
        except InvalidTransition as e:
            _log_agent_invocation(
                session,
                "clawback_invoice",
                inv.id,
                {"invoice_id": invoice_id, "reason_code": reason_code},
                "error",
            )
            return {"ok": False, "reason": str(e)}
        inv.voided_at = dt.datetime.now(dt.timezone.utc)
        inv.voided_by = "agent"
        inv.voided_reason_code = reason_code
        inv.voided_reason = f"Agent-initiated void ({reason_code})"
        from ..orchestrator import log_event

        log_event(
            session,
            "agent",
            "invoice",
            inv.id,
            "invoice.voided",
            {
                "reason_code": reason_code,
                "source": "agent",
                "sequence_no": inv.invoice_sequence_no,
            },
            before=before,
            after={"status": inv.status, "voided_by": "agent"},
        )
        _log_agent_invocation(
            session,
            "clawback_invoice",
            inv.id,
            {"invoice_id": invoice_id, "reason_code": reason_code},
            "ok",
        )
        return {
            "ok": True,
            "action_taken": "voided",
            "invoice_id": inv.id,
            "status": inv.status,
            "voided_at": inv.voided_at.isoformat(),
        }

    # Post-dispatch: defer to the human console (credit-note flow needs more inputs)
    _log_agent_invocation(
        session,
        "clawback_invoice",
        inv.id,
        {"invoice_id": invoice_id, "reason_code": reason_code, "status": inv.status},
        "deferred",
    )
    return {
        "ok": False,
        "action_taken": "requires_console",
        "reason": (
            f"Invoice is already {inv.status}. Post-dispatch clawback (credit note "
            f"per UAE Art. 60) requires the FinOps console for reason text and "
            f"adjustment_type selection."
        ),
        "invoice_id": inv.id,
    }


def tool_approve_timesheet(
    session: Session,
    timesheet_id: str,
    override_justification: str | None = None,
    scope: str | None = None,
) -> dict:
    """Approve a HITL timesheet and regenerate its invoice. Idempotency-keyed
    on the timesheet id so a duplicate agent call is safe."""
    from ..orchestrator import approve_timesheet as _approve

    ts = session.get(Timesheet, timesheet_id)
    if not ts:
        return {"ok": False, "reason": f"timesheet {timesheet_id} not found"}
    if scope and ts.client_code != scope:
        return _DENIED
    if ts.status == "approved":
        return {"ok": True, "action_taken": "already_approved", "timesheet_id": ts.id}

    key = f"agent-approve:{ts.id}"
    try:
        invoice = _approve(
            session,
            ts,
            by_user="agent",
            corrections=None,
            idempotency_key=key,
        )
    except (ValueError, Exception) as e:  # noqa: BLE001
        _log_agent_invocation(
            session,
            "approve_timesheet",
            ts.id,
            {"timesheet_id": timesheet_id, "justification": override_justification},
            "error",
        )
        return {"ok": False, "reason": str(e)}

    _log_agent_invocation(
        session,
        "approve_timesheet",
        ts.id,
        {"timesheet_id": timesheet_id, "justification": override_justification},
        "ok",
    )
    return {
        "ok": True,
        "timesheet_id": ts.id,
        "status": ts.status,
        "invoice_id": invoice.id,
        "invoice_sequence_no": invoice.invoice_sequence_no,
        "amount_aed": invoice.amount,
    }


def tool_resend_invoice_email(session: Session, invoice_id: str, scope: str | None = None) -> dict:
    """Force a re-send of the invoice email with a fresh idempotency key.

    Mirrors the behaviour of `POST /invoices/{id}/resend-email`."""
    import datetime as dt

    inv = session.get(Invoice, invoice_id) or (
        session.query(Invoice).filter(Invoice.invoice_sequence_no == invoice_id).first()
    )
    if not inv:
        return {"ok": False, "reason": f"invoice {invoice_id} not found"}
    if scope and inv.client_code != scope:
        return _DENIED

    from ..mailbox.sender import send_invoice_email

    ts = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d%H%M%S")
    key = f"agent-resend:{inv.id}:{ts}"
    try:
        res = send_invoice_email(session, inv, idempotency_key=key, by_user="agent")
    except Exception as e:  # noqa: BLE001
        _log_agent_invocation(
            session, "resend_invoice_email", inv.id, {"invoice_id": invoice_id}, "error"
        )
        return {"ok": False, "reason": str(e)}

    status = "ok" if res.get("sent") else "skipped"
    _log_agent_invocation(
        session,
        "resend_invoice_email",
        inv.id,
        {"invoice_id": invoice_id},
        status,
    )
    return {
        "ok": bool(res.get("sent")),
        "to": res.get("to"),
        "message_id": res.get("message_id"),
        "reason": res.get("reason") or res.get("skipped"),
    }


# ---------- OpenAI tool schema ----------


TOOLS: list[dict] = [
    # ---------- READS ----------
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
    {
        "type": "function",
        "function": {
            "name": "get_employee_history",
            "description": "Payroll + billed-invoice history for one employee. Used to decide if a leakage is a one-off or a chronic miss.",
            "parameters": {
                "type": "object",
                "properties": {
                    "emp_id": {"type": "string", "description": "e.g. EMP10001"},
                    "limit": {"type": "integer", "default": 6},
                },
                "required": ["emp_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "find_revenue_leakage",
            "description": "Walk a period's payroll and flag every associate that wasn't fully billed back. Returns top 10 entries + per-client aggregates + trailing baseline.",
            "parameters": {
                "type": "object",
                "properties": {
                    "period": {"type": "string", "description": "e.g. 'June 2026'"},
                    "client_code": {
                        "type": "string",
                        "description": "optional - restrict to one client",
                    },
                },
                "required": ["period"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "verify_audit_chain",
            "description": "Re-walk the tamper-evident audit chain. Returns ok flag, total events, head hash, and any chain breaks.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "metrics_stp",
            "description": "Touchless (straight-through-processing) rate: count of timesheets that routed auto vs total routed.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_clients",
            "description": "Roster of clients TASC bills. Scoped to the caller's client when the Client persona asks.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "prepare_sap_b1_payload",
            "description": "Generate the SAP Business One A/R Invoice OData v4 payload for a given invoice. Read-only - returns the JSON body.",
            "parameters": {
                "type": "object",
                "properties": {"invoice_id": {"type": "string"}},
                "required": ["invoice_id"],
            },
        },
    },
    # ---------- WRITES ----------
    {
        "type": "function",
        "function": {
            "name": "recover_leakage",
            "description": "WRITE. Issue a catch-up 'recovery' invoice for one (emp, period). Use after find_revenue_leakage surfaces an unbilled associate.",
            "parameters": {
                "type": "object",
                "properties": {
                    "emp_id": {"type": "string"},
                    "period": {"type": "string"},
                    "reason": {
                        "type": "string",
                        "enum": [
                            "no_timesheet",
                            "partial_timesheet",
                            "missing_overtime",
                            "rate_undercharge",
                            "late_period",
                        ],
                        "default": "no_timesheet",
                    },
                },
                "required": ["emp_id", "period"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "dispatch_invoice",
            "description": "WRITE. Force-dispatch an invoice (idempotent). Use when an invoice is generated but not auto-dispatched.",
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
            "name": "clawback_invoice",
            "description": "WRITE. Clawback an invoice. Pre-dispatch → voided in-place. Post-dispatch → returns requires_console (credit-note flow needs the FinOps UI).",
            "parameters": {
                "type": "object",
                "properties": {
                    "invoice_id": {"type": "string"},
                    "reason_code": {
                        "type": "string",
                        "enum": [
                            "PRICING_ERROR",
                            "GOODS_RETURNED",
                            "DISCOUNT",
                            "DUPLICATE",
                            "OTHER",
                        ],
                        "default": "PRICING_ERROR",
                    },
                    "partial_amount": {"type": "number"},
                },
                "required": ["invoice_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "approve_timesheet",
            "description": "WRITE. Approve a HITL timesheet and regenerate its invoice. Idempotency-keyed on the timesheet id.",
            "parameters": {
                "type": "object",
                "properties": {
                    "timesheet_id": {"type": "string"},
                    "override_justification": {"type": "string"},
                },
                "required": ["timesheet_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "resend_invoice_email",
            "description": "WRITE. Re-send the invoice email with a fresh idempotency key (bypasses the dispatch idempotency cache).",
            "parameters": {
                "type": "object",
                "properties": {"invoice_id": {"type": "string"}},
                "required": ["invoice_id"],
            },
        },
    },
]


_DISPATCH: dict = {
    # reads
    "get_client_settings": tool_get_client_settings,
    "get_contract": tool_get_contract,
    "get_invoice": tool_get_invoice,
    "get_timesheet": tool_get_timesheet,
    "get_events": tool_get_events,
    "search_employees": tool_search_employees,
    "get_employee_history": tool_get_employee_history,
    "find_revenue_leakage": tool_find_revenue_leakage,
    "verify_audit_chain": tool_verify_audit_chain,
    "metrics_stp": tool_metrics_stp,
    "list_clients": tool_list_clients,
    "prepare_sap_b1_payload": tool_prepare_sap_b1_payload,
    # writes
    "recover_leakage": tool_recover_leakage,
    "dispatch_invoice": tool_dispatch_invoice,
    "clawback_invoice": tool_clawback_invoice,
    "approve_timesheet": tool_approve_timesheet,
    "resend_invoice_email": tool_resend_invoice_email,
}


# Used by the MCP server + streaming layer to mark per-tool annotations.
WRITE_TOOLS: frozenset[str] = frozenset(
    {
        "recover_leakage",
        "dispatch_invoice",
        "clawback_invoice",
        "approve_timesheet",
        "resend_invoice_email",
    }
)


# Alias the dispatch table under a less-private name so the MCP wrappers in
# `tia_ai/mcp/server.py` can iterate it without reaching into _DISPATCH.
TOOL_REGISTRY = _DISPATCH


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
    constrained to that client - the model cannot read another client's data. The
    server injects this into each tool call; the LLM never controls it.
    """
    if not OPENAI_API_KEY:
        return {
            "answer": "Chat agent is not configured (OPENAI_API_KEY missing).",
            "citations": [],
            "tool_calls": [],
        }

    client = _client()
    messages = _build_messages(question, entity_context, client_scope)
    tool_calls_log: list[dict] = []

    model = OPENAI_MODEL or "gpt-4o-mini"
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
                result = _invoke_tool(session, name, args, client_scope)
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


def _build_messages(
    question: str,
    entity_context: dict | None,
    client_scope: str | None,
) -> list[dict]:
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
    return messages


def _invoke_tool(session: Session, name: str, args: dict, client_scope: str | None) -> dict:
    fn = _DISPATCH.get(name)
    if not fn:
        return {"error": f"unknown tool {name}"}
    try:
        return fn(session, scope=client_scope, **args)
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


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
    assert "recover_leakage" in WRITE_TOOLS
    assert "get_invoice" not in WRITE_TOOLS
    assert "find_revenue_leakage" in TOOL_REGISTRY
    print("qa agent citation regex + write/read split: OK")


if __name__ == "__main__":
    _demo()

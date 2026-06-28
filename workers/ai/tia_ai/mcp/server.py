"""MCP @tool wrappers - one per `qa.agent` tool.

Each wrapper opens its own short-lived `Session` (the underlying `qa.agent`
tools expect one). FastMCP infers the input schema from the type hints; we
also pass `annotations` so MCP clients can show "this is a write tool" badges.

Tool inventory (kept in lockstep with `qa.agent.TOOL_REGISTRY`):

  reads:  get_client_settings, get_contract, get_invoice, get_timesheet,
          get_events, search_employees, get_employee_history,
          find_revenue_leakage, verify_audit_chain, metrics_stp,
          list_clients, prepare_sap_b1_payload
  writes: recover_leakage, dispatch_invoice, clawback_invoice,
          approve_timesheet, resend_invoice_email
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

from ..db import SessionLocal
from ..qa.agent import (
    tool_dispatch_invoice,
    tool_find_revenue_leakage,
    tool_finance_queue,
    tool_get_client_settings,
    tool_get_contract,
    tool_get_employee_history,
    tool_get_events,
    tool_get_invoice,
    tool_get_timesheet,
    tool_list_clients,
    tool_list_documents,
    tool_list_invoices,
    tool_metrics_stp,
    tool_prepare_sap_b1_payload,
    tool_recover_leakage,
    tool_reject_timesheet,
    tool_resend_invoice_email,
    tool_search_employees,
    tool_verify_audit_chain,
    tool_approve_timesheet,
    tool_clawback_invoice,
)
from . import mcp


@contextmanager
def _session() -> Iterator:
    """Short-lived SQLAlchemy session - commits on success, rolls back on error.

    MCP tool invocations aren't tied to a FastAPI request lifecycle, so we
    own the session manually here.
    """
    s = SessionLocal()
    try:
        yield s
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


# ---------- READS ------------------------------------------------------------


@mcp.tool(
    name="get_client_settings",
    description="Lookup a TIA client by code. Returns name, jurisdiction, currency, TRN, dispatch rules.",
    annotations={"readOnlyHint": True, "destructiveHint": False},
)
def get_client_settings(client_code: str) -> dict:
    """Look up one client by code (e.g. CL001)."""
    with _session() as s:
        return tool_get_client_settings(s, client_code=client_code)


@mcp.tool(
    name="get_contract",
    description="Active contract for a client: rate card, SOWs, OT cap, markup, VAT rate, SAC code.",
    annotations={"readOnlyHint": True, "destructiveHint": False},
)
def get_contract(client_code: str) -> dict:
    """Fetch the active contract for one client."""
    with _session() as s:
        return tool_get_contract(s, client_code=client_code)


@mcp.tool(
    name="get_invoice",
    description="Fetch invoice by UUID or sequence_no. Returns totals, status, and rule_results (R1..R10).",
    annotations={"readOnlyHint": True, "destructiveHint": False},
)
def get_invoice(invoice_id: str) -> dict:
    """Fetch one invoice (id or sequence_no)."""
    with _session() as s:
        return tool_get_invoice(s, invoice_id=invoice_id)


@mcp.tool(
    name="get_timesheet",
    description="Explain one timesheet: status, routing, confidence, hitl_reason, failed validations.",
    annotations={"readOnlyHint": True, "destructiveHint": False},
)
def get_timesheet(timesheet_id: str) -> dict:
    """Fetch one timesheet."""
    with _session() as s:
        return tool_get_timesheet(s, timesheet_id=timesheet_id)


@mcp.tool(
    name="get_events",
    description="Append-only audit timeline for any doc/timesheet/invoice/client entity id.",
    annotations={"readOnlyHint": True, "destructiveHint": False},
)
def get_events(entity_id: str, limit: int = 20) -> dict:
    """List events for one entity (chain-ordered)."""
    with _session() as s:
        return tool_get_events(s, entity_id=entity_id, limit=limit)


@mcp.tool(
    name="search_employees",
    description="Fuzzy search employees by name, emp_id, or email.",
    annotations={"readOnlyHint": True, "destructiveHint": False},
)
def search_employees(query: str, limit: int = 8) -> dict:
    """Find employees matching a name/id/email substring."""
    with _session() as s:
        return tool_search_employees(s, query=query, limit=limit)


@mcp.tool(
    name="get_employee_history",
    description="Payroll + billed-invoice history for one employee.",
    annotations={"readOnlyHint": True, "destructiveHint": False},
)
def get_employee_history(emp_id: str, limit: int = 6) -> dict:
    """History of one employee across payroll periods + billed invoices."""
    with _session() as s:
        return tool_get_employee_history(s, emp_id=emp_id, limit=limit)


@mcp.tool(
    name="find_revenue_leakage",
    description="Walk a period's payroll and flag every associate that wasn't fully billed back to the client. Returns top 10 + per-client aggregates.",
    annotations={"readOnlyHint": True, "destructiveHint": False},
)
def find_revenue_leakage(period: str, client_code: str | None = None) -> dict:
    """Scan revenue leakage for one period (optionally one client)."""
    with _session() as s:
        return tool_find_revenue_leakage(s, period=period, client_code=client_code)


@mcp.tool(
    name="verify_audit_chain",
    description="Re-walk the tamper-evident audit chain. Returns ok flag, total events, head hash, errors.",
    annotations={"readOnlyHint": True, "destructiveHint": False},
)
def verify_audit_chain() -> dict:
    """Verify the audit chain end-to-end and return the chain head."""
    with _session() as s:
        return tool_verify_audit_chain(s)


@mcp.tool(
    name="metrics_stp",
    description="Touchless / straight-through-processing rate over routed documents.",
    annotations={"readOnlyHint": True, "destructiveHint": False},
)
def metrics_stp() -> dict:
    """Compute the touchless rate."""
    with _session() as s:
        return tool_metrics_stp(s)


@mcp.tool(
    name="list_clients",
    description="Roster of clients TASC bills.",
    annotations={"readOnlyHint": True, "destructiveHint": False},
)
def list_clients() -> dict:
    """List all clients."""
    with _session() as s:
        return tool_list_clients(s)


@mcp.tool(
    name="list_invoices",
    description="List invoices, newest first. USE THIS for 'do I have overdue invoices', 'show me my latest bills', 'what's pending dispatch'. Filters: client_code, status, limit.",
    annotations={"readOnlyHint": True, "destructiveHint": False},
)
def list_invoices(
    client_code: str | None = None,
    status: str | None = None,
    limit: int = 20,
) -> dict:
    """List invoices with optional filters."""
    with _session() as s:
        return tool_list_invoices(s, client_code=client_code, status=status, limit=limit)


@mcp.tool(
    name="prepare_sap_b1_payload",
    description="Generate the SAP Business One A/R Invoice OData v4 payload for a given invoice (read-only).",
    annotations={"readOnlyHint": True, "destructiveHint": False},
)
def prepare_sap_b1_payload(invoice_id: str) -> dict:
    """Map a TIA invoice to a SAP B1 POST /b1s/v2/Invoices body."""
    with _session() as s:
        return tool_prepare_sap_b1_payload(s, invoice_id=invoice_id)


@mcp.tool(
    name="list_documents",
    description="The FinOps pipeline & review/approval queue: documents with their timesheet status + routing. Filter status='awaiting_review' (or routing='hitl') to see exactly what needs human review. USE THIS before approve_timesheet / reject_timesheet.",
    annotations={"readOnlyHint": True, "destructiveHint": False},
)
def list_documents(status: str | None = None, routing: str | None = None, limit: int = 50) -> dict:
    """List documents + timesheet status/routing (the pipeline/review queue)."""
    with _session() as s:
        return tool_list_documents(s, status=status, routing=routing, limit=limit)


@mcp.tool(
    name="finance_queue",
    description="Invoices at/above the client threshold or with rule exceptions awaiting Finance sign-off before dispatch (the web 'Finance approvals' queue).",
    annotations={"readOnlyHint": True, "destructiveHint": False},
)
def finance_queue() -> dict:
    """List invoices needing Finance approval."""
    with _session() as s:
        return tool_finance_queue(s)


# ---------- WRITES -----------------------------------------------------------


@mcp.tool(
    name="recover_leakage",
    description="WRITE. Issue a catch-up 'recovery' invoice for one (emp_id, period). Logs invoice.recovery_issued + agent.recover_leakage_invoked on the audit chain.",
    annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False},
)
def recover_leakage(emp_id: str, period: str, reason: str = "no_timesheet") -> dict:
    """Issue a recovery invoice for one unbilled associate-period."""
    with _session() as s:
        return tool_recover_leakage(s, emp_id=emp_id, period=period, reason=reason)


@mcp.tool(
    name="dispatch_invoice",
    description="WRITE. Force-dispatch an invoice (idempotent on the invoice id).",
    annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True},
)
def dispatch_invoice(invoice_id: str) -> dict:
    """Force-dispatch a generated invoice."""
    with _session() as s:
        return tool_dispatch_invoice(s, invoice_id=invoice_id)


@mcp.tool(
    name="clawback_invoice",
    description="WRITE. Clawback an invoice. Pre-dispatch → voided in-place. Post-dispatch → returns requires_console.",
    annotations={"readOnlyHint": False, "destructiveHint": True, "idempotentHint": False},
)
def clawback_invoice(
    invoice_id: str,
    reason_code: str = "PRICING_ERROR",
    partial_amount: float | None = None,
) -> dict:
    """Clawback one invoice (void or defer to console depending on state)."""
    with _session() as s:
        return tool_clawback_invoice(
            s,
            invoice_id=invoice_id,
            reason_code=reason_code,
            partial_amount=partial_amount,
        )


@mcp.tool(
    name="approve_timesheet",
    description="WRITE. Approve a HITL timesheet and regenerate its invoice. Idempotency-keyed on the timesheet id.",
    annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True},
)
def approve_timesheet(timesheet_id: str, override_justification: str | None = None) -> dict:
    """Approve a HITL timesheet (idempotent)."""
    with _session() as s:
        return tool_approve_timesheet(
            s, timesheet_id=timesheet_id, override_justification=override_justification
        )


@mcp.tool(
    name="reject_timesheet",
    description="WRITE. Reject a HITL timesheet with a reason (the web 'reject' action). Records it on the audit chain and notifies the WhatsApp sender if the submission came from WhatsApp.",
    annotations={"readOnlyHint": False, "destructiveHint": True, "idempotentHint": False},
)
def reject_timesheet(timesheet_id: str, reason: str) -> dict:
    """Reject a HITL timesheet with a reason."""
    with _session() as s:
        return tool_reject_timesheet(s, timesheet_id=timesheet_id, reason=reason)


@mcp.tool(
    name="resend_invoice_email",
    description="WRITE. Re-send the invoice email with a fresh idempotency key.",
    annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False},
)
def resend_invoice_email(invoice_id: str) -> dict:
    """Resend the invoice email (bypasses the dispatch idempotency cache)."""
    with _session() as s:
        return tool_resend_invoice_email(s, invoice_id=invoice_id)


__all__ = [
    "get_client_settings",
    "get_contract",
    "get_invoice",
    "get_timesheet",
    "get_events",
    "search_employees",
    "get_employee_history",
    "find_revenue_leakage",
    "verify_audit_chain",
    "metrics_stp",
    "list_clients",
    "list_documents",
    "finance_queue",
    "prepare_sap_b1_payload",
    "recover_leakage",
    "dispatch_invoice",
    "clawback_invoice",
    "approve_timesheet",
    "reject_timesheet",
    "resend_invoice_email",
]

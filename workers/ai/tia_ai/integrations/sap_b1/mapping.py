"""TIA `Invoice` → SAP Business One A/R Invoice payload (OData v4).

The shape mirrors the SAP B1 Service Layer's `Invoices` endpoint body:

    POST /b1s/v2/Invoices
    {
      "CardCode": "<BusinessPartner.CardCode>",
      "DocDate": "YYYY-MM-DD",
      "DocDueDate": "YYYY-MM-DD",
      "DocCurrency": "AED",
      "NumAtCard": "<buyer-side reference>",
      "Comments": "<free text>",
      "U_TIA_AuditHash": "<audit-chain head at issue time>",
      "DocumentLines": [
        {
          "ItemCode": "<emp_id>",
          "ItemDescription": "<employee_name | job_title>",
          "Quantity": <days_worked>,
          "UnitPrice": <prorated / days_worked>,
          "VatGroup": "S1",
          "TaxCode": "S1",
          "LineTotal": <amount>
        },
        ...
      ]
    }

The User-Defined Field `U_TIA_AuditHash` carries the audit-chain head at the
time the payload was prepared - a downstream auditor can verify the line of
custody by re-walking the chain back to that hash.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from sqlalchemy.orm import Session

from ...audit import verify_audit_chain
from ...models import Client, Contract, Invoice


def _due_date(invoice: Invoice, contract: Contract | None) -> str:
    """Compute DocDueDate = DocDate + payment_terms_days (defaults to 30)."""
    base = invoice.created_at or dt.datetime.now(dt.timezone.utc)
    terms = (contract.payment_terms_days if contract else None) or 30
    return (base + dt.timedelta(days=int(terms))).date().isoformat()


def _doc_date(invoice: Invoice) -> str:
    base = invoice.created_at or dt.datetime.now(dt.timezone.utc)
    return base.date().isoformat()


def _to_lines(invoice: Invoice) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []
    for li in invoice.line_items or []:
        if not isinstance(li, dict):
            continue
        emp_id = li.get("emp_id") or "UNKNOWN"
        days = float(li.get("days_worked") or 0.0) or float(li.get("standard_days") or 1.0)
        amount = float(li.get("amount") or 0.0)
        unit_price = round(amount / days, 2) if days > 0 else amount
        description = li.get("employee_name") or li.get("job_title") or emp_id
        lines.append(
            {
                "ItemCode": emp_id,
                "ItemDescription": str(description)[:100],  # SAP B1 cap
                "Quantity": days,
                "UnitPrice": unit_price,
                "VatGroup": "S1",
                "TaxCode": "S1",
                "LineTotal": amount,
            }
        )
    return lines


def prepare_invoice_payload(invoice: Invoice, session: Session) -> dict[str, Any]:
    """Return the SAP B1 A/R Invoice JSON body for this TIA invoice.

    Raises ValueError if the invoice is missing a client_code or has no
    line items - SAP rejects either condition outright.
    """
    if not invoice.client_code:
        raise ValueError("invoice has no client_code - cannot map to SAP CardCode")
    lines = _to_lines(invoice)
    if not lines:
        raise ValueError("invoice has no line items - SAP requires at least one")

    client = session.get(Client, invoice.client_code)
    contract = (
        session.query(Contract)
        .filter(Contract.client_code == invoice.client_code, Contract.active.is_(True))
        .first()
    )

    audit_head = ""
    try:
        report = verify_audit_chain(session)
        audit_head = (report or {}).get("head") or ""
    except Exception:  # noqa: BLE001
        audit_head = ""

    comments = (
        f"TIA invoice {invoice.invoice_sequence_no or invoice.id[:8]} for "
        f"{invoice.period or 'current period'}"
        + (f" - audit head {audit_head[:12]}" if audit_head else "")
    )

    payload: dict[str, Any] = {
        "CardCode": invoice.client_code,
        "CardName": client.name if client else invoice.client_code,
        "DocDate": _doc_date(invoice),
        "DocDueDate": _due_date(invoice, contract),
        "DocCurrency": invoice.currency or "AED",
        "NumAtCard": invoice.invoice_sequence_no or invoice.id,
        "Comments": comments,
        "U_TIA_AuditHash": audit_head,
        "U_TIA_InvoiceId": invoice.id,
        "U_TIA_Period": invoice.period or "",
        "DocTotal": invoice.total_incl_vat or invoice.amount,
        "VatSum": invoice.vat_amount or 0.0,
        "DocumentLines": lines,
    }
    return payload


def _demo() -> None:
    """Offline smoke: a minimal fake Invoice gets a SAP-shaped dict back."""

    class _FakeInv:
        client_code = "CL001"
        invoice_sequence_no = "TIA-CL001-JUNE2026-0001"
        id = "abc"
        currency = "AED"
        amount = 7200.0
        total_incl_vat = 7560.0
        vat_amount = 360.0
        period = "June 2026"
        created_at = dt.datetime(2026, 6, 30, tzinfo=dt.timezone.utc)
        line_items = [
            {
                "emp_id": "EMP10001",
                "employee_name": "Carlos Smith",
                "days_worked": 22,
                "standard_days": 22,
                "amount": 7200.0,
            }
        ]

    # No session needed for the shape check - skip audit lookup path.
    inv = _FakeInv()
    lines = _to_lines(inv)  # type: ignore[arg-type]
    assert lines[0]["ItemCode"] == "EMP10001"
    assert lines[0]["LineTotal"] == 7200.0
    print("integrations.sap_b1.mapping: OK")


if __name__ == "__main__":
    _demo()

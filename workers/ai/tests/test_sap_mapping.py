"""SAP Business One A/R Invoice OData payload mapping (integrations/sap_b1/mapping.py).

Asserts the exact OData shape SAP's Service Layer expects at POST /b1s/v2/Invoices,
the per-line unit-price math, due-date computation, and the ValueError guards.
"""

from __future__ import annotations

import datetime as dt
import uuid

import pytest

from tia_ai.db import SessionLocal
from tia_ai.integrations.sap_b1 import prepare_invoice_payload
from tia_ai.integrations.sap_b1.mapping import _to_lines
from tia_ai.models import Invoice


@pytest.fixture()
def s():
    sess = SessionLocal()
    try:
        yield sess
    finally:
        sess.rollback()
        sess.close()


def _invoice(**kw) -> Invoice:
    base = dict(
        id=str(uuid.uuid4()),
        timesheet_id=f"sap:{uuid.uuid4()}",
        client_code="CL001",
        period="June 2026",
        amount=7200.0,
        currency="AED",
        invoice_sequence_no="TIA-CL001-JUNE2026-0001",
        vat_amount=360.0,
        total_excl_vat=7200.0,
        total_incl_vat=7560.0,
        created_at=dt.datetime(2026, 6, 30, tzinfo=dt.timezone.utc),
        line_items=[
            {
                "emp_id": "EMP10001",
                "employee_name": "Carlos Smith",
                "days_worked": 22,
                "standard_days": 22,
                "amount": 7200.0,
            }
        ],
    )
    base.update(kw)
    return Invoice(**base)


def test_payload_shape_and_card_fields(s):
    inv = _invoice()
    payload = prepare_invoice_payload(inv, s)
    assert payload["CardCode"] == "CL001"
    # CardName resolved from the seeded client (not just the code)
    assert payload["CardName"] and payload["CardName"] != "CL001"
    assert payload["DocCurrency"] == "AED"
    assert payload["NumAtCard"] == "TIA-CL001-JUNE2026-0001"
    assert payload["DocTotal"] == 7560.0
    assert payload["VatSum"] == 360.0
    assert payload["U_TIA_InvoiceId"] == inv.id
    assert payload["U_TIA_Period"] == "June 2026"
    assert "DocumentLines" in payload and len(payload["DocumentLines"]) == 1


def test_line_unit_price_is_amount_over_days(s):
    inv = _invoice()
    line = prepare_invoice_payload(inv, s)["DocumentLines"][0]
    assert line["ItemCode"] == "EMP10001"
    assert line["LineTotal"] == 7200.0
    assert line["Quantity"] == 22.0
    # 7200 / 22 = 327.27 (rounded to 2dp)
    assert line["UnitPrice"] == 327.27
    assert line["VatGroup"] == "S1" and line["TaxCode"] == "S1"


def test_due_date_is_doc_date_plus_terms(s):
    # CL001 contract payment_terms_days = 30 → 2026-06-30 + 30 = 2026-07-30
    inv = _invoice()
    payload = prepare_invoice_payload(inv, s)
    assert payload["DocDate"] == "2026-06-30"
    assert payload["DocDueDate"] == "2026-07-30"


def test_description_capped_at_100_chars(s):
    long_name = "X" * 250
    inv = _invoice(line_items=[{"emp_id": "E1", "employee_name": long_name, "days_worked": 1, "amount": 10.0}])
    line = prepare_invoice_payload(inv, s)["DocumentLines"][0]
    assert len(line["ItemDescription"]) == 100


def test_missing_client_code_raises(s):
    inv = _invoice(client_code=None)
    with pytest.raises(ValueError):
        prepare_invoice_payload(inv, s)


def test_no_line_items_raises(s):
    inv = _invoice(line_items=[])
    with pytest.raises(ValueError):
        prepare_invoice_payload(inv, s)


def test_to_lines_falls_back_to_standard_days_for_unit_price():
    # days_worked 0 but standard_days present → divide by standard_days
    lines = _to_lines(
        _invoice(line_items=[{"emp_id": "E", "days_worked": 0, "standard_days": 20, "amount": 2000.0}])
    )
    assert lines[0]["Quantity"] == 20.0
    assert lines[0]["UnitPrice"] == 100.0


def test_to_lines_skips_non_dict_rows():
    lines = _to_lines(_invoice(line_items=["garbage", {"emp_id": "E", "days_worked": 1, "amount": 5.0}]))
    assert len(lines) == 1 and lines[0]["ItemCode"] == "E"

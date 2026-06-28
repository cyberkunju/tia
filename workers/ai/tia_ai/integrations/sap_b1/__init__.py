"""SAP Business One Service Layer adapter.

`prepare_invoice_payload(invoice, session)` maps a TIA `Invoice` into the
JSON body SAP B1 expects at `POST /b1s/v2/Invoices` (the A/R Invoice
endpoint).

Reference:
  - SAP Business One Service Layer, OData v4: https://help.sap.com/docs/SAP_BUSINESS_ONE/68a2e87fb29941b5bf959a184d9c6727
  - A/R Invoice object: https://help.sap.com/doc/0d2f2a36737d4b008e10cf50a87b3dec/9.3/en-US/index.html

We don't POST anything from here - the payload is returned for the operator
to copy or for a downstream connector to push.
"""

from .mapping import prepare_invoice_payload

__all__ = ["prepare_invoice_payload"]

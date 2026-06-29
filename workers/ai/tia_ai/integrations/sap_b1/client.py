"""SAP Business One Service Layer — real outbound A/R Invoice POST.

Disabled by default (SAP_B1_ENABLED=0): the rest of the pipeline only *generates*
the OData payload (see mapping.py). When enabled with a reachable Service Layer,
`post_invoice()` performs the full Service Layer dance:

    POST /b1s/v2/Login    {CompanyDB, UserName, Password}   -> B1SESSION cookie
    POST /b1s/v2/Invoices <A/R invoice body>                -> {DocEntry, DocNum}
    POST /b1s/v2/Logout                                     (always, best-effort)

The Service Layer is cookie-authenticated; httpx.Client keeps the cookie jar
across the three calls. We never log credentials or the full session cookie.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from ...config import (
    SAP_B1_BASE_URL,
    SAP_B1_COMPANY_DB,
    SAP_B1_PASSWORD,
    SAP_B1_USER,
    SAP_B1_VERIFY_TLS,
)

log = logging.getLogger("tia.integrations.sap_b1")


class SapB1Error(RuntimeError):
    """Any failure talking to the SAP B1 Service Layer (config, login, or POST)."""


def is_configured() -> bool:
    return bool(SAP_B1_BASE_URL and SAP_B1_COMPANY_DB and SAP_B1_USER and SAP_B1_PASSWORD)


def post_invoice(payload: dict[str, Any], timeout: float = 30.0) -> dict[str, Any]:
    """Log in, POST the A/R Invoice body, log out. Returns the created-doc summary
    {DocEntry, DocNum, status}. Raises SapB1Error on any failure (caller decides
    whether that blocks the local dispatch). Credentials are never logged."""
    if not is_configured():
        raise SapB1Error("SAP B1 Service Layer not configured (SAP_B1_BASE_URL/COMPANY_DB/USER/PASSWORD)")

    try:
        with httpx.Client(
            base_url=SAP_B1_BASE_URL, verify=SAP_B1_VERIFY_TLS, timeout=timeout
        ) as c:
            login = c.post(
                "/b1s/v2/Login",
                json={
                    "CompanyDB": SAP_B1_COMPANY_DB,
                    "UserName": SAP_B1_USER,
                    "Password": SAP_B1_PASSWORD,
                },
            )
            if login.status_code != 200:
                raise SapB1Error(f"login failed: HTTP {login.status_code} {login.text[:200]}")

            try:
                resp = c.post("/b1s/v2/Invoices", json=payload)
            finally:
                # Release the Service Layer session regardless of the POST outcome.
                try:
                    c.post("/b1s/v2/Logout")
                except Exception:  # noqa: BLE001
                    pass

            if resp.status_code not in (200, 201):
                raise SapB1Error(f"invoice POST failed: HTTP {resp.status_code} {resp.text[:300]}")
            body = resp.json() if resp.content else {}
            return {
                "DocEntry": body.get("DocEntry"),
                "DocNum": body.get("DocNum"),
                "status": resp.status_code,
            }
    except SapB1Error:
        raise
    except httpx.HTTPError as e:
        raise SapB1Error(f"service layer unreachable: {e}") from e

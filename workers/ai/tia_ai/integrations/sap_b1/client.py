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
import time
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

# Retry policy for transient Service Layer failures (network / 5xx). Login and
# other 4xx are permanent (bad creds / bad payload) and are never retried.
SAP_MAX_ATTEMPTS = 3
SAP_RETRY_BASE_DELAY = 0.5


class SapB1Error(RuntimeError):
    """Any failure talking to the SAP B1 Service Layer (config, login, or POST)."""

    def __init__(self, message: str, *, transient: bool = False) -> None:
        super().__init__(message)
        self.transient = transient


def is_configured() -> bool:
    return bool(SAP_B1_BASE_URL and SAP_B1_COMPANY_DB and SAP_B1_USER and SAP_B1_PASSWORD)


def _post_invoice_once(payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    """A single login->POST->logout cycle. Raises SapB1Error (transient flag set
    for network errors / 5xx) so the caller's retry loop knows what to re-attempt."""
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
                # 5xx at login is transient (server hiccup); 4xx is bad creds (permanent).
                raise SapB1Error(
                    f"login failed: HTTP {login.status_code} {login.text[:200]}",
                    transient=login.status_code >= 500,
                )

            try:
                resp = c.post("/b1s/v2/Invoices", json=payload)
            finally:
                # Release the Service Layer session regardless of the POST outcome.
                try:
                    c.post("/b1s/v2/Logout")
                except Exception:  # noqa: BLE001
                    pass

            if resp.status_code not in (200, 201):
                raise SapB1Error(
                    f"invoice POST failed: HTTP {resp.status_code} {resp.text[:300]}",
                    transient=resp.status_code >= 500,
                )
            body = resp.json() if resp.content else {}
            return {
                "DocEntry": body.get("DocEntry"),
                "DocNum": body.get("DocNum"),
                "status": resp.status_code,
            }
    except SapB1Error:
        raise
    except httpx.HTTPError as e:
        raise SapB1Error(f"service layer unreachable: {e}", transient=True) from e


def post_invoice(
    payload: dict[str, Any],
    timeout: float = 30.0,
    attempts: int = SAP_MAX_ATTEMPTS,
    _sleep=time.sleep,
) -> dict[str, Any]:
    """Log in, POST the A/R Invoice body, log out, with bounded retry on transient
    failures (network / 5xx). Returns {DocEntry, DocNum, status}; raises SapB1Error
    on a permanent failure or once retries are exhausted. Credentials are never logged."""
    if not is_configured():
        raise SapB1Error("SAP B1 Service Layer not configured (SAP_B1_BASE_URL/COMPANY_DB/USER/PASSWORD)")

    last: SapB1Error | None = None
    for attempt in range(1, attempts + 1):
        try:
            return _post_invoice_once(payload, timeout)
        except SapB1Error as e:
            last = e
            if not e.transient or attempt == attempts:
                raise
            log.warning("SAP B1 transient failure (attempt %d/%d): %s", attempt, attempts, e)
            _sleep(SAP_RETRY_BASE_DELAY * (2 ** (attempt - 1)))
    raise last  # pragma: no cover - loop always returns or raises above

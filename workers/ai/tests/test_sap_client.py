"""SAP B1 Service Layer client error/edge paths (integrations/sap_b1/client.py).

test_hardening.py already covers the happy login→POST→logout dance; this file
adds the failure modes: unconfigured guard, login failure, non-2xx invoice POST,
network unreachable, and the guarantee that Logout always fires.
"""

from __future__ import annotations

import httpx
import pytest

from tia_ai.integrations.sap_b1 import client as sap


def _configure(monkeypatch):
    monkeypatch.setattr(sap, "SAP_B1_BASE_URL", "https://sap.example/")
    monkeypatch.setattr(sap, "SAP_B1_COMPANY_DB", "TIA_DB")
    monkeypatch.setattr(sap, "SAP_B1_USER", "u")
    monkeypatch.setattr(sap, "SAP_B1_PASSWORD", "p")


def _install_transport(monkeypatch, handler):
    real_client = httpx.Client

    def _fake_client(*a, **k):
        k["transport"] = httpx.MockTransport(handler)
        k.pop("verify", None)
        return real_client(*a, **k)

    monkeypatch.setattr(sap.httpx, "Client", _fake_client)


def test_is_configured_reflects_all_four_settings(monkeypatch):
    monkeypatch.setattr(sap, "SAP_B1_BASE_URL", "")
    assert sap.is_configured() is False
    _configure(monkeypatch)
    assert sap.is_configured() is True


def test_unconfigured_raises_before_any_network(monkeypatch):
    monkeypatch.setattr(sap, "SAP_B1_BASE_URL", "")
    with pytest.raises(sap.SapB1Error):
        sap.post_invoice({"CardCode": "CL001"})


def test_login_failure_raises_and_skips_post(monkeypatch):
    _configure(monkeypatch)
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req.url.path)
        if req.url.path.endswith("/Login"):
            return httpx.Response(401, text="bad creds")
        return httpx.Response(200, json={})

    _install_transport(monkeypatch, handler)
    with pytest.raises(sap.SapB1Error) as ei:
        sap.post_invoice({"CardCode": "CL001"})
    assert "login failed" in str(ei.value)
    # never attempted the Invoices POST after a failed login
    assert not any(p.endswith("/Invoices") for p in calls)


def test_invoice_post_non_2xx_raises_but_logs_out(monkeypatch):
    _configure(monkeypatch)
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req.url.path)
        if req.url.path.endswith("/Login"):
            return httpx.Response(200, json={"SessionId": "x"})
        if req.url.path.endswith("/Invoices"):
            return httpx.Response(400, text="validation error")
        return httpx.Response(204)

    _install_transport(monkeypatch, handler)
    with pytest.raises(sap.SapB1Error) as ei:
        sap.post_invoice({"CardCode": "CL001", "DocumentLines": [{"ItemCode": "E"}]})
    assert "invoice POST failed" in str(ei.value)
    # Logout must still fire even though the POST failed
    assert any(p.endswith("/Logout") for p in calls)


def test_network_error_wrapped_as_sap_error(monkeypatch):
    _configure(monkeypatch)

    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    _install_transport(monkeypatch, handler)
    with pytest.raises(sap.SapB1Error) as ei:
        sap.post_invoice({"CardCode": "CL001"}, _sleep=lambda _s: None)
    assert "unreachable" in str(ei.value)


def test_success_returns_doc_entry_and_num(monkeypatch):
    _configure(monkeypatch)

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.endswith("/Login"):
            return httpx.Response(200, json={"SessionId": "x"})
        if req.url.path.endswith("/Invoices"):
            return httpx.Response(201, json={"DocEntry": 99, "DocNum": 5005})
        return httpx.Response(204)

    _install_transport(monkeypatch, handler)
    res = sap.post_invoice({"CardCode": "CL001", "DocumentLines": [{"ItemCode": "E"}]})
    assert res == {"DocEntry": 99, "DocNum": 5005, "status": 201}

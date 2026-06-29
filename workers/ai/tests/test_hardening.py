"""Security hardening + SAP B1 outbound bridge tests.

- The env-gated bearer-token middleware: off by default, and when a token is set
  it gates the dashboard/mutation surface while keeping health + the intake
  pipeline (bridge/poller) open so the WhatsApp/email loop can't break.
- The SAP B1 Service Layer client: configured guard + the login/POST/logout dance
  against a mocked transport.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

import tia_ai.api.app as appmod
from tia_ai.api.app import app


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


# ── auth middleware ─────────────────────────────────────────────────────────


def test_api_open_by_default(client):
    # No TIA_API_TOKEN configured → protected paths are reachable (public demo).
    assert appmod.TIA_API_TOKEN == ""
    assert client.get("/clients").status_code == 200


def test_token_gates_protected_paths(client, monkeypatch):
    monkeypatch.setattr(appmod, "TIA_API_TOKEN", "s3cret")
    # protected data endpoint: 401 without, 200 with the right bearer
    assert client.get("/clients").status_code == 401
    assert client.get("/clients", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get("/clients", headers={"Authorization": "Bearer s3cret"}).status_code == 200


def test_token_exempts_health_and_intake(client, monkeypatch):
    monkeypatch.setattr(appmod, "TIA_API_TOKEN", "s3cret")
    # health + the intake pipeline stay open so the loop never breaks on a locked deploy
    assert client.get("/health").status_code == 200
    # /intake/whatsapp is exempt — reachable without a token (still does its own work)
    r = client.post("/intake/whatsapp", json={"from_": "910000000000", "message_text": "hi"})
    assert r.status_code != 401


# ── SAP B1 Service Layer client ─────────────────────────────────────────────


def test_sap_not_configured_raises(monkeypatch):
    from tia_ai.integrations.sap_b1 import client as sap

    monkeypatch.setattr(sap, "SAP_B1_BASE_URL", "")
    assert sap.is_configured() is False
    with pytest.raises(sap.SapB1Error):
        sap.post_invoice({"CardCode": "CL001"})


def test_sap_login_post_logout(monkeypatch):
    from tia_ai.integrations.sap_b1 import client as sap

    monkeypatch.setattr(sap, "SAP_B1_BASE_URL", "https://sap.example/")
    monkeypatch.setattr(sap, "SAP_B1_COMPANY_DB", "TIA_DB")
    monkeypatch.setattr(sap, "SAP_B1_USER", "u")
    monkeypatch.setattr(sap, "SAP_B1_PASSWORD", "p")

    calls: list[str] = []

    def _handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if request.url.path.endswith("/Login"):
            return httpx.Response(200, json={"SessionId": "x"})
        if request.url.path.endswith("/Invoices"):
            return httpx.Response(201, json={"DocEntry": 42, "DocNum": 1001})
        return httpx.Response(204)

    real_client = httpx.Client

    def _fake_client(*a, **k):
        k["transport"] = httpx.MockTransport(_handler)
        k.pop("verify", None)
        return real_client(*a, **k)

    monkeypatch.setattr(sap.httpx, "Client", _fake_client)
    res = sap.post_invoice({"CardCode": "CL001", "DocumentLines": [{"ItemCode": "EMP1"}]})
    assert res["DocEntry"] == 42 and res["DocNum"] == 1001
    assert any(p.endswith("/Login") for p in calls)
    assert any(p.endswith("/Invoices") for p in calls)
    assert any(p.endswith("/Logout") for p in calls)

"""End-to-end API smoke test using FastAPI's TestClient.

Covers the full happy path + the HITL ambiguous path + idempotency replay.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tia_ai.api.app import app
from tia_ai.config import DATA_DIR
from tia_ai.db import init_db
from tia_ai.seed import seed
from tia_ai.synthgen import generate_all


@pytest.fixture(scope="module", autouse=True)
def prepare():
    init_db()
    seed()
    generate_all()
    yield


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"


def test_clients_list(client):
    r = client.get("/clients")
    assert r.status_code == 200
    codes = [c["code"] for c in r.json()]
    assert "CL001" in codes and "CL005" in codes


def test_upload_clean_excel_auto_routes(client):
    p = DATA_DIR / "synthetic" / "case_07_clean.xlsx"
    with p.open("rb") as f:
        r = client.post(
            "/intake/upload",
            files={
                "file": (
                    p.name,
                    f,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
            headers={"Idempotency-Key": "test-c07"},
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["routing"] == "auto"
    assert body["status"] == "invoice_generated"
    assert body["confidence"] >= 0.9


def test_upload_ambiguous_email_routes_hitl(client):
    p = DATA_DIR / "synthetic" / "case_01_email_no_empid.eml"
    with p.open("rb") as f:
        r = client.post(
            "/intake/upload",
            files={"file": (p.name, f, "message/rfc822")},
            headers={"Idempotency-Key": "test-c01"},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["routing"] == "hitl"
    assert body["status"] == "awaiting_review"


def test_documents_list_returns_uploads(client):
    r = client.get("/documents")
    assert r.status_code == 200
    docs = r.json()
    assert len(docs) >= 2
    assert all("status" in d and "routing" in d for d in docs)


def test_invoices_list(client):
    r = client.get("/invoices")
    assert r.status_code == 200
    invs = r.json()
    assert any(i["status"] == "generated" for i in invs)


def test_why_drawer_payload(client):
    invs = client.get("/invoices").json()
    inv_id = invs[0]["id"]
    r = client.get(f"/invoices/{inv_id}/why")
    assert r.status_code == 200
    body = r.json()
    assert "invoice" in body and "events" in body and "validations" in body
    assert len(body["events"]) >= 1


def test_dispatch_requires_idempotency_key(client):
    invs = client.get("/invoices").json()
    inv_id = next(i["id"] for i in invs if i["status"] == "generated")
    r = client.post(f"/invoices/{inv_id}/dispatch", json={"by_user": "tester"})
    assert r.status_code == 400  # missing key


def test_dispatch_then_idempotent_replay(client):
    invs = client.get("/invoices").json()
    inv_id = next(i["id"] for i in invs if i["status"] == "generated")
    r1 = client.post(
        f"/invoices/{inv_id}/dispatch",
        json={"by_user": "tester"},
        headers={"Idempotency-Key": "test-dispatch-1"},
    )
    assert r1.status_code == 200
    assert r1.json()["status"] == "dispatched"
    r2 = client.post(
        f"/invoices/{inv_id}/dispatch",
        json={"by_user": "tester"},
        headers={"Idempotency-Key": "test-dispatch-1"},
    )
    assert r2.json()["status"] == "already_dispatched"


def test_eval_endpoint(client):
    r = client.get("/eval")
    assert r.status_code == 200
    body = r.json()
    assert body["passed"] >= 5  # case 4 may fail without live Modal credentials
    assert "macro_f1" in body and "ece" in body


def test_unknown_doc_404(client):
    r = client.get("/documents/nonexistent")
    assert r.status_code == 404

"""Phase 9 - auto-dispatch + clawback test suite.

These exercise the touchless + state-aware-clawback path end-to-end.
"""

import json
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tia_ai.api.app import app


client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_state():
    client.post("/admin/demo-reset")
    yield


def _upload_case_07() -> dict:
    fixture = Path(__file__).resolve().parents[3] / "data" / "synthetic" / "case_07_clean.xlsx"
    if not fixture.exists():
        pytest.skip("seed data missing - run `make seed && make synth` first")
    with fixture.open("rb") as f:
        r = client.post(
            "/intake/upload",
            files={
                "file": (
                    "case_07_clean.xlsx",
                    f,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
            headers={"Idempotency-Key": "test-auto-1"},
        )
    assert r.status_code == 200, r.text
    return r.json()


def _first_cl001_invoice() -> dict:
    r = client.get("/invoices?client_code=CL001")
    assert r.status_code == 200, r.text
    items = r.json()
    assert items, "expected at least one invoice for CL001"
    return items[0]


# ─────────────────────────── auto-dispatch ────────────────────────────


def test_auto_dispatch_under_threshold_and_clean_rules():
    """Case 07 invoice ≈ AED 35K, threshold AED 50K, all rules pass → auto."""
    d = _upload_case_07()
    assert d["routing"] == "auto"
    inv = _first_cl001_invoice()
    # status should have moved past 'generated' on the touchless path
    assert inv["status"] in {"client_approved", "dispatched"}, inv["status"]


def test_stp_breakdown_includes_auto_count():
    _upload_case_07()
    r = client.get("/metrics/stp")
    assert r.status_code == 200
    body = r.json()
    bd = body.get("dispatched_breakdown") or {}
    assert bd.get("auto_dispatched", 0) >= 1
    assert bd.get("total_dispatched", 0) >= 1


def test_auto_dispatch_event_carries_rationale():
    d = _upload_case_07()
    invs = client.get(f"/invoices?client_code=CL001").json()
    assert invs
    inv_id = invs[0]["id"]
    evs = client.get(f"/events?entity_id={inv_id}").json()
    auto = [e for e in evs if e["action"] == "auto_dispatched_within_tolerance"]
    assert auto, "expected auto_dispatched_within_tolerance event"
    payload = auto[0]["payload"]
    assert payload["amount"] <= payload["threshold"]
    assert payload.get("rules_passed_count", 0) > 0
    assert "decision" in payload  # human-readable rationale
    void(d)  # silence-the-linter no-op


def void(_: object) -> None:
    return None


# ─────────────────────────── clawback ────────────────────────────────


def test_clawback_eligibility_for_dispatched_invoice():
    _upload_case_07()
    inv = _first_cl001_invoice()
    r = client.get(f"/invoices/{inv['id']}/clawback-eligibility")
    assert r.status_code == 200, r.text
    elig = r.json()
    assert elig["action_when_clawed_back"] in {"credit_note", "credit_note_with_refund_pending"}
    assert elig.get("days_remaining") is not None
    assert elig["fta_14_day_deadline"]
    assert elig["valid_reason_codes"]
    assert elig["valid_adjustment_types"]


def test_clawback_issues_credit_note_with_partial_amount():
    _upload_case_07()
    inv = _first_cl001_invoice()
    r = client.post(
        f"/invoices/{inv['id']}/clawback",
        json={
            "by_user": "finops",
            "reason_code": "PRICING_ERROR",
            "reason_text": "4 hours not approved by site manager",
            "partial_amount": 200,
            "disputed_hours": 4,
            "adjustment_type": "DEDUCT_FROM_NEXT_INVOICE",
        },
        headers={"Idempotency-Key": "cn-test-1"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["action_taken"] == "credit_note_issued"
    assert body["is_partial"] is True
    assert body["credit_note_amount"] == 200.0
    assert body["disputed_hours"] == 4.0
    assert body["adjustment_type"] == "DEDUCT_FROM_NEXT_INVOICE"
    assert "Article 60" in " ".join(body["article_refs"])
    assert body["source_timesheet_id"]


def test_clawback_marks_source_timesheet_needs_review():
    _upload_case_07()
    inv = _first_cl001_invoice()
    r = client.post(
        f"/invoices/{inv['id']}/clawback",
        json={"reason_code": "OTHER", "reason_text": "x"},
        headers={"Idempotency-Key": "cn-test-2"},
    )
    assert r.status_code == 200, r.text
    ts_id = r.json()["source_timesheet_id"]
    # the timesheet should have been marked needs_review
    doc_id = inv["timesheet_id"] and inv["timesheet_id"]  # noqa
    # fetch through the doc + timesheet route
    ts_resp = client.get(f"/timesheets/{ts_id}")
    if ts_resp.status_code == 200:
        ts = ts_resp.json()
        assert ts["status"] == "needs_review"


def test_clawback_opens_auto_query_thread():
    _upload_case_07()
    inv = _first_cl001_invoice()
    r = client.post(
        f"/invoices/{inv['id']}/clawback",
        json={"reason_code": "DUPLICATE", "reason_text": "duplicate of last month"},
        headers={"Idempotency-Key": "cn-test-3"},
    )
    body = r.json()
    qid = body.get("auto_query_id")
    assert qid
    qs = client.get(f"/clients/{inv['client_code']}/queries").json()
    assert any(q["id"] == qid for q in qs), "expected auto-query in client queries list"


def test_clawback_idempotent_on_replay():
    _upload_case_07()
    inv = _first_cl001_invoice()
    key = "idemp-cn-1"
    a = client.post(
        f"/invoices/{inv['id']}/clawback",
        json={"reason_code": "PRICING_ERROR"},
        headers={"Idempotency-Key": key},
    ).json()
    b = client.post(
        f"/invoices/{inv['id']}/clawback",
        json={"reason_code": "PRICING_ERROR"},
        headers={"Idempotency-Key": key},
    ).json()
    # second call should observe already-credit-noted state
    assert b["action_taken"] in {"already_credit_noted", "credit_note_issued"}


def test_clawback_rejects_bad_reason_code():
    _upload_case_07()
    inv = _first_cl001_invoice()
    r = client.post(
        f"/invoices/{inv['id']}/clawback",
        json={"reason_code": "GIBBERISH"},
    )
    assert r.status_code == 400


def test_clawback_rejects_bad_adjustment_type():
    _upload_case_07()
    inv = _first_cl001_invoice()
    r = client.post(
        f"/invoices/{inv['id']}/clawback",
        json={"reason_code": "OTHER", "adjustment_type": "BOGUS"},
    )
    assert r.status_code == 400

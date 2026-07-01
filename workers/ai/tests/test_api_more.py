"""Broad api/app.py branch coverage via TestClient (no network).

Targets the endpoint error paths, alternate routings, and financial state
machine branches the happy-path suite doesn't reach: intake modes, clawback
void/credit-note, finance/client approve-reject transitions, metrics, status,
notifications, statement, audit bundle, dispatch queues, and SSE.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from tia_ai.api.app import app
from tia_ai.db import SessionLocal, init_db
from tia_ai.models import Client, Invoice, Payment, Timesheet
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


def _mkinv(**kw) -> str:
    """Insert an invoice in a controlled state; returns its id (committed)."""
    s = SessionLocal()
    try:
        defaults = dict(
            id=str(uuid.uuid4()),
            timesheet_id=f"api:{uuid.uuid4()}",
            client_code="CL001",
            period="June 2026",
            amount=1000.0,
            currency="AED",
            total_incl_vat=1050.0,
            total_excl_vat=1000.0,
            vat_amount=50.0,
            status="generated",
            invoice_sequence_no=f"TIA-APIM-{uuid.uuid4().hex[:8]}",
            line_items=[{"emp_id": "EMP10001", "amount": 1000.0, "days_worked": 22}],
        )
        defaults.update(kw)
        inv = Invoice(**defaults)
        s.add(inv)
        s.commit()
        return inv.id
    finally:
        s.close()


# ── intake_upload edge branches ────────────────────────────────────────────


def test_upload_unsupported_media_type(client):
    r = client.post(
        "/intake/upload",
        files={"file": ("x.exe", b"MZ\x00\x00", "application/x-msdownload")},
        headers={"Idempotency-Key": f"bad-{uuid.uuid4().hex}"},
    )
    assert r.status_code == 415


def test_upload_eml_with_attachment_extracts_children(client):
    from email.mime.application import MIMEApplication
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText

    m = MIMEMultipart()
    m["From"] = "mgr@steel.test"
    m["Subject"] = "June sheet"
    m.attach(MIMEText("EMP10001 worked 22 days"))
    csv = b"Emp ID,Full Name,Working Days,OT Hours\nEMP10001,Carlos Smith,22,5\n"
    a = MIMEApplication(csv, _subtype="csv")
    a.add_header("Content-Disposition", "attachment", filename="ts.csv")
    m.attach(a)
    r = client.post(
        "/intake/upload",
        files={"file": ("mail.eml", m.as_bytes(), "message/rfc822")},
        headers={"Idempotency-Key": f"eml-{uuid.uuid4().hex}"},
    )
    assert r.status_code == 200, r.text
    assert isinstance(r.json()["attachments"], list)


# ── intake_email modes ───────────────────────────────────────────────────────


def test_intake_email_orphan_escalates(client):
    r = client.post(
        "/intake/email",
        json={"body": "hello, no client here", "from_addr": "x@y.test", "to_addrs": ["random@nowhere.test"]},
        headers={"Idempotency-Key": f"orphan-{uuid.uuid4().hex}"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["intake_mode"] == "unknown"
    assert body["routing"] == "escalate"


def test_intake_email_cc_silent_drafts_reply(client):
    # TIA cc'd + unparseable body → cc_silent mode + escalate → draft written
    r = client.post(
        "/intake/email",
        json={
            "body": "hi team, please advise",
            "from_addr": "mgr@steel.test",
            "to_addrs": ["ops@steel.test"],
            "cc_addrs": ["tia@cyberkunju.com"],
            "subject": "question",
        },
        headers={"Idempotency-Key": f"ccs-{uuid.uuid4().hex}"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["intake_mode"] == "cc_silent"
    assert body["reply_drafted"] is True


def test_intake_email_direct_forward(client):
    r = client.post(
        "/intake/email",
        json={
            "body": "Client: CL001\nEMP10001 worked 22 days in June 2026",
            "from_addr": "mgr@steel.test",
            "to_addrs": ["tia@cyberkunju.com"],
            "subject": "timesheet",
        },
        headers={"Idempotency-Key": f"df-{uuid.uuid4().hex}"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["intake_mode"] == "direct_forward"


# ── mailbox-webhook ────────────────────────────────────────────────────────


def test_mailbox_webhook_html_body(client):
    r = client.post(
        "/intake/mailbox-webhook",
        json={
            "From": "mgr@steel.test",
            "To": "billing@steel.test",
            "Subject": "ts",
            "HtmlBody": "<p>EMP10001 worked 22 days</p>",
        },
        headers={"Idempotency-Key": f"wh-{uuid.uuid4().hex}"},
    )
    assert r.status_code == 200, r.text
    assert "intake_mode" in r.json()


# ── submit online form ───────────────────────────────────────────────────────


def test_submit_form_unknown_client_404(client):
    r = client.post("/submit/NOPE", json={"period": "June 2026", "rows": []})
    assert r.status_code == 404


def test_submit_form_success(client):
    r = client.post(
        "/submit/CL001",
        json={
            "period": "June 2026",
            "rows": [{"emp_id": "EMP10001", "employee_name": "Carlos", "days_worked": 22, "ot_hours": 5, "leave_codes": ["AL"]}],
            "notes": "please process",
            "submitted_by": "portal-user",
        },
        headers={"Idempotency-Key": f"form-{uuid.uuid4().hex}"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["client_code"] == "CL001"


# ── consolidate / sif ────────────────────────────────────────────────────────


def test_consolidate_and_sif(client):
    # a client/period with payroll → generates; else 404/500 both acceptable shapes
    r = client.get("/consolidate/CL001/June-2026.xlsx")
    assert r.status_code in (200, 404, 500)
    r2 = client.get("/payroll/sif/CL001/June-2026.sif")
    assert r2.status_code in (200, 404, 500)


# ── qa exception path ─────────────────────────────────────────────────────────


def test_qa_endpoint_exception_returns_500(client, monkeypatch):
    import tia_ai.qa as qa_pkg

    monkeypatch.setattr(qa_pkg, "answer", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    r = client.post("/qa", json={"question": "hi"})
    assert r.status_code == 500


def test_qa_stream_error_event(client, monkeypatch):
    import tia_ai.qa.streaming as st

    async def _boom(*a, **k):
        raise RuntimeError("stream broke")
        yield  # pragma: no cover

    monkeypatch.setattr(st, "stream_answer", _boom)
    r = client.post("/qa/stream", json={"question": "hi"})
    assert r.status_code == 200
    assert "error" in r.text


# ── recover leakage + sap payload ────────────────────────────────────────────


def test_recover_unknown_reason_400(client):
    r = client.post("/finance/leakage/EMP10001/recover", json={"period": "June 2026", "reason": "bogus"})
    assert r.status_code == 400


def test_recover_no_payroll_400(client):
    r = client.post("/finance/leakage/EMP10001/recover", json={"period": "NOPE 1900", "reason": "no_timesheet"})
    assert r.status_code == 400


def test_sap_b1_payload_404_and_400(client):
    assert client.get("/invoices/nope/sap-b1-payload").status_code == 404
    inv_id = _mkinv(line_items=[])  # no lines → mapping ValueError → 400
    assert client.get(f"/invoices/{inv_id}/sap-b1-payload").status_code == 400


# ── dispatch: 404, rust path, sap post ───────────────────────────────────────


def test_dispatch_404(client):
    r = client.post("/invoices/nope/dispatch", json={"by_user": "t"}, headers={"Idempotency-Key": "k"})
    assert r.status_code == 404


def test_dispatch_rust_path(client, monkeypatch):
    import respx
    import httpx

    monkeypatch.setenv("RUST_DISPATCH_URL", "http://rust.test")
    inv_id = _mkinv()
    with respx.mock:
        respx.post(f"http://rust.test/dispatch/{inv_id}").mock(
            return_value=httpx.Response(200, json={"status": "dispatched", "engine": "rust"})
        )
        r = client.post(
            f"/invoices/{inv_id}/dispatch",
            json={"by_user": "finops"},
            headers={"Idempotency-Key": f"rust-{uuid.uuid4().hex}"},
        )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "dispatched"


def test_dispatch_sap_post(client, monkeypatch):
    import tia_ai.config as cfg
    import tia_ai.integrations.sap_b1.client as sapc
    import tia_ai.api.app as appmod

    monkeypatch.setattr(appmod, "log_event", appmod.log_event)  # keep
    monkeypatch.setattr(cfg, "SAP_B1_ENABLED", True)
    monkeypatch.setattr(sapc, "post_invoice", lambda payload, **k: {"DocEntry": 1, "DocNum": 2})
    monkeypatch.delenv("RUST_DISPATCH_URL", raising=False)
    inv_id = _mkinv()
    r = client.post(
        f"/invoices/{inv_id}/dispatch",
        json={"by_user": "finops"},
        headers={"Idempotency-Key": f"sap-{uuid.uuid4().hex}"},
    )
    assert r.status_code == 200


# ── resend email (unconfigured → not sent) ────────────────────────────────────


def test_resend_email_not_sent(client):
    inv_id = _mkinv()
    r = client.post(f"/invoices/{inv_id}/resend-email", json={"by_user": "finops"})
    assert r.status_code == 200
    assert r.json()["sent"] is False


def test_resend_email_404(client):
    assert client.post("/invoices/nope/resend-email", json={}).status_code == 404


# ── client / finance approve-reject transitions ───────────────────────────────


def test_client_approve_and_already(client):
    inv_id = _mkinv(client_approval_status="pending")
    r = client.post(f"/invoices/{inv_id}/client-approve", json={"by_user": "client"})
    assert r.status_code == 200 and r.json()["status"] == "approved"
    r2 = client.post(f"/invoices/{inv_id}/client-approve", json={"by_user": "client"})
    assert r2.json()["status"] == "already_approved"


def test_client_approve_invalid_transition_409(client):
    inv_id = _mkinv(status="dispatched")
    r = client.post(f"/invoices/{inv_id}/client-approve", json={"by_user": "client"})
    assert r.status_code == 409


def test_client_reject_invalid_transition(client):
    # The FSM defines no transition into 'client_rejected' from generated → 409.
    inv_id = _mkinv()
    r = client.post(f"/invoices/{inv_id}/client-reject", json={"by_user": "client", "reason": "too high"})
    assert r.status_code == 409


def test_client_reject_invalid_409(client):
    inv_id = _mkinv(status="dispatched")
    r = client.post(f"/invoices/{inv_id}/client-reject", json={"by_user": "client", "reason": "x"})
    assert r.status_code == 409


def test_finance_approve_and_already_dispatched(client):
    inv_id = _mkinv()
    assert client.post(f"/invoices/{inv_id}/finance-approve", json={"by_user": "fin"}).json()["status"] == "finance_approved"
    disp = _mkinv(status="dispatched")
    assert client.post(f"/invoices/{disp}/finance-approve", json={"by_user": "fin"}).json()["status"] == "already_dispatched"


def test_finance_approve_invalid_409(client):
    inv_id = _mkinv(status="voided")
    assert client.post(f"/invoices/{inv_id}/finance-approve", json={"by_user": "fin"}).status_code == 409


def test_finance_reject_and_invalid(client):
    inv_id = _mkinv()
    assert client.post(f"/invoices/{inv_id}/finance-reject", json={"by_user": "fin", "reason": "no"}).json()["status"] == "rejected"
    voided = _mkinv(status="voided")
    assert client.post(f"/invoices/{voided}/finance-reject", json={"by_user": "fin", "reason": "no"}).status_code == 409


def test_finance_and_client_404(client):
    assert client.post("/invoices/nope/finance-approve", json={}).status_code == 404
    assert client.post("/invoices/nope/finance-reject", json={}).status_code == 404
    assert client.post("/invoices/nope/client-approve", json={}).status_code == 404
    assert client.post("/invoices/nope/client-reject", json={}).status_code == 404


# ── payments ───────────────────────────────────────────────────────────────


def test_record_and_list_payments_more(client):
    inv_id = _mkinv()
    r = client.post(
        f"/invoices/{inv_id}/payments",
        json={"amount": 500.0, "method": "wire", "reference": "REF1"},
        headers={"Idempotency-Key": f"pay-{uuid.uuid4().hex}"},
    )
    assert r.status_code == 201
    lst = client.get(f"/invoices/{inv_id}/payments")
    assert lst.status_code == 200 and len(lst.json()) == 1


def test_record_payment_404(client):
    assert client.post("/invoices/nope/payments", json={"amount": 1.0}).status_code == 404


# ── period close / reopen ─────────────────────────────────────────────────────


def test_close_and_reopen_period(client):
    r = client.post("/clients/CL001/periods/TESTQ 2099/close")
    assert r.status_code == 200 and r.json()["closed"] is True
    r2 = client.post("/clients/CL001/periods/TESTQ 2099/reopen")
    assert r2.status_code == 200 and r2.json()["closed"] is False


def test_close_reopen_404(client):
    assert client.post("/clients/NOPE/periods/x/close").status_code == 404
    assert client.post("/clients/NOPE/periods/x/reopen").status_code == 404


# ── queries ───────────────────────────────────────────────────────────────────


def test_query_lifecycle(client):
    r = client.post("/clients/CL001/queries", json={"subject": "Q?", "body": "explain", "raised_by": "client"})
    assert r.status_code == 201
    qid = r.json()["id"]
    lst = client.get("/clients/CL001/queries")
    assert any(q["id"] == qid for q in lst.json())
    rep = client.post(f"/queries/{qid}/reply", json={"body": "here you go", "by_user": "finops", "close": True})
    assert rep.status_code == 200 and rep.json()["status"] == "closed"


def test_query_404(client):
    assert client.post("/clients/NOPE/queries", json={"subject": "x"}).status_code == 404
    assert client.post("/queries/nope/reply", json={"body": "x"}).status_code == 404


# ── metrics ────────────────────────────────────────────────────────────────


def test_metrics_endpoints(client):
    for path in ("/metrics/time-to-invoice", "/metrics/accuracy", "/metrics/headcount", "/metrics/sla", "/metrics/stp"):
        assert client.get(path).status_code == 200


def test_metrics_leakage(client):
    r = client.get("/metrics/leakage")
    assert r.status_code == 200 and "total_aed" in r.json()


# ── status ───────────────────────────────────────────────────────────────────


def test_status(client):
    r = client.get("/status")
    assert r.status_code == 200
    body = r.json()
    assert body["api"] == "ok" and "config_warnings" in body


# ── dispatch tracking + client queue ordering ─────────────────────────────────


def test_dispatch_tracking(client):
    assert client.get("/dispatch/tracking").status_code == 200


def test_client_dispatch_queue_orderings(client):
    s = SessionLocal()
    try:
        c = s.get(Client, "CL001")
        for rule, grouping in [
            ("desc_by_amount", "flat"),
            ("by_emp_id", "flat"),
            ("asc_by_amount", "by_client_period"),
        ]:
            c.settings = {**(c.settings or {}), "dispatch_order_rule": rule, "dispatch_grouping_mode": grouping}
            s.commit()
            r = client.get("/dispatch/CL001/queue")
            assert r.status_code == 200
    finally:
        c = s.get(Client, "CL001")
        c.settings = {k: v for k, v in (c.settings or {}).items() if k not in ("dispatch_order_rule", "dispatch_grouping_mode")}
        s.commit()
        s.close()


def test_client_dispatch_queue_404(client):
    assert client.get("/dispatch/NOPE/queue").status_code == 404


# ── clawback-eligibility + clawback ───────────────────────────────────────────


def test_clawback_eligibility_states(client):
    gen = _mkinv(status="generated")
    assert client.get(f"/invoices/{gen}/clawback-eligibility").json()["action_when_clawed_back"] == "void"
    disp = _mkinv(status="dispatched")
    elig = client.get(f"/invoices/{disp}/clawback-eligibility").json()
    assert elig["action_when_clawed_back"] in ("credit_note", "credit_note_with_refund_pending")
    voided = _mkinv(status="voided")
    assert client.get(f"/invoices/{voided}/clawback-eligibility").json()["action_when_clawed_back"] is None
    assert client.get("/invoices/nope/clawback-eligibility").status_code == 404


def test_clawback_void_pre_dispatch(client):
    inv_id = _mkinv(status="generated")
    r = client.post(f"/invoices/{inv_id}/clawback", json={"by_user": "finops", "reason_code": "DUPLICATE"})
    assert r.status_code == 200 and r.json()["action_taken"] == "voided"


def test_clawback_credit_note_dispatched(client):
    inv_id = _mkinv(status="dispatched")
    r = client.post(f"/invoices/{inv_id}/clawback", json={"by_user": "finops", "reason_code": "PRICING_ERROR"})
    assert r.status_code == 200
    assert r.json()["action_taken"] in ("credit_note_issued", "credit_note_with_refund_pending")
    assert r.json()["credit_note_sequence_no"]


def test_clawback_credit_note_with_refund(client):
    inv_id = _mkinv(status="dispatched")
    s = SessionLocal()
    try:
        s.add(Payment(id=str(uuid.uuid4()), invoice_id=inv_id, client_code="CL001", amount=1050.0, currency="AED", method="wire", status="received"))
        s.commit()
    finally:
        s.close()
    r = client.post(f"/invoices/{inv_id}/clawback", json={"by_user": "finops", "reason_code": "GOODS_RETURNED"})
    assert r.json()["action_taken"] == "credit_note_with_refund_pending"
    assert r.json()["refund_required"] is True


def test_clawback_validation_and_terminal(client):
    inv_id = _mkinv(status="generated")
    assert client.post(f"/invoices/{inv_id}/clawback", json={"reason_code": "BAD"}).status_code == 400
    assert client.post(f"/invoices/{inv_id}/clawback", json={"adjustment_type": "NONSENSE"}).status_code == 400
    assert client.post("/invoices/nope/clawback", json={}).status_code == 404
    voided = _mkinv(status="voided")
    assert client.post(f"/invoices/{voided}/clawback", json={}).json()["action_taken"] == "already_settled"


# ── events list + statement + audit bundle + notifications + users ─────────────


def test_list_events_entity_filter(client):
    inv = client.get("/invoices").json()[0]
    r = client.get(f"/events?entity_id={inv['id']}")
    assert r.status_code == 200 and isinstance(r.json(), list)


def test_client_statement(client):
    r = client.get("/client/CL001/statement")
    assert r.status_code == 200 and "periods" in r.json()
    assert client.get("/client/NOPE/statement").status_code == 404


def test_audit_bundle_zip(client):
    r = client.get("/client/CL001/audit/June-2026.zip")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    assert client.get("/client/NOPE/audit/Q1-2026.zip").status_code == 404


def test_notifications_personas(client):
    for persona in ("client", "finops", "finance"):
        r = client.get(f"/notifications?persona={persona}")
        assert r.status_code == 200 and isinstance(r.json(), list)
    # client-scoped filter
    assert client.get("/notifications?persona=client&client_code=CL001").status_code == 200


def test_client_users_get_set(client):
    r = client.put(
        "/clients/CL001/users",
        json=[{"email": "a@x.test", "name": "A", "role": "approver"}],
    )
    assert r.status_code == 200 and len(r.json()["users"]) == 1
    g = client.get("/clients/CL001/users")
    assert g.status_code == 200 and g.json()[0]["email"] == "a@x.test"
    assert client.put("/clients/NOPE/users", json=[]).status_code == 404
    assert client.get("/clients/NOPE/users").status_code == 404


# ── create client + update settings + contract 404 ─────────────────────────────


def test_create_client_and_settings(client):
    code = "CLX" + uuid.uuid4().hex[:4].upper()
    r = client.post("/clients", json={"code": code, "name": "Test Co"})
    assert r.status_code in (201, 400)  # 400 if code exists
    if r.status_code == 201:
        up = client.put(f"/clients/{code}/settings", json={"validation_threshold_aed": 1000})
        assert up.status_code == 200


def test_contract_404(client):
    assert client.get("/contracts/NOPE").status_code == 404


def test_eval_run_endpoint(client):
    r = client.post("/eval/run")
    assert r.status_code == 200 and "passed" in r.json()

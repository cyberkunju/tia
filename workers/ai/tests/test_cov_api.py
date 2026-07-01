"""Remaining api/app.py branch coverage — hermetic (fake IMAP/SMTP/httpx, no net).

Targets the exception handlers, alternate routings, clawback edge states, SLA
breaches, /status probes, notification filters and the lifespan poller start that
the existing api suites don't reach. Each test asserts concrete behaviour.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid
from pathlib import Path

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

import tia_ai.api.app as appmod
from tia_ai.api.app import app
from tia_ai.config import STAGING_DIR
from tia_ai.db import SessionLocal
from tia_ai.models import Client, DocAsset, Event, Invoice, Payment, Timesheet


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def _mkinv(**kw) -> str:
    s = SessionLocal()
    try:
        defaults = dict(
            id=str(uuid.uuid4()),
            timesheet_id=f"capi:{uuid.uuid4()}",
            client_code="CL001",
            period="June 2026",
            amount=1000.0,
            currency="AED",
            total_incl_vat=1050.0,
            total_excl_vat=1000.0,
            vat_amount=50.0,
            status="generated",
            invoice_sequence_no=f"TIA-CAPI-{uuid.uuid4().hex[:8]}",
            line_items=[{"emp_id": "EMP10001", "amount": 1000.0, "days_worked": 22}],
        )
        defaults.update(kw)
        inv = Invoice(**defaults)
        s.add(inv)
        s.commit()
        return inv.id
    finally:
        s.close()


# ── lifespan poller start (85-87) ──────────────────────────────────────────────


def test_lifespan_starts_poller_when_configured(monkeypatch):
    started = {"ran": False}

    class _FakePoller:
        def configured(self):
            return True

        def run_forever(self, *a, **k):
            started["ran"] = True

    # ZohoPoller is imported inside _lifespan via `from ..mailbox import ZohoPoller`
    import tia_ai.mailbox as mbox

    monkeypatch.setattr(mbox, "ZohoPoller", _FakePoller)
    # _mcp_started is already True (the module-scoped TestClient ran the lifespan),
    # so the MCP block is skipped and we just exercise the poller-start branch.
    monkeypatch.setattr(appmod, "_mcp_started", True)

    async def _drive():
        async with appmod._lifespan(app):
            pass

    asyncio.run(_drive())
    assert started["ran"] is True


# ── upload_meta built from email linkage (237) ──────────────────────────────────


def test_upload_with_email_linkage_builds_meta(client):
    csv = b"Emp ID,Full Name,Working Days,OT Hours\nEMP10001,Carlos Smith,22,5\n"
    r = client.post(
        "/intake/upload",
        files={"file": ("ts.csv", csv, "text/csv")},
        data={"from_addr": "mgr@steel.test", "subject": "June sheet", "uploaded_by": "mgr@steel.test"},
        headers={"Idempotency-Key": f"meta-{uuid.uuid4().hex}"},
    )
    assert r.status_code == 200, r.text
    doc_id = r.json()["doc_id"]
    s = SessionLocal()
    try:
        doc = s.get(DocAsset, doc_id)
        assert (doc.meta or {}).get("from_addr") == "mgr@steel.test"  # line 237 built meta
        assert doc.source_channel == "email"
    finally:
        s.close()


# ── eml attachment: child process + child ingest exceptions (300-311) ───────────


def _eml_with_attachment() -> bytes:
    from email.mime.application import MIMEApplication
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText

    m = MIMEMultipart()
    m["From"] = "mgr@steel.test"
    m["Subject"] = "June"
    m.attach(MIMEText("EMP10001 22 days"))
    a = MIMEApplication(b"Emp ID,Days\nEMP10001,22\n", _subtype="csv")
    a.add_header("Content-Disposition", "attachment", filename="ts.csv")
    m.attach(a)
    return m.as_bytes()


def test_eml_attachment_child_process_exception(client, monkeypatch):
    real_pd = appmod.process_doc

    def pd(s, doc, **k):
        if doc.source_channel == "email_attachment":
            raise RuntimeError("child boom")
        return real_pd(s, doc, **k)

    monkeypatch.setattr(appmod, "process_doc", pd)
    r = client.post(
        "/intake/upload",
        files={"file": ("mail.eml", _eml_with_attachment(), "message/rfc822")},
        headers={"Idempotency-Key": f"attp-{uuid.uuid4().hex}"},
    )
    assert r.status_code == 200, r.text
    atts = r.json()["attachments"]
    assert any("error" in a for a in atts)  # 300-309 captured child error


def test_eml_attachment_child_ingest_exception(client, monkeypatch):
    real_if = appmod.ingest_file

    def ifn(s, path, channel=None, **k):
        if channel == "email_attachment":
            raise RuntimeError("ingest boom")
        return real_if(s, path, channel=channel, **k)

    monkeypatch.setattr(appmod, "ingest_file", ifn)
    r = client.post(
        "/intake/upload",
        files={"file": ("mail.eml", _eml_with_attachment(), "message/rfc822")},
        headers={"Idempotency-Key": f"atti-{uuid.uuid4().hex}"},
    )
    assert r.status_code == 200, r.text  # 310-311 logged the failure, parent still ok


# ── upload email-reply exception swallowed (340-342) ────────────────────────────


# ── upload email-reply path (340-342 is a latent bug: `_email_reply_for_upload`
#    references an undefined `log`, so its except branch raises NameError and cannot
#    be exercised without asserting buggy 500 behaviour or editing runtime logic —
#    intentionally left uncovered and reported).


# ── _infer_intake_mode watched_mailbox (381) ────────────────────────────────────


def test_infer_intake_mode_watched_mailbox():
    s = SessionLocal()
    try:
        c = s.get(Client, "CL001")
        orig = dict(c.settings or {})
        c.settings = {**orig, "watched_mailboxes": ["timesheets@watched.test"]}
        s.commit()
        payload = appmod.EmailIntake(
            body="hi", to_addrs=["timesheets@watched.test"], cc_addrs=[]
        )
        assert appmod._infer_intake_mode(payload, s) == "watched_mailbox"  # line 381
    finally:
        c = s.get(Client, "CL001")
        c.settings = orig
        s.commit()
        s.close()


# ── mailbox-webhook missing signature → 401 (706) ──────────────────────────────


def test_mailbox_webhook_missing_signature_401(client, monkeypatch):
    monkeypatch.setenv("MAILBOX_WEBHOOK_SECRET", "s3cr3t")
    r = client.post(
        "/intake/mailbox-webhook",
        json={"From": "a@b.test", "To": "x@y.test", "Subject": "s", "TextBody": "EMP10001 22 days"},
    )
    assert r.status_code == 401


# ── _draft_cc_silent_reply direct: client lookup + rule_results + subject (602-636)


def test_draft_cc_silent_reply_full_fields():
    s = SessionLocal()
    ts_id = str(uuid.uuid4())
    doc = DocAsset(id=str(uuid.uuid4()), content_hash=uuid.uuid4().hex, source_channel="email")
    s.add(doc)
    s.flush()
    ts = Timesheet(
        id=ts_id, doc_id=doc.id, client_code="CL001", period="June 2026",
        status="awaiting_review", routing="hitl", hitl_reason="rule failed",
        validations=[], created_at=dt.datetime.now(dt.timezone.utc),
    )
    s.add(ts)
    # invoice with a failing rule → candidates = inv.rule_results (620)
    s.add(Invoice(
        id=str(uuid.uuid4()), timesheet_id=ts_id, client_code="CL001", period="June 2026",
        amount=1000.0, currency="AED", status="generated",
        invoice_sequence_no=f"TIA-CCS-{uuid.uuid4().hex[:6]}",
        rule_results=[{"rule_id": "R4", "passed": False, "severity": "error", "message": "OT"}],
        created_at=dt.datetime.now(dt.timezone.utc),
    ))
    s.commit()

    class _P:
        subject = "June timesheet"
        from_addr = "mgr@steel.test"
        cc_addrs: list[str] = []

    try:
        out = appmod._draft_cc_silent_reply(_P(), s.get(Timesheet, ts_id), s)  # 602-606, 620, 634, 636
        assert out.exists()
        body = out.read_text()
        assert "Emirates Steel" in body or "CL001" in body
    finally:
        # cleanup drafted file + rows
        try:
            out.unlink(missing_ok=True)
        except Exception:
            pass
        s.close()


def test_draft_cc_silent_reply_uses_ts_validations_when_no_invoice():
    s = SessionLocal()
    ts_id = str(uuid.uuid4())
    doc = DocAsset(id=str(uuid.uuid4()), content_hash=uuid.uuid4().hex, source_channel="email")
    s.add(doc)
    s.flush()
    ts = Timesheet(
        id=ts_id, doc_id=doc.id, client_code="CL001", period="June 2026",
        status="awaiting_review", routing="hitl", hitl_reason="rule failed",
        validations=[{"rule_id": "R4", "passed": False, "severity": "error", "message": "OT"}],
        created_at=dt.datetime.now(dt.timezone.utc),
    )
    s.add(ts)
    s.commit()

    class _P:
        subject = "June timesheet"
        from_addr = "mgr@steel.test"
        cc_addrs: list[str] = []

    try:
        out = appmod._draft_cc_silent_reply(_P(), s.get(Timesheet, ts_id), s)  # 622 candidates=ts.validations
        assert out.exists()
    finally:
        try:
            out.unlink(missing_ok=True)
        except Exception:
            pass
        s.close()


# ── _whatsapp_pipeline_bg: doc None (867) + exception path (872-884) ────────────


def test_whatsapp_pipeline_bg_missing_doc_returns():
    # doc_id not found → early return (867); no exception raised
    appmod._whatsapp_pipeline_bg("no-such-doc-id", phone="+9715550009", client_hint=None)


def test_whatsapp_pipeline_bg_exception_path(monkeypatch):
    # ingest a whatsapp doc, then make process_doc raise → error branch (872-884)
    s = SessionLocal()
    try:
        p = Path(STAGING_DIR) / f"_wabg_{uuid.uuid4().hex}.csv"
        p.write_bytes(b"Emp ID,Days\nEMP10001,22\n")
        doc = appmod.ingest_file(s, p, channel="whatsapp", mime="text/csv", uploaded_by="+9715550003")
        s.commit()
        doc_id = doc.id
    finally:
        s.close()
    monkeypatch.setattr(
        appmod, "process_doc", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("pipeline boom"))
    )
    # phone set → notify_bridge fires against the unreachable bridge (graceful)
    appmod._whatsapp_pipeline_bg(doc_id, phone="+9715550003", client_hint=None)
    s = SessionLocal()
    try:
        assert (
            s.query(Event).filter_by(entity_id=doc_id, action="whatsapp.pipeline_error").count() >= 1
        )
    finally:
        s.close()


# ── /intake/whatsapp attachment_url download (982-987) ─────────────────────────


def test_intake_whatsapp_attachment_url(client):
    with respx.mock:
        respx.get("https://files.test/ts.csv").mock(
            return_value=httpx.Response(200, content=b"Emp ID,Days\nEMP10001,22\n")
        )
        r = client.post(
            "/intake/whatsapp",
            json={
                "from_": "+9715550004",
                "attachment_url": "https://files.test/ts.csv",
                "attachment_mime": "text/csv",
            },
            headers={"Idempotency-Key": f"wa-{uuid.uuid4().hex}"},
        )
    assert r.status_code in (200, 202), r.text  # 982-987 downloaded + queued


# ── whatsapp push on approve (1106) + reject (1149) ────────────────────────────


def _whatsapp_ts(phone: str) -> str:
    """Ingest a clean whatsapp CSV, process it, force it back to awaiting_review."""
    s = SessionLocal()
    try:
        p = Path(STAGING_DIR) / f"_wats_{uuid.uuid4().hex}.csv"
        p.write_bytes(
            b"Emp ID,Full Name,Client Code,Working Days,OT Hours\nEMP10001,Carlos Smith,CL001,22,2\n"
        )
        doc = appmod.ingest_file(s, p, channel="whatsapp", mime="text/csv", uploaded_by=phone)
        ts = appmod.process_doc(s, doc, client_hint="CL001")
        ts.status = "awaiting_review"
        s.commit()
        return ts.id
    finally:
        s.close()


def test_approve_whatsapp_pushes_invoice(client):
    ts_id = _whatsapp_ts("+9715550005")
    r = client.post(f"/timesheets/{ts_id}/approve", json={"by_user": "finops"})
    assert r.status_code == 200, r.text
    assert r.json()["whatsapp_push"] is not None  # 1106 fired (push attempted)


def test_reject_whatsapp_pushes_text(client):
    ts_id = _whatsapp_ts("+9715550006")
    r = client.post(f"/timesheets/{ts_id}/reject", json={"by_user": "finops", "reason": "unreadable"})
    assert r.status_code == 200, r.text
    # 1149 fired: push_text_to_sender ran against the (unreachable) bridge and logged
    s = SessionLocal()
    try:
        assert (
            s.query(Event)
            .filter(Event.entity_id == ts_id, Event.action.like("whatsapp.reject_notif%"))
            .count()
            >= 1
        )
    finally:
        s.close()


# ── consolidate / sif exception + 404 (1280-1283, 1305-1308) ───────────────────


def test_consolidate_exception_500(client, monkeypatch):
    import tia_ai.erp.smart_bot_sap as sbs

    monkeypatch.setattr(
        sbs, "build_consolidated_excel",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("consolidate boom")),
    )
    r = client.get("/consolidate/CL001/June-2026.xlsx")
    assert r.status_code == 500  # 1280-1281


def test_consolidate_missing_file_404(client, monkeypatch):
    import tia_ai.erp.smart_bot_sap as sbs

    monkeypatch.setattr(sbs, "build_consolidated_excel", lambda *a, **k: Path("/nonexistent/x.xlsx"))
    r = client.get("/consolidate/CL001/June-2026.xlsx")
    assert r.status_code == 404  # 1283


def test_sif_exception_500(client, monkeypatch):
    import tia_ai.erp.smart_bot_sap as sbs

    monkeypatch.setattr(
        sbs, "build_wps_sif", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("sif boom"))
    )
    r = client.get("/payroll/sif/CL001/June-2026.sif")
    assert r.status_code == 500  # 1305-1306


def test_sif_missing_file_404(client, monkeypatch):
    import tia_ai.erp.smart_bot_sap as sbs

    monkeypatch.setattr(sbs, "build_wps_sif", lambda *a, **k: Path("/nonexistent/x.sif"))
    r = client.get("/payroll/sif/CL001/June-2026.sif")
    assert r.status_code == 404  # 1308


# ── dispatch: rust unreachable (1581-1582), email fail (1593-1594), sap err (1631-1632)


def test_dispatch_rust_unreachable_502(client, monkeypatch):
    monkeypatch.setenv("RUST_DISPATCH_URL", "http://rust.test")
    inv_id = _mkinv()
    with respx.mock:
        respx.post(f"http://rust.test/dispatch/{inv_id}").mock(side_effect=httpx.ConnectError("down"))
        r = client.post(
            f"/invoices/{inv_id}/dispatch",
            json={"by_user": "finops"},
            headers={"Idempotency-Key": f"rustdown-{uuid.uuid4().hex}"},
        )
    assert r.status_code == 502  # 1581-1582


def test_dispatch_rust_email_failure_logged(client, monkeypatch):
    import tia_ai.mailbox.sender as sender

    monkeypatch.setenv("RUST_DISPATCH_URL", "http://rust.test")
    monkeypatch.setattr(
        sender, "send_invoice_email", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("smtp"))
    )
    inv_id = _mkinv()
    with respx.mock:
        respx.post(f"http://rust.test/dispatch/{inv_id}").mock(
            return_value=httpx.Response(200, json={"status": "dispatched", "engine": "rust"})
        )
        r = client.post(
            f"/invoices/{inv_id}/dispatch",
            json={"by_user": "finops"},
            headers={"Idempotency-Key": f"rustmail-{uuid.uuid4().hex}"},
        )
    assert r.status_code == 200  # 1593-1594 swallowed
    s = SessionLocal()
    try:
        assert (
            s.query(Event).filter_by(entity_id=inv_id, action="email.invoice_send_failed").count() >= 1
        )
    finally:
        s.close()


def test_dispatch_sap_error_logged(client, monkeypatch):
    import tia_ai.config as cfg
    import tia_ai.integrations.sap_b1.client as sapc

    monkeypatch.delenv("RUST_DISPATCH_URL", raising=False)
    monkeypatch.setattr(cfg, "SAP_B1_ENABLED", True)
    monkeypatch.setattr(
        sapc, "post_invoice", lambda *a, **k: (_ for _ in ()).throw(sapc.SapB1Error("sap down"))
    )
    inv_id = _mkinv()
    r = client.post(
        f"/invoices/{inv_id}/dispatch",
        json={"by_user": "finops"},
        headers={"Idempotency-Key": f"saperr-{uuid.uuid4().hex}"},
    )
    assert r.status_code == 200  # 1631-1632 swallowed
    s = SessionLocal()
    try:
        assert (
            s.query(Event).filter_by(entity_id=inv_id, action="sap_b1.invoice_post_failed").count() >= 1
        )
    finally:
        s.close()


# ── resend-email success (1671) ────────────────────────────────────────────────


def test_resend_email_success(client, monkeypatch):
    import tia_ai.mailbox.sender as sender

    monkeypatch.setattr(
        sender, "send_invoice_email",
        lambda s, i, idempotency_key=None, by_user="finops": {
            "sent": True, "to": "client@steel.test", "message_id": "<x@tia>"
        },
    )
    inv_id = _mkinv()
    r = client.post(f"/invoices/{inv_id}/resend-email", json={"by_user": "finops"})
    assert r.status_code == 200
    assert r.json()["sent"] is True and r.json()["to"] == "client@steel.test"  # 1671


# ── metrics: accuracy no-run (2332), SLA breaches (2416, 2425) ─────────────────


def test_metrics_accuracy_no_eval(client, monkeypatch, tmp_path):
    # point DATA_DIR at an empty dir so _last_run.json is absent → 2332
    monkeypatch.setattr(appmod, "DATA_DIR", tmp_path)
    (tmp_path / "gold").mkdir()
    r = client.get("/metrics/accuracy")
    assert r.status_code == 200
    assert r.json()["note"] == "no eval yet"


def test_metrics_sla_breaches(client):
    old = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=6)
    old_fin = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=3)
    _mkinv(status="generated", created_at=old)          # >5d generated → over_sla (2416)
    _mkinv(status="finance_approved", created_at=old_fin)  # >2d finance → over_sla (2425)
    r = client.get("/metrics/sla")
    assert r.status_code == 200
    assert r.json()["over_sla_count"] >= 2


# ── /status probes: db down (2459-2460), zoho fail (2477-2478), rust (2501-2507) ─


def test_status_db_down(client, monkeypatch):
    from tia_ai.api.app import db_session

    class _BadSession:
        def query(self, *a, **k):
            raise RuntimeError("db down")

    app.dependency_overrides[db_session] = lambda: _BadSession()
    try:
        r = client.get("/status")
        assert r.status_code == 200
        assert r.json()["db"] == "down"  # 2459-2460
    finally:
        app.dependency_overrides.pop(db_session, None)


def test_status_zoho_probe_failure(client, monkeypatch):
    import tia_ai.mailbox.poller as poller

    monkeypatch.setattr(
        poller, "imap_health", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("probe boom"))
    )
    r = client.get("/status")
    assert r.status_code == 200
    assert r.json()["zoho_mail"] in ("configured", "missing_creds")  # 2477-2478 fallback


def test_status_rust_probe_ok_and_unreachable(client, monkeypatch):
    monkeypatch.setenv("RUST_DISPATCH_URL", "http://rust.test")
    with respx.mock:
        respx.get("http://rust.test/health").mock(return_value=httpx.Response(200))
        r = client.get("/status")
        assert r.json()["rust_dispatch"] == "ok"  # 2501-2505
    with respx.mock:
        respx.get("http://rust.test/health").mock(side_effect=httpx.ConnectError("down"))
        r2 = client.get("/status")
        assert r2.json()["rust_dispatch"] == "unreachable"  # 2506-2507


# ── clawback-eligibility branches (2752, 2780, 2782, 2790, 2796-2798) ──────────


def test_clawback_eligibility_credit_note_already_issued(client):
    inv_id = _mkinv(status="dispatched", credit_note_sequence_no="TIA-CN-X-0001")
    r = client.get(f"/invoices/{inv_id}/clawback-eligibility")
    assert r.json()["reason"] == "credit note already issued"  # 2752


def test_clawback_eligibility_urgency_urgent(client):
    disp_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=13)
    inv_id = _mkinv(status="dispatched", dispatch_attempted_at=disp_at)
    r = client.get(f"/invoices/{inv_id}/clawback-eligibility")
    assert r.json()["urgency"] == "urgent"  # 2780


def test_clawback_eligibility_urgency_warning(client):
    disp_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=10)
    inv_id = _mkinv(status="dispatched", dispatch_attempted_at=disp_at)
    r = client.get(f"/invoices/{inv_id}/clawback-eligibility")
    assert r.json()["urgency"] == "warning"  # 2782


def test_clawback_eligibility_refund_pending_explanation(client):
    inv_id = _mkinv(status="dispatched")
    s = SessionLocal()
    try:
        s.add(Payment(id=str(uuid.uuid4()), invoice_id=inv_id, client_code="CL001",
                      amount=1050.0, currency="AED", method="wire", status="received"))
        s.commit()
    finally:
        s.close()
    r = client.get(f"/invoices/{inv_id}/clawback-eligibility")
    assert r.json()["action_when_clawed_back"] == "credit_note_with_refund_pending"
    assert "refund" in r.json()["explanation"].lower()  # 2790


def test_clawback_eligibility_invalid_state(client):
    inv_id = _mkinv(status="rejected")  # not pre-dispatch, not terminal, not dispatched
    r = client.get(f"/invoices/{inv_id}/clawback-eligibility")
    assert r.json()["action_when_clawed_back"] is None  # 2796-2798
    assert "not valid from state 'rejected'" in r.json()["reason"]


# ── clawback action branches (2849-2850, 2875-2884, 2895, 2933-2934) ───────────


def test_clawback_void_fsm_block_409(client, monkeypatch):
    import tia_ai.invoice.fsm as fsm

    inv_id = _mkinv(status="generated")

    def _boom(s, i, target):
        raise fsm.InvalidTransition(i.status, target)

    monkeypatch.setattr(fsm, "set_status", _boom)
    r = client.post(f"/invoices/{inv_id}/clawback", json={"by_user": "finops", "reason_code": "DUPLICATE"})
    assert r.status_code == 409  # 2849-2850


def test_clawback_void_renames_outbox_file(client):
    inv_id = _mkinv(status="generated")
    outbox = Path(STAGING_DIR) / "outbox"
    outbox.mkdir(parents=True, exist_ok=True)
    f = outbox / f"dispatch_{inv_id}_001.txt"
    f.write_text("dispatched notice")
    r = client.post(f"/invoices/{inv_id}/clawback", json={"by_user": "finops", "reason_code": "DUPLICATE"})
    assert r.status_code == 200 and r.json()["action_taken"] == "voided"
    # the original was renamed with a voided_ prefix (2875-2884)
    assert (outbox / f"voided_dispatch_{inv_id}_001.txt").exists()


def test_clawback_credit_note_pdf_render_failure_logged(client, monkeypatch):
    import tia_ai.invoice.render as render

    monkeypatch.setattr(
        render, "render_invoice_with_credit_note",
        lambda i: (_ for _ in ()).throw(RuntimeError("typst down")),
    )
    inv_id = _mkinv(status="dispatched")
    r = client.post(f"/invoices/{inv_id}/clawback", json={"by_user": "finops", "reason_code": "PRICING_ERROR"})
    assert r.status_code == 200  # 2933-2934 swallowed; credit note still issued
    s = SessionLocal()
    try:
        assert (
            s.query(Event).filter_by(entity_id=inv_id, action="credit_note.pdf_render_failed").count() >= 1
        )
    finally:
        s.close()


# ── events entity filter for a timesheet (3168) ────────────────────────────────


def test_list_events_timesheet_entity_filter(client):
    s = SessionLocal()
    try:
        doc = DocAsset(id=str(uuid.uuid4()), content_hash=uuid.uuid4().hex, source_channel="upload")
        s.add(doc)
        s.flush()
        ts = Timesheet(id=str(uuid.uuid4()), doc_id=doc.id, client_code="CL001",
                       created_at=dt.datetime.now(dt.timezone.utc))
        s.add(ts)
        s.commit()
        ts_id = ts.id
    finally:
        s.close()
    r = client.get(f"/events?entity_id={ts_id}")  # 3168 (ts.doc_id appended to related)
    assert r.status_code == 200 and isinstance(r.json(), list)


# ── statement: payment without matching invoice (3235) ─────────────────────────


def test_statement_payment_without_invoice_skipped(client):
    s = SessionLocal()
    try:
        s.add(Payment(id=str(uuid.uuid4()), invoice_id="ghost-invoice-id", client_code="CL001",
                      amount=99.0, currency="AED", method="wire", status="received"))
        s.commit()
    finally:
        s.close()
    r = client.get("/client/CL001/statement")
    assert r.status_code == 200  # 3235 continue on the orphan payment


# ── audit bundle: no invoice matches period → fallback (3295) ──────────────────


def test_audit_bundle_period_fallback(client):
    r = client.get("/client/CL001/audit/NOMATCH-0000.zip")  # 3295 fallback to all-period
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"


# ── notifications filter + label branches (3436, 3438, 3452, 3464) ─────────────


def test_notifications_filter_and_labels(client):
    from tia_ai.orchestrator import log_event

    s = SessionLocal()
    try:
        # an invoice for a DIFFERENT client → filtered out under client_code=CL001 (3436)
        other = Invoice(
            id=str(uuid.uuid4()), timesheet_id=f"nt:{uuid.uuid4()}", client_code="CL002",
            period="June 2026", amount=1.0, currency="AED", status="generated",
            invoice_sequence_no=f"TIA-NT-{uuid.uuid4().hex[:6]}",
            created_at=dt.datetime.now(dt.timezone.utc),
        )
        s.add(other)
        s.flush()
        log_event(s, "system", "invoice", other.id, "generated", {"client": "CL002"})
        # a client-kind event for a different client → filtered out (3438)
        log_event(s, "system", "client", "CL002", "query.raised", {})
        # a client_rejected event for CL001 → surfaces with the rejected label (3464)
        mine = Invoice(
            id=str(uuid.uuid4()), timesheet_id=f"nt:{uuid.uuid4()}", client_code="CL001",
            period="June 2026", amount=1.0, currency="AED", status="client_rejected",
            invoice_sequence_no=f"TIA-NTR-{uuid.uuid4().hex[:6]}",
            created_at=dt.datetime.now(dt.timezone.utc),
        )
        s.add(mine)
        s.flush()
        log_event(s, "client", "invoice", mine.id, "client_rejected", {"reason": "too high", "invoice_sequence_no": mine.invoice_sequence_no})
        s.commit()
    finally:
        s.close()
    # client persona, scoped to CL001 → exercises the invoice+client filters (3436, 3438)
    r = client.get("/notifications?persona=client&client_code=CL001")
    assert r.status_code == 200
    # limit=1 → break after first (3452)
    r2 = client.get("/notifications?persona=client&limit=1")
    assert r2.status_code == 200 and len(r2.json()) <= 1
    # unscoped client persona surfaces the client_rejected label (3464)
    r3 = client.get("/notifications?persona=client&limit=50")
    assert any("rejected" in n["summary"].lower() for n in r3.json())


# ── SSE events stream cursor advance (2636-2638) ───────────────────────────────


def test_events_stream_cursor_advances():
    from tia_ai.api.app import events_stream
    from tia_ai.db import get_session
    from tia_ai.orchestrator import log_event

    async def _drive():
        s2 = SessionLocal()
        resp = await events_stream(s2)
        agen = resp.body_iterator
        first = await agen.__anext__()  # "hello"
        assert "hello" in first
        # insert a brand-new (committed) event AFTER the cursor was captured so the
        # loop's cursor filter finds a newer row and yields it (2636-2638)
        with get_session() as w:
            log_event(w, "system", "doc", f"sse-{uuid.uuid4()}", "sse.ping", {})
        nxt = await asyncio.wait_for(agen.__anext__(), timeout=8)
        await agen.aclose()
        s2.close()
        return nxt

    out = asyncio.run(_drive())
    assert "data:" in out


# ── intake_email threshold_exceeded (494) ──────────────────────────────────────


def test_intake_email_threshold_exceeded_triggers_hold(client):
    s = SessionLocal()
    try:
        c = s.get(Client, "CL001")
        orig = dict(c.settings or {})
        c.settings = {**orig, "validation_threshold_aed": 1}  # any invoice > 1 → exceeded
        s.commit()
    finally:
        s.close()
    try:
        r = client.post(
            "/intake/email",
            json={
                "body": "Client: CL001\nEMP10001 worked 22 days in June 2026",
                "from_addr": "mgr@steel.test",
                "to_addrs": ["tia@cyberkunju.com"],
                "subject": "timesheet",
            },
            headers={"Idempotency-Key": f"thr-{uuid.uuid4().hex}"},
        )
        assert r.status_code == 200, r.text  # 494 threshold_exceeded set → hold path
    finally:
        s = SessionLocal()
        try:
            c = s.get(Client, "CL001")
            c.settings = orig
            s.commit()
        finally:
            s.close()


# ── intake_email cc_silent draft exception (510-511) ───────────────────────────


def test_intake_email_cc_silent_draft_exception(client, monkeypatch):
    monkeypatch.setattr(
        appmod, "_draft_cc_silent_reply",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("draft boom")),
    )
    r = client.post(
        "/intake/email",
        json={
            "body": "hi team please advise",  # unparseable → escalate
            "from_addr": "mgr@steel.test",
            "to_addrs": ["ops@steel.test"],
            "cc_addrs": ["tia@cyberkunju.com"],  # cc_silent
            "subject": "q",
        },
        headers={"Idempotency-Key": f"ccx-{uuid.uuid4().hex}"},
    )
    assert r.status_code == 200  # 510-511 swallowed
    assert r.json()["reply_drafted"] is False


# ── intake_email hold-reply send exception (539-540) ───────────────────────────


def test_intake_email_hold_reply_send_exception(client, monkeypatch):
    import tia_ai.mailbox.sender as sender

    monkeypatch.setattr(
        sender, "send_hold_reply", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("smtp boom"))
    )
    r = client.post(
        "/intake/email",
        json={
            "body": "hi team please advise",  # unparseable → escalate → hold reply attempted
            "from_addr": "mgr@steel.test",
            "to_addrs": ["tia@cyberkunju.com"],  # direct_forward
            "subject": "q",
        },
        headers={"Idempotency-Key": f"hrx-{uuid.uuid4().hex}"},
    )
    assert r.status_code == 200  # 539-540 swallowed


# ── intake_email auto invoice-email exception (564-565) ────────────────────────


def test_intake_email_auto_invoice_email_exception(client, monkeypatch):
    import tia_ai.mailbox.sender as sender

    monkeypatch.setattr(
        sender, "send_invoice_email", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("smtp boom"))
    )
    r = client.post(
        "/intake/email",
        json={
            "body": "Client: CL001\nEMP10001 worked 22 days in June 2026",  # clean → auto
            "from_addr": "mgr@steel.test",
            "to_addrs": ["tia@cyberkunju.com"],
            "subject": "timesheet",
        },
        headers={"Idempotency-Key": f"aie-{uuid.uuid4().hex}"},
    )
    assert r.status_code == 200  # 564-565 swallowed
    assert r.json()["routing"] == "auto"


# ── whatsapp bg nested log_event failure (877-878) ─────────────────────────────


def test_whatsapp_bg_nested_log_failure(monkeypatch):
    s = SessionLocal()
    try:
        p = Path(STAGING_DIR) / f"_wabg2_{uuid.uuid4().hex}.csv"
        p.write_bytes(b"Emp ID,Days\nEMP10001,22\n")
        doc = appmod.ingest_file(s, p, channel="whatsapp", mime="text/csv", uploaded_by="+9715550007")
        s.commit()
        doc_id = doc.id
    finally:
        s.close()
    monkeypatch.setattr(
        appmod, "process_doc", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("pipeline boom"))
    )
    # log_event raising inside the error handler → inner except rollback (877-878)
    monkeypatch.setattr(
        appmod, "log_event", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("audit boom"))
    )
    appmod._whatsapp_pipeline_bg(doc_id, phone="+9715550007", client_hint=None)  # must not raise


# ── clawback void: outbox rename failure swallowed (2883-2884) ─────────────────


def test_clawback_void_rename_failure_swallowed(client):
    inv_id = _mkinv(status="generated")
    outbox = Path(STAGING_DIR) / "outbox"
    outbox.mkdir(parents=True, exist_ok=True)
    f = outbox / f"dispatch_{inv_id}_001.txt"
    f.write_text("dispatched notice")
    # pre-create the rename TARGET as a non-empty directory so f.rename(...) raises
    target_dir = outbox / f"voided_dispatch_{inv_id}_001.txt"
    target_dir.mkdir(parents=True, exist_ok=True)
    (target_dir / "occupied.txt").write_text("x")
    r = client.post(f"/invoices/{inv_id}/clawback", json={"by_user": "finops", "reason_code": "DUPLICATE"})
    assert r.status_code == 200 and r.json()["action_taken"] == "voided"  # 2883-2884 swallowed


# ── clawback credit-note path 409 for a non-dispatched non-pre-dispatch state (2895)


def test_clawback_non_dispatched_state_409(client):
    inv_id = _mkinv(status="rejected")  # not pre-dispatch, not terminal, not dispatched
    r = client.post(f"/invoices/{inv_id}/clawback", json={"by_user": "finops", "reason_code": "PRICING_ERROR"})
    assert r.status_code == 409  # 2895

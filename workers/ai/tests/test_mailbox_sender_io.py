"""Mailbox sender I/O paths (mailbox/sender.py) — fake SMTP (no network).

Covers send_email_reply (SSL + STARTTLS + attachment mime + failure), the .eml
replay path, send_invoice_email full send + skip/fail branches, send_hold_reply,
deliver_email_outcome routing, and _email_meta_for_timesheet parent-walk.
"""

from __future__ import annotations

import datetime as dt
import smtplib
import uuid
from email.message import EmailMessage

import pytest

from tia_ai.db import SessionLocal
from tia_ai.mailbox import sender
from tia_ai.models import DocAsset, Event, Invoice, Timesheet


@pytest.fixture()
def s():
    sess = SessionLocal()
    try:
        yield sess
    finally:
        sess.rollback()
        sess.close()


class FakeSMTP:
    sent: list = []
    fail_login: bool = False

    def __init__(self, host, port, timeout=None):
        self.host = host

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def ehlo(self):
        pass

    def starttls(self):
        pass

    def login(self, u, p):
        if FakeSMTP.fail_login:
            raise smtplib.SMTPAuthenticationError(535, b"bad creds")

    def send_message(self, msg, from_addr=None, to_addrs=None):
        FakeSMTP.sent.append((msg, from_addr, to_addrs))


@pytest.fixture(autouse=True)
def _configure_smtp(monkeypatch):
    FakeSMTP.sent = []
    FakeSMTP.fail_login = False
    monkeypatch.setattr(sender, "ZOHO_IMAP_USER", "tia@cyberkunju.com")
    monkeypatch.setattr(sender, "ZOHO_IMAP_PASSWORD", "pw")
    monkeypatch.setattr(sender, "ZOHO_SMTP_USE_SSL", True)
    monkeypatch.setattr(smtplib, "SMTP_SSL", FakeSMTP)
    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)
    yield


# ── send_email_reply ───────────────────────────────────────────────────────────


def test_send_email_reply_ssl_with_threading_and_cc():
    res = sender.send_email_reply(
        "client@steel.test",
        "Subject",
        "body text",
        in_reply_to="orig-mid@steel.test",
        references="<older@steel.test>",
        cc_addrs=["cc@steel.test", "unknown"],
    )
    assert res["sent"] is True and res["to"] == "client@steel.test"
    msg, from_addr, to_addrs = FakeSMTP.sent[-1]
    assert msg["In-Reply-To"] == "<orig-mid@steel.test>"
    assert "<older@steel.test>" in msg["References"]
    assert "cc@steel.test" in to_addrs and "unknown" not in to_addrs


def test_send_email_reply_starttls_path(monkeypatch):
    monkeypatch.setattr(sender, "ZOHO_SMTP_USE_SSL", False)
    res = sender.send_email_reply("client@steel.test", "S", "b")
    assert res["sent"] is True
    assert FakeSMTP.sent  # went through the SMTP+STARTTLS branch


def test_send_email_reply_attachment_mime_variants():
    res = sender.send_email_reply(
        "client@steel.test",
        "S",
        "b",
        attachments=[
            ("a.pdf", "application/pdf", b"%PDF-1.4 data"),
            ("b.bin", "", b"rawbytes"),          # blank mime → guessed → octet-stream
            ("c.unknownext", "weirdmime", b"x"),  # no subtype → guess fallback
            ("d.empty", "text/plain", b""),        # empty payload → skipped
        ],
    )
    assert res["sent"] is True


def test_send_email_reply_smtp_failure_returns_reason():
    FakeSMTP.fail_login = True
    res = sender.send_email_reply("client@steel.test", "S", "b")
    assert res["sent"] is False and "smtp error" in res["reason"]


# ── send_reply_via_zoho (.eml) ──────────────────────────────────────────────────


def test_send_reply_via_zoho_unconfigured(monkeypatch, tmp_path):
    monkeypatch.setattr(sender, "ZOHO_IMAP_PASSWORD", "")
    p = tmp_path / "x.eml"
    p.write_bytes(b"To: a@b.test\n\nhi")
    assert sender.send_reply_via_zoho(p)["sent"] is False


def test_send_reply_via_zoho_multipart(tmp_path):
    m = EmailMessage()
    m["To"] = "client@steel.test"
    m["Cc"] = "cc@steel.test, unknown"
    m["Subject"] = "Re: hi"
    m.set_content("the drafted body")
    p = tmp_path / "draft.eml"
    p.write_bytes(m.as_bytes())
    res = sender.send_reply_via_zoho(p)
    assert res["sent"] is True and res["to"] == "client@steel.test"


def test_send_reply_via_zoho_singlepart(tmp_path):
    p = tmp_path / "single.eml"
    p.write_bytes(b"To: client@steel.test\nSubject: Hi\n\nplain body line")
    res = sender.send_reply_via_zoho(p)
    assert res["sent"] is True


# ── helpers to build an email-sourced invoice ───────────────────────────────────


def _email_invoice(s, tmp_path, *, with_pdf=True, from_addr="client@steel.test") -> Invoice:
    doc = DocAsset(
        id=str(uuid.uuid4()),
        content_hash=uuid.uuid4().hex,
        source_channel="email",
        uploaded_by=from_addr,
        meta={"from_addr": from_addr, "message_id": "orig@steel.test", "subject": "TS June"},
    )
    s.add(doc)
    s.flush()
    ts = Timesheet(
        id=str(uuid.uuid4()),
        doc_id=doc.id,
        client_code="CL001",
        period="June 2026",
        status="approved",
        routing="auto",
        created_at=dt.datetime.now(dt.timezone.utc),
    )
    s.add(ts)
    s.flush()
    pdf_path = None
    if with_pdf:
        pf = tmp_path / f"inv_{uuid.uuid4().hex[:6]}.pdf"
        pf.write_bytes(b"%PDF-1.4 fake invoice")
        pdf_path = str(pf)
    inv = Invoice(
        id=str(uuid.uuid4()),
        timesheet_id=ts.id,
        client_code="CL001",
        period="June 2026",
        amount=1000.0,
        total_incl_vat=1050.0,
        currency="AED",
        status="generated",
        invoice_sequence_no=f"TIA-SND-{uuid.uuid4().hex[:6]}",
        pdf_path=pdf_path,
        created_at=dt.datetime.now(dt.timezone.utc),
    )
    s.add(inv)
    s.flush()
    return inv


# ── send_invoice_email ──────────────────────────────────────────────────────────


def test_send_invoice_email_full_send(s, tmp_path):
    inv = _email_invoice(s, tmp_path)
    res = sender.send_invoice_email(s, inv)
    assert res["sent"] is True
    assert s.query(Event).filter_by(entity_id=inv.id, action="email.invoice_sent").count() == 1


def test_send_invoice_email_no_from_addr_skip(s, tmp_path):
    inv = _email_invoice(s, tmp_path)
    doc = s.get(DocAsset, s.get(Timesheet, inv.timesheet_id).doc_id)
    doc.meta = {"message_id": "x"}  # no from_addr
    s.flush()
    res = sender.send_invoice_email(s, inv)
    assert res["skipped"] == "no_from_addr"


def test_send_invoice_email_no_pdf_skip(s, tmp_path):
    inv = _email_invoice(s, tmp_path, with_pdf=False)
    res = sender.send_invoice_email(s, inv)
    assert res["skipped"] == "no_pdf"


def test_send_invoice_email_smtp_unconfigured_skip(monkeypatch, s, tmp_path):
    inv = _email_invoice(s, tmp_path)
    monkeypatch.setattr(sender, "ZOHO_IMAP_PASSWORD", "")
    res = sender.send_invoice_email(s, inv)
    assert res["skipped"] == "smtp_unconfigured"


def test_send_invoice_email_send_failure_logs_failed(s, tmp_path):
    inv = _email_invoice(s, tmp_path)
    FakeSMTP.fail_login = True
    res = sender.send_invoice_email(s, inv)
    assert res["sent"] is False
    assert s.query(Event).filter_by(entity_id=inv.id, action="email.invoice_send_failed").count() == 1


# ── send_hold_reply ─────────────────────────────────────────────────────────────


def test_send_hold_reply_no_from_addr(s):
    doc = DocAsset(id=str(uuid.uuid4()), content_hash=uuid.uuid4().hex, source_channel="email")
    s.add(doc)
    s.flush()
    res = sender.send_hold_reply(s, None, doc, "subj", None, "mid")
    assert res["skipped"] == "no_from_addr"


def test_send_hold_reply_smtp_unconfigured(monkeypatch, s):
    monkeypatch.setattr(sender, "ZOHO_IMAP_PASSWORD", "")
    doc = DocAsset(id=str(uuid.uuid4()), content_hash=uuid.uuid4().hex, source_channel="email")
    s.add(doc)
    s.flush()
    res = sender.send_hold_reply(s, None, doc, "subj", "a@b.test", "mid")
    assert res["skipped"] == "smtp_unconfigured"


def test_send_hold_reply_full_with_friendly_reason(s, tmp_path):
    inv = _email_invoice(s, tmp_path)
    ts = s.get(Timesheet, inv.timesheet_id)
    ts.hitl_reason = "low confidence"
    ts.routing = "hitl"
    inv.rule_results = [
        {"rule_id": "R4", "passed": False, "severity": "error", "message": "OT over cap"}
    ]
    doc = s.get(DocAsset, ts.doc_id)
    s.flush()
    res = sender.send_hold_reply(
        s, ts, doc, "TS June", "client@steel.test", "orig@steel.test"
    )
    assert res["sent"] is True
    assert s.query(Event).filter_by(entity_id=doc.id, action="email.hold_reply_sent").count() == 1


def test_send_hold_reply_idempotent_replay(s):
    from tia_ai.orchestrator import log_event

    doc = DocAsset(id=str(uuid.uuid4()), content_hash=uuid.uuid4().hex, source_channel="email")
    s.add(doc)
    s.flush()
    key = f"hold-reply:mid-x"
    log_event(s, "system", "doc", doc.id, "email.hold_reply_sent", {}, idempotency_key=key)
    s.flush()
    res = sender.send_hold_reply(s, None, doc, "subj", "a@b.test", "mid-x")
    assert res["skipped"] == "already_sent"


def test_send_hold_reply_send_failure_logs(s, tmp_path):
    inv = _email_invoice(s, tmp_path)
    ts = s.get(Timesheet, inv.timesheet_id)
    ts.routing = "hitl"
    doc = s.get(DocAsset, ts.doc_id)
    s.flush()
    FakeSMTP.fail_login = True
    res = sender.send_hold_reply(s, ts, doc, "TS June", "client@steel.test", "orig@steel.test")
    assert res["sent"] is False
    assert s.query(Event).filter_by(entity_id=doc.id, action="email.hold_reply_send_failed").count() == 1


# ── deliver_email_outcome ────────────────────────────────────────────────────────


def test_deliver_email_outcome_none_ts(s):
    assert sender.deliver_email_outcome(s, None) is None


def test_deliver_email_outcome_non_email_doc(s):
    doc = DocAsset(id=str(uuid.uuid4()), content_hash=uuid.uuid4().hex, source_channel="upload")
    s.add(doc)
    s.flush()
    ts = Timesheet(id=str(uuid.uuid4()), doc_id=doc.id, client_code="CL001", routing="auto")
    s.add(ts)
    s.flush()
    assert sender.deliver_email_outcome(s, ts) is None


def test_deliver_email_outcome_no_from_addr(s):
    doc = DocAsset(
        id=str(uuid.uuid4()), content_hash=uuid.uuid4().hex, source_channel="email", meta={}
    )
    s.add(doc)
    s.flush()
    ts = Timesheet(id=str(uuid.uuid4()), doc_id=doc.id, client_code="CL001", routing="auto")
    s.add(ts)
    s.flush()
    assert sender.deliver_email_outcome(s, ts) is None


def test_deliver_email_outcome_auto_sends_invoice(s, tmp_path):
    inv = _email_invoice(s, tmp_path)
    ts = s.get(Timesheet, inv.timesheet_id)
    ts.routing = "auto"
    s.flush()
    res = sender.deliver_email_outcome(s, ts)
    assert res is not None and res.get("sent") is True


def test_deliver_email_outcome_auto_no_invoice_returns_none(s):
    doc = DocAsset(
        id=str(uuid.uuid4()),
        content_hash=uuid.uuid4().hex,
        source_channel="email",
        meta={"from_addr": "a@b.test"},
    )
    s.add(doc)
    s.flush()
    ts = Timesheet(id=str(uuid.uuid4()), doc_id=doc.id, client_code="CL001", routing="auto")
    s.add(ts)
    s.flush()
    assert sender.deliver_email_outcome(s, ts) is None


def test_deliver_email_outcome_hitl_sends_hold(s):
    doc = DocAsset(
        id=str(uuid.uuid4()),
        content_hash=uuid.uuid4().hex,
        source_channel="email",
        meta={"from_addr": "client@steel.test", "message_id": "m1", "subject": "TS"},
    )
    s.add(doc)
    s.flush()
    ts = Timesheet(
        id=str(uuid.uuid4()), doc_id=doc.id, client_code="CL001", period="June 2026", routing="hitl"
    )
    s.add(ts)
    s.flush()
    res = sender.deliver_email_outcome(s, ts)
    assert res is not None and res.get("sent") is True


# ── _email_meta_for_timesheet parent walk ────────────────────────────────────────


def test_email_meta_walks_parent_doc(s):
    parent = DocAsset(
        id=str(uuid.uuid4()),
        content_hash=uuid.uuid4().hex,
        source_channel="email",
        meta={"from_addr": "parent@steel.test", "message_id": "pmid", "subject": "P"},
    )
    s.add(parent)
    s.flush()
    child = DocAsset(
        id=str(uuid.uuid4()),
        content_hash=uuid.uuid4().hex,
        source_channel="email",
        parent_doc_id=parent.id,
        meta={},  # no from_addr → walk to parent
    )
    s.add(child)
    s.flush()
    ts = Timesheet(id=str(uuid.uuid4()), doc_id=child.id, client_code="CL001")
    s.add(ts)
    s.flush()
    from_addr, mid, subject, cc = sender._email_meta_for_timesheet(s, ts)
    assert from_addr == "parent@steel.test" and mid == "pmid"


def test_email_meta_none_when_no_doc(s):
    ts = Timesheet(id=str(uuid.uuid4()), client_code="CL001")  # no doc_id
    assert sender._email_meta_for_timesheet(s, ts) == (None, None, None, [])

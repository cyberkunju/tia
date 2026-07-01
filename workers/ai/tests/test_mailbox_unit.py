"""Mailbox unit tests (mailbox/sender.py, mailbox/poller.py).

Hermetic - no real SMTP/IMAP. Covers the not-configured guards, the
send_invoice_email skip paths, and the poller's pure parsing/classification
helpers (bounce detection, body+attachment walk, address parsing).
"""

from __future__ import annotations

import email as email_pkg
import uuid
from email.message import EmailMessage

import pytest

from tia_ai.db import SessionLocal
from tia_ai.mailbox import sender
from tia_ai.mailbox import poller
from tia_ai.models import DocAsset, Invoice, Timesheet


# ── sender: not configured in test env ───────────────────────────────────────


def test_smtp_not_configured_in_test_env():
    assert sender.smtp_configured() is False


def test_send_email_reply_unconfigured_is_noop():
    res = sender.send_email_reply("x@y.test", "subj", "body")
    assert res["sent"] is False
    assert "not configured" in res["reason"].lower()


def test_send_email_reply_no_recipient_guard(monkeypatch):
    # configure SMTP so we pass the config gate, then assert the recipient guard
    # short-circuits BEFORE any socket is opened
    monkeypatch.setattr(sender, "ZOHO_IMAP_USER", "tia@test.local")
    monkeypatch.setattr(sender, "ZOHO_IMAP_PASSWORD", "secret")
    res = sender.send_email_reply("unknown", "subj", "body")
    assert res["sent"] is False and res["reason"] == "no recipient"


def test_send_invoice_email_skips_non_email_source():
    s = SessionLocal()
    try:
        doc = DocAsset(
            id=str(uuid.uuid4()),
            content_hash=uuid.uuid4().hex,
            source_channel="upload",  # NOT email
            uploaded_by="client",
        )
        s.add(doc)
        s.flush()
        ts = Timesheet(id=str(uuid.uuid4()), doc_id=doc.id, client_code="CL001", status="approved")
        s.add(ts)
        s.flush()
        inv = Invoice(id=str(uuid.uuid4()), timesheet_id=ts.id, client_code="CL001", amount=10.0)
        s.add(inv)
        s.flush()
        res = sender.send_invoice_email(s, inv)
        assert res["sent"] is False and res["skipped"] == "not_email_source"
    finally:
        s.rollback()
        s.close()


def test_send_invoice_email_idempotent_replay():
    s = SessionLocal()
    try:
        from tia_ai.orchestrator import log_event

        inv_id = str(uuid.uuid4())
        key = f"invoice-reply:{inv_id}"
        # a prior send (recorded as an event with the idempotency key) short-circuits
        log_event(s, "system", "invoice", inv_id, "email.invoice_sent", {}, idempotency_key=key)
        s.flush()
        inv = Invoice(id=inv_id, timesheet_id=f"x:{uuid.uuid4()}", client_code="CL001", amount=1.0)
        s.add(inv)
        s.flush()
        res = sender.send_invoice_email(s, inv)
        assert res["sent"] is False and res["skipped"] == "already_sent"
    finally:
        s.rollback()
        s.close()


# ── poller: pure helpers ─────────────────────────────────────────────────────


def test_decode_handles_bytes_str_none():
    assert poller._decode(None) == ""
    assert poller._decode("hi") == "hi"
    assert poller._decode(b"hi") == "hi"
    assert poller._decode(b"\xff\xfe") != ""  # latin-1 fallback, never raises


def test_addrs_from_header_parses_multiple():
    addrs = poller._addrs_from_header("Carlos <a@b.test>, second@c.test")
    assert "a@b.test" in addrs and "second@c.test" in addrs
    assert poller._addrs_from_header(None) == []


@pytest.mark.parametrize(
    "headers",
    [
        {"Auto-Submitted": "auto-replied"},
        {"Precedence": "bulk"},
        {"From": "mailer-daemon@host.test"},
        {"From": "noreply@host.test"},
        {"Subject": "Out of Office: away"},
        {"Subject": "Mail delivery failed: returning message"},
        {"Return-Path": "<>"},
    ],
)
def test_bounce_and_autoreply_detected(headers):
    msg = email_pkg.message.Message()
    for k, v in headers.items():
        msg[k] = v
    assert poller._is_bounce_or_autoreply(msg) is True


def test_genuine_message_is_not_a_bounce():
    msg = email_pkg.message_from_string(
        "From: manager@steel.test\nTo: tia@cyberkunju.com\nSubject: Timesheet June\n\nEMP10001 - 22 days"
    )
    assert poller._is_bounce_or_autoreply(msg) is False


def test_walk_body_extracts_text_and_attachments():
    m = EmailMessage()
    m["From"] = "x@y.test"
    m["Subject"] = "ts"
    m.set_content("EMP10001 Carlos Smith - 22 days")
    m.add_attachment(b"col1,col2\n1,2\n", maintype="text", subtype="csv", filename="ts.csv")
    body, attachments = poller._walk_body(m)
    assert "Carlos Smith" in body
    assert len(attachments) == 1
    name, mime, payload = attachments[0]
    assert name == "ts.csv" and "csv" in mime and payload


def test_walk_body_html_only_falls_back_to_stripped_text():
    m = EmailMessage()
    m["From"] = "x@y.test"
    m.set_content("<p>EMP10001 worked <b>22</b> days</p>", subtype="html")
    body, attachments = poller._walk_body(m)
    assert "22 days" in body.replace("  ", " ")
    assert attachments == []


def test_imap_health_missing_creds_in_test_env():
    # creds are nulled by conftest → no network probe, returns the missing verdict
    assert poller.imap_health() == "missing_creds"


def test_zoho_poller_not_configured_in_test_env():
    z = poller.ZohoPoller()
    assert z.configured() is False
    assert z.poll_once() == 0  # no-op when unconfigured

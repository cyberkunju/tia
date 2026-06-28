"""E-series email pipeline tests - TASC TIA hardening sprint.

Covers:
  E1   friendly rule descriptions in cc_silent reply
  E3   .eml attachment extraction → sibling DocAssets
  E5   /intake/mailbox-webhook HMAC signature
  E9   unknown email mode → escalate (orphan)
  E10  watched_mailbox annotates `watched_address` in event payload
"""

import hashlib
import hmac
import json
import os
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# Tests run against a dedicated test DB (configured in conftest.py)
from tia_ai.api.app import app
from tia_ai.validate.rules_v2 import friendly_message


client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_state():
    """Wipe transient state so each test runs clean."""
    client.post("/admin/demo-reset")
    yield


# ─────────────────────────── E1 ───────────────────────────────────────


def test_e1_friendly_message_table_covers_all_rules():
    # R9 (approver_signature_present) was retired - was a warning-severity rule
    # that fired on every clean demo invoice and added no signal.
    for rid in ("R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R10", "R14"):
        msg = friendly_message(rid)
        assert msg, f"{rid} has no friendly message"
        assert len(msg) > 10
        # ensure we don't leak the bare rule_id to the client
        assert rid not in msg


def test_e1_unknown_rule_returns_none():
    assert friendly_message(None) is None
    assert friendly_message("R999") is None


# ─────────────────────────── E5 ───────────────────────────────────────


def test_e5_webhook_rejects_bad_signature_when_secret_set(monkeypatch):
    monkeypatch.setenv("MAILBOX_WEBHOOK_SECRET", "topsecret")
    r = client.post(
        "/intake/mailbox-webhook",
        json={"From": "x@y.test", "To": "watched@tia.test", "TextBody": "hi"},
        headers={"X-Webhook-Signature": "bad"},
    )
    assert r.status_code == 401


def test_e5_webhook_passes_with_correct_signature(monkeypatch):
    monkeypatch.setenv("MAILBOX_WEBHOOK_SECRET", "topsecret")
    body = {
        "Cc": None,
        "From": "site@steel.test",
        "HtmlBody": None,
        "Subject": "M",
        "TextBody": "EMP10001 Carlos Smith - 22 days",
        "To": "timesheets-cl001@tia-watch.test",
    }
    raw = json.dumps(body, separators=(",", ":"), sort_keys=True).encode()
    sig = hmac.new(b"topsecret", raw, "sha256").hexdigest()
    r = client.post(
        "/intake/mailbox-webhook",
        json=body,
        headers={"X-Webhook-Signature": sig},
    )
    assert r.status_code == 200, r.text


def test_e5_webhook_skipped_when_no_secret_set(monkeypatch):
    monkeypatch.delenv("MAILBOX_WEBHOOK_SECRET", raising=False)
    r = client.post(
        "/intake/mailbox-webhook",
        json={"From": "x@y.test", "To": "watched@tia.test", "TextBody": "hi"},
    )
    # no auth required when secret unset (dev-friendly)
    assert r.status_code == 200, r.text


# ─────────────────────────── E9 ───────────────────────────────────────


def test_e9_orphan_email_escalates():
    r = client.post(
        "/intake/email",
        json={
            "body": "random",
            "subject": "x",
            "from_addr": "stranger@nowhere.test",
            "to_addrs": ["random@other.test"],  # no TIA, no watched mailbox
        },
    )
    assert r.status_code == 200
    d = r.json()
    assert d["intake_mode"] == "unknown"
    assert d["routing"] == "escalate"
    assert d["confidence"] == 0.0


# ─────────────────────────── E10 ──────────────────────────────────────


def test_e10_watched_mailbox_traces_address(monkeypatch):
    monkeypatch.delenv("MAILBOX_WEBHOOK_SECRET", raising=False)
    r = client.post(
        "/intake/mailbox-webhook",
        json={
            "From": "site@steel.test",
            "To": "timesheets-cl001@tia-watch.test",
            "Subject": "M",
            "TextBody": "EMP10001 Carlos Smith - 22 days",
        },
    )
    assert r.status_code == 200
    doc_id = r.json()["doc_id"]
    ev = client.get(f"/events?entity_id={doc_id}").json()
    mode_events = [e for e in ev if e["action"] == "email.mode_detected"]
    assert mode_events, "expected an email.mode_detected event"
    assert mode_events[0]["payload"].get("watched_address") == "timesheets-cl001@tia-watch.test"


# ─────────────────────────── E3 ───────────────────────────────────────


def _build_eml_with_attachment(payload_bytes: bytes, filename: str, mime_subtype: str) -> bytes:
    m = MIMEMultipart()
    m["From"] = "manager@steel.test"
    m["To"] = "tia@cyberkunju.com"
    m["Subject"] = "Test"
    m.attach(MIMEText("Body: EMP10001 Carlos Smith - 22 days, 2 OT", "plain"))
    a = MIMEApplication(payload_bytes, _subtype=mime_subtype)
    a.add_header("Content-Disposition", "attachment", filename=filename)
    m.attach(a)
    return m.as_bytes()


def test_e3_eml_with_attachment_creates_sibling_docs(tmp_path: Path):
    # build a multipart .eml carrying a real case_07 xlsx as attachment
    fixture = Path(__file__).resolve().parents[3] / "data" / "synthetic" / "case_07_clean.xlsx"
    if not fixture.exists():
        pytest.skip("seed data missing")
    raw = _build_eml_with_attachment(
        fixture.read_bytes(),
        "timesheet.xlsx",
        "vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    p = tmp_path / "msg.eml"
    p.write_bytes(raw)
    with p.open("rb") as f:
        r = client.post(
            "/intake/upload",
            files={"file": ("msg.eml", f, "message/rfc822")},
            headers={"Idempotency-Key": "e3-test"},
        )
    assert r.status_code == 200, r.text
    d = r.json()
    # both body (parent) and attachment (child) created
    assert d["attachments"], "expected attachments[] to be populated"
    assert any(att["filename"] == "timesheet.xlsx" for att in d["attachments"])
    # child has its own timesheet_id distinct from parent
    parent_ts = d["timesheet_id"]
    child = d["attachments"][0]
    assert child["timesheet_id"] != parent_ts


def test_e3_eml_without_attachment_processes_only_body(tmp_path: Path):
    m = MIMEMultipart()
    m["From"] = "x@y.test"
    m["To"] = "tia@cyberkunju.com"
    m["Subject"] = "no att"
    m.attach(MIMEText("EMP10001 Carlos Smith - 22 days", "plain"))
    p = tmp_path / "msg.eml"
    p.write_bytes(m.as_bytes())
    with p.open("rb") as f:
        r = client.post(
            "/intake/upload",
            files={"file": ("msg.eml", f, "message/rfc822")},
            headers={"Idempotency-Key": "e3-no-att"},
        )
    assert r.status_code == 200, r.text
    assert r.json()["attachments"] == []

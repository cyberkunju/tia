"""Remaining mailbox defensive branches — poller close/logout swallows, empty-fetch
continues, IDLE abort/finally, run_forever transient/unexpected/interval paths, and
imap_health logout swallow; sender attachment-mime fallback, .eml multipart walk,
parent-walk-to-None, and the hold-reply ts.validations branch. Fake IMAP/SMTP; no net."""

from __future__ import annotations

import email as email_pkg
import imaplib
import mimetypes
import smtplib
import uuid
from email.message import EmailMessage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import pytest

from tia_ai.db import SessionLocal
from tia_ai.mailbox import poller as P
from tia_ai.mailbox import sender
from tia_ai.models import DocAsset, Timesheet


# ─────────────────────────── poller: pure helpers ───────────────────────────


def test_is_bounce_multipart_report():
    m = MIMEMultipart("report")  # Content-Type: multipart/report → line 83
    m["From"] = "x@y.test"
    assert P._is_bounce_or_autoreply(m) is True


def test_walk_body_skips_empty_attachment():
    m = MIMEMultipart()
    m["Subject"] = "s"
    m.attach(MIMEText("real body"))
    # an attachment part with an EMPTY payload → continue (line 129)
    empty = MIMEText("")
    empty.set_payload("")
    empty.add_header("Content-Disposition", "attachment", filename="empty.txt")
    m.attach(empty)
    body, atts = P._walk_body(m)
    assert "real body" in body
    assert atts == []  # empty attachment skipped


# ─────────────────────────── poller: fake IMAP ──────────────────────────────


class FakeIMAP:
    instances: list = []
    search_result = ("OK", [b""])
    fetch_map: dict = {}
    close_raises = False
    logout_raises = False
    send_raises = False
    capabilities = ("IDLE",)

    def __init__(self, *a, **k):
        FakeIMAP.instances.append(self)
        self.sock = self
        self._idx = 0

    def settimeout(self, *_a):
        pass

    def login(self, u, p):
        return ("OK", [b"ok"])

    def select(self, folder):
        return ("OK", [b"1"])

    def uid(self, cmd, *args):
        if cmd == "search":
            return FakeIMAP.search_result
        if cmd == "fetch":
            uid = args[0]
            if uid not in FakeIMAP.fetch_map:
                return ("NO", [None])
            return ("OK", [(b"1 (RFC822 {n}", FakeIMAP.fetch_map[uid]), b")"])
        if cmd == "store":
            return ("OK", [b"1"])
        return ("OK", [b""])

    def _new_tag(self):
        return b"A001"

    def send(self, data):
        if FakeIMAP.send_raises:
            raise RuntimeError("send failed")
        return len(data)

    def readline(self):
        self._idx += 1
        return b"+ idling\r\n" if self._idx == 1 else b"* 1 EXISTS\r\n"

    def close(self):
        if FakeIMAP.close_raises:
            raise RuntimeError("close failed")

    def logout(self):
        if FakeIMAP.logout_raises:
            raise RuntimeError("logout failed")


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    FakeIMAP.instances = []
    FakeIMAP.search_result = ("OK", [b""])
    FakeIMAP.fetch_map = {}
    FakeIMAP.close_raises = False
    FakeIMAP.logout_raises = False
    FakeIMAP.send_raises = False
    FakeIMAP.capabilities = ("IDLE",)
    monkeypatch.setattr(imaplib, "IMAP4_SSL", FakeIMAP)
    P._HEALTH_CACHE.update(value=None, at=0.0)
    yield


def _poller():
    return P.ZohoPoller(api_base="http://tia.test", user="tia@cyberkunju.com", password="pw")


def _raw() -> bytes:
    m = EmailMessage()
    m["From"] = "sender@steel.test"
    m["To"] = "tia@cyberkunju.com"
    m["Subject"] = "TS"
    m["Message-ID"] = "<m@x>"
    m.set_content("EMP10001 22 days")
    return m.as_bytes()


# ── fetch_unseen empty-fetch continue (188) + close swallow (193-194) ──────────


def test_fetch_unseen_empty_raw_continues():
    FakeIMAP.search_result = ("OK", [b"5"])
    FakeIMAP.fetch_map = {b"5": b""}  # tuple with empty bytes → `if not raw: continue` (188)
    assert list(_poller().fetch_unseen()) == []


def test_fetch_unseen_close_failure_swallowed():
    FakeIMAP.search_result = ("OK", [b""])
    FakeIMAP.close_raises = True  # close raises → except pass (193-194)
    assert list(_poller().fetch_unseen()) == []


def test_mark_seen_close_failure_swallowed():
    FakeIMAP.close_raises = True  # 204-205
    _poller().mark_seen(b"1")  # must not raise


# ── poll_once empty-fetch continue (363) + close/logout swallow (375-380) ──────


def test_poll_once_empty_raw_continues():
    FakeIMAP.search_result = ("OK", [b"9"])
    FakeIMAP.fetch_map = {b"9": b""}  # line 363
    assert _poller().poll_once() == 0


def test_poll_once_close_and_logout_failures_swallowed():
    FakeIMAP.search_result = ("OK", [b""])
    FakeIMAP.close_raises = True
    FakeIMAP.logout_raises = True  # 375-376 + 379-380
    assert _poller().poll_once() == 0


# ── _idle_wait outer except (424-426) + finally logout swallow (430-431) ───────


def test_idle_wait_send_failure_returns_false():
    FakeIMAP.send_raises = True  # raises inside the try → outer except → 424-426
    assert _poller()._idle_wait() is False


def test_idle_wait_logout_failure_swallowed_in_finally():
    FakeIMAP.logout_raises = True  # idle succeeds, finally logout raises → 430-431
    assert _poller()._idle_wait() is True


# ── run_forever transient (495) / unexpected (499) / interval else (509) ───────


class _StopLoop(Exception):
    pass


def test_run_forever_transient_then_continue(monkeypatch):
    z = _poller()
    monkeypatch.setattr(z, "_acquire_singleton", lambda: "no-lock-needed")
    calls = {"n": 0}

    def _poll():
        calls["n"] += 1
        if calls["n"] == 1:
            raise OSError("transient")
        return 0

    monkeypatch.setattr(z, "poll_once", _poll)
    monkeypatch.setattr(z, "_idle_wait", lambda: (_ for _ in ()).throw(_StopLoop()))
    monkeypatch.setattr(P.time, "sleep", lambda _s: None)  # transient backoff no-op → continue (495)
    with pytest.raises(_StopLoop):
        z.run_forever(interval_s=1)
    assert calls["n"] >= 2


def test_run_forever_unexpected_then_continue(monkeypatch):
    z = _poller()
    monkeypatch.setattr(z, "_acquire_singleton", lambda: "no-lock-needed")
    calls = {"n": 0}

    def _poll():
        calls["n"] += 1
        if calls["n"] == 1:
            raise ValueError("weird")
        return 0

    monkeypatch.setattr(z, "poll_once", _poll)
    monkeypatch.setattr(z, "_idle_wait", lambda: (_ for _ in ()).throw(_StopLoop()))
    monkeypatch.setattr(P.time, "sleep", lambda _s: None)  # unexpected backoff no-op → continue (499)
    with pytest.raises(_StopLoop):
        z.run_forever(interval_s=1)
    assert calls["n"] >= 2


def test_run_forever_interval_else_branch(monkeypatch):
    z = _poller()
    monkeypatch.setattr(z, "_acquire_singleton", lambda: "no-lock-needed")
    monkeypatch.setattr(z, "poll_once", lambda: 1)
    monkeypatch.setattr(z, "_idle_wait", lambda: False)  # → use_idle=False after iter1
    seq = {"n": 0}

    def _sleep(_s):
        seq["n"] += 1
        if seq["n"] >= 2:  # first sleep is at 507 (idle-unavailable), second at 509 (else)
            raise _StopLoop()

    monkeypatch.setattr(P.time, "sleep", _sleep)
    with pytest.raises(_StopLoop):
        z.run_forever(interval_s=1)
    assert seq["n"] >= 2


# ── imap_health logout swallow (543-544) ───────────────────────────────────────


def test_imap_health_logout_failure_still_ok(monkeypatch):
    monkeypatch.setattr(P, "ZOHO_IMAP_USER", "u@x.test")
    monkeypatch.setattr(P, "ZOHO_IMAP_PASSWORD", "pw")
    FakeIMAP.logout_raises = True  # logout raises → except pass (543-544); verdict stays ok
    assert P.imap_health() == "ok"


# ─────────────────────────── sender ─────────────────────────────────────────


class FakeSMTP:
    sent: list = []

    def __init__(self, host, port, timeout=None):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def ehlo(self):
        pass

    def starttls(self):
        pass

    def login(self, u, p):
        pass

    def send_message(self, msg, from_addr=None, to_addrs=None):
        FakeSMTP.sent.append(msg)


@pytest.fixture()
def _smtp(monkeypatch):
    FakeSMTP.sent = []
    monkeypatch.setattr(sender, "ZOHO_IMAP_USER", "tia@cyberkunju.com")
    monkeypatch.setattr(sender, "ZOHO_IMAP_PASSWORD", "pw")
    monkeypatch.setattr(sender, "ZOHO_SMTP_USE_SSL", True)
    monkeypatch.setattr(smtplib, "SMTP_SSL", FakeSMTP)
    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)
    yield


@pytest.fixture()
def s():
    sess = SessionLocal()
    try:
        yield sess
    finally:
        sess.rollback()
        sess.close()


def test_send_attachment_mime_no_subtype_fallback(monkeypatch, _smtp):
    # guess_type returns a value with NO slash → subtype empty → application/octet-stream (112)
    monkeypatch.setattr(mimetypes, "guess_type", lambda name: ("noslash", None))
    res = sender.send_email_reply(
        "client@steel.test", "S", "b",
        attachments=[("weirdfile", "", b"rawbytes")],  # blank mime → guess → 'noslash' → 112
    )
    assert res["sent"] is True


def test_send_reply_via_zoho_true_multipart(tmp_path, _smtp):
    m = MIMEMultipart()
    m["To"] = "client@steel.test"
    m["Subject"] = "Re: hi"
    m.attach(MIMEText("the drafted plain body", "plain"))
    m.attach(MIMEText("<b>html</b>", "html"))
    p = tmp_path / "mp.eml"
    p.write_bytes(m.as_bytes())
    res = sender.send_reply_via_zoho(p)  # is_multipart True → walk (169-176)
    assert res["sent"] is True and res["to"] == "client@steel.test"


def test_email_meta_parent_walk_to_none_returns_empty(s):
    # doc has a parent_doc_id pointing at a NON-existent doc and no from_addr →
    # the walk lands on None → return (None, None, None, []) (line 211)
    doc = DocAsset(
        id=str(uuid.uuid4()),
        content_hash=uuid.uuid4().hex,
        source_channel="email",
        parent_doc_id="ghost-doc-id",
        meta={},
    )
    s.add(doc)
    s.flush()
    ts = Timesheet(id=str(uuid.uuid4()), doc_id=doc.id, client_code="CL001")
    s.add(ts)
    s.flush()
    assert sender._email_meta_for_timesheet(s, ts) == (None, None, None, [])


def test_hold_reply_uses_ts_validations_when_no_invoice(s, _smtp):
    # no invoice for this ts, but ts.validations carries a blocking failure → the
    # elif candidates = ts.validations branch (403)
    doc = DocAsset(
        id=str(uuid.uuid4()), content_hash=uuid.uuid4().hex, source_channel="email",
        meta={"from_addr": "client@steel.test"},
    )
    s.add(doc)
    s.flush()
    ts = Timesheet(
        id=str(uuid.uuid4()), doc_id=doc.id, client_code="CL001", period="June 2026",
        routing="hitl", status="awaiting_review",
        validations=[{"rule_id": "R4", "passed": False, "severity": "error", "message": "OT over cap"}],
    )
    s.add(ts)
    s.flush()
    res = sender.send_hold_reply(
        s, ts, doc, "TS June", "client@steel.test", "orig@steel.test"
    )
    assert res["sent"] is True

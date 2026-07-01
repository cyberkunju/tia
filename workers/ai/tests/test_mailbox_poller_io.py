"""Mailbox poller I/O paths (mailbox/poller.py) — fake IMAP + respx for httpx.

Covers connect/fetch/mark-seen, process_message (bounce/self-sent/attachment/
body), poll_once, IMAP IDLE, singleton election, run_forever (one iteration),
imap_health verdicts, and the CLI main().
"""

from __future__ import annotations

import email as email_pkg
import imaplib
import socket
from email.message import EmailMessage

import httpx
import pytest
import respx

from tia_ai.mailbox import poller as P


# ── fake IMAP4_SSL ──────────────────────────────────────────────────────────


def _raw(from_addr="sender@steel.test", subject="Timesheet June", body="EMP10001 22 days",
         attachment: tuple[str, str, bytes] | None = None, extra_headers: dict | None = None) -> bytes:
    m = EmailMessage()
    m["From"] = from_addr
    m["To"] = "tia@cyberkunju.com"
    m["Subject"] = subject
    m["Message-ID"] = "<mid-123@steel.test>"
    for k, v in (extra_headers or {}).items():
        m[k] = v
    m.set_content(body)
    if attachment:
        name, subtype, payload = attachment
        m.add_attachment(payload, maintype="text", subtype=subtype, filename=name)
    return m.as_bytes()


class FakeIMAP:
    """Minimal IMAP4_SSL stand-in. Class attrs script behaviour per test."""

    instances: list = []
    search_result = ("OK", [b""])
    fetch_map: dict = {}
    login_error: bool = False
    connect_error: bool = False
    # IDLE scripting
    capabilities = ("IDLE",)
    idle_plus = True  # server returns "+ idling"
    idle_lines: list = [b"* 1 EXISTS\r\n"]

    def __init__(self, *args, **kwargs):
        if FakeIMAP.connect_error:
            raise OSError("connect refused")
        FakeIMAP.instances.append(self)
        self.stored: list = []
        self.closed = False
        self.logged_out = False
        self._idle_idx = 0
        self.sock = self  # for sock.settimeout

    # sock.settimeout target
    def settimeout(self, *_a):
        pass

    def login(self, u, p):
        if FakeIMAP.login_error:
            raise imaplib.IMAP4.error("bad creds")
        return ("OK", [b"ok"])

    def select(self, folder):
        return ("OK", [b"1"])

    def uid(self, cmd, *args):
        if cmd == "search":
            return FakeIMAP.search_result
        if cmd == "fetch":
            uid = args[0]
            raw = FakeIMAP.fetch_map.get(uid)
            if raw is None:
                return ("NO", [None])
            return ("OK", [(b"1 (RFC822 {n}", raw), b")"])
        if cmd == "store":
            self.stored.append(args)
            return ("OK", [b"1"])
        return ("OK", [b""])

    # IDLE protocol bits
    def _new_tag(self):
        return b"A001"

    def send(self, data):
        return len(data)

    def readline(self):
        # first call: the "+ idling" response; subsequent: idle_lines then EOF
        if self._idle_idx == 0:
            self._idle_idx += 1
            return b"+ idling\r\n" if FakeIMAP.idle_plus else b"NO cannot idle\r\n"
        i = self._idle_idx - 1
        self._idle_idx += 1
        if i < len(FakeIMAP.idle_lines):
            return FakeIMAP.idle_lines[i]
        return b""

    def close(self):
        self.closed = True

    def logout(self):
        self.logged_out = True


@pytest.fixture(autouse=True)
def _reset_fake(monkeypatch):
    FakeIMAP.instances = []
    FakeIMAP.search_result = ("OK", [b""])
    FakeIMAP.fetch_map = {}
    FakeIMAP.login_error = False
    FakeIMAP.connect_error = False
    FakeIMAP.capabilities = ("IDLE",)
    FakeIMAP.idle_plus = True
    FakeIMAP.idle_lines = [b"* 1 EXISTS\r\n"]
    monkeypatch.setattr(imaplib, "IMAP4_SSL", FakeIMAP)
    P._HEALTH_CACHE.update(value=None, at=0.0)
    yield


def _poller() -> P.ZohoPoller:
    return P.ZohoPoller(api_base="http://tia.test", user="tia@cyberkunju.com", password="pw")


# ── _connect / fetch_unseen / mark_seen ──────────────────────────────────────


def test_connect_logs_in_and_selects():
    c = _poller()._connect()
    assert isinstance(c, FakeIMAP)


def test_fetch_unseen_yields_messages():
    FakeIMAP.search_result = ("OK", [b"1 2"])
    FakeIMAP.fetch_map = {b"1": _raw(subject="one"), b"2": _raw(subject="two")}
    out = list(_poller().fetch_unseen())
    assert len(out) == 2
    assert all(isinstance(m, email_pkg.message.Message) for _uid, m in out)


def test_fetch_unseen_search_not_ok_returns_early():
    FakeIMAP.search_result = ("NO", [b""])
    assert list(_poller().fetch_unseen()) == []


def test_fetch_unseen_skips_bad_fetch():
    FakeIMAP.search_result = ("OK", [b"9"])
    FakeIMAP.fetch_map = {}  # uid 9 → fetch returns NO
    assert list(_poller().fetch_unseen()) == []


def test_mark_seen_stores_flag():
    z = _poller()
    z.mark_seen(b"1")
    assert FakeIMAP.instances[-1].stored  # a store was issued


# ── process_message branches ─────────────────────────────────────────────────


def test_process_message_bounce_skipped():
    msg = email_pkg.message_from_bytes(_raw(from_addr="mailer-daemon@x.test"))
    res = _poller().process_message(msg)
    assert res["skipped"] == "bounce_or_autoreply"


def test_process_message_self_sent_skipped(monkeypatch):
    monkeypatch.setattr(P, "ZOHO_IMAP_USER", "tia@cyberkunju.com")
    msg = email_pkg.message_from_bytes(_raw(from_addr="tia@cyberkunju.com"))
    res = _poller().process_message(msg)
    assert res["skipped"] == "self_sent"


@respx.mock
def test_process_message_body_intake():
    route = respx.post("http://tia.test/intake/email").mock(
        return_value=httpx.Response(200, json={"timesheet_id": "ts-abc123", "routing": "auto", "intake_mode": "body"})
    )
    msg = email_pkg.message_from_bytes(_raw(body="EMP10001 22 days"))
    res = _poller().process_message(msg)
    assert route.called
    assert res["timesheet_id"] == "ts-abc123"
    assert res["attachments"] == []


@respx.mock
def test_process_message_with_attachment_uploads():
    up = respx.post("http://tia.test/intake/upload").mock(
        return_value=httpx.Response(200, json={"routing": "hitl"})
    )
    msg = email_pkg.message_from_bytes(
        _raw(body="see attached", attachment=("ts.csv", "csv", b"a,b\n1,2\n"))
    )
    res = _poller().process_message(msg)
    assert up.called
    assert res["skipped"] == "has_attachments"
    assert res["attachments"][0]["filename"] == "ts.csv"


@respx.mock
def test_process_message_attachment_http_error_captured():
    respx.post("http://tia.test/intake/upload").mock(side_effect=httpx.ConnectError("boom"))
    msg = email_pkg.message_from_bytes(
        _raw(attachment=("ts.csv", "csv", b"a,b\n1,2\n"))
    )
    res = _poller().process_message(msg)
    assert "error" in res["attachments"][0]


# ── poll_once ─────────────────────────────────────────────────────────────────


def test_poll_once_unconfigured_returns_zero():
    z = P.ZohoPoller(user="", password="")
    assert z.poll_once() == 0


def test_poll_once_search_not_ok():
    FakeIMAP.search_result = ("NO", [b""])
    assert _poller().poll_once() == 0


def test_poll_once_empty_inbox():
    FakeIMAP.search_result = ("OK", [b""])
    assert _poller().poll_once() == 0


@respx.mock
def test_poll_once_processes_and_marks_seen():
    respx.post("http://tia.test/intake/email").mock(
        return_value=httpx.Response(200, json={"timesheet_id": "t", "routing": "auto"})
    )
    FakeIMAP.search_result = ("OK", [b"1"])
    FakeIMAP.fetch_map = {b"1": _raw()}
    n = _poller().poll_once()
    assert n == 1
    assert any(args[0] == b"1" for args in FakeIMAP.instances[-1].stored)


def test_poll_once_process_exception_leaves_unseen(monkeypatch):
    FakeIMAP.search_result = ("OK", [b"1"])
    FakeIMAP.fetch_map = {b"1": _raw()}
    monkeypatch.setattr(
        P.ZohoPoller, "process_message", lambda self, msg: (_ for _ in ()).throw(RuntimeError("x"))
    )
    n = _poller().poll_once()
    assert n == 0  # failed message not counted, left unseen


def test_poll_once_skips_bad_fetch_row():
    FakeIMAP.search_result = ("OK", [b"7"])
    FakeIMAP.fetch_map = {}  # fetch returns NO → skipped
    assert _poller().poll_once() == 0


# ── _idle_wait ────────────────────────────────────────────────────────────────


def test_idle_wait_connect_failure_returns_false():
    FakeIMAP.connect_error = True
    assert _poller()._idle_wait() is False


def test_idle_wait_no_capability_returns_false():
    FakeIMAP.capabilities = ()
    assert _poller()._idle_wait() is False


def test_idle_wait_server_refuses_returns_false():
    FakeIMAP.idle_plus = False
    assert _poller()._idle_wait() is False


def test_idle_wait_exists_breaks_and_returns_true():
    FakeIMAP.idle_lines = [b"* 1 EXISTS\r\n"]
    assert _poller()._idle_wait() is True


def test_idle_wait_timeout_path():
    def _raise_timeout():
        raise socket.timeout()

    # after "+ idling", raise timeout on the readline loop
    poller = _poller()

    orig = FakeIMAP.readline

    def _readline(self):
        if self._idle_idx == 0:
            self._idle_idx += 1
            return b"+ idling\r\n"
        raise socket.timeout()

    FakeIMAP.readline = _readline
    try:
        assert poller._idle_wait() is True
    finally:
        FakeIMAP.readline = orig


def test_idle_wait_connection_closed_breaks():
    FakeIMAP.idle_lines = [b""]  # empty line → connection closed → break
    assert _poller()._idle_wait() is True


# ── _acquire_singleton ──────────────────────────────────────────────────────


def test_acquire_singleton_sqlite_needs_no_lock():
    assert _poller()._acquire_singleton() == "no-lock-needed"


def test_acquire_singleton_postgres_acquires(monkeypatch):
    class FakeConn:
        def execute(self, *a, **k):
            class R:
                def scalar(self_inner):
                    return True

            return R()

        def commit(self):
            pass

        def close(self):
            pass

    class FakeEngine:
        url = "postgresql://x/y"

        def connect(self):
            return FakeConn()

    monkeypatch.setattr(P, "engine", FakeEngine())
    got = _poller()._acquire_singleton()
    assert isinstance(got, FakeConn)


def test_acquire_singleton_postgres_not_acquired(monkeypatch):
    class FakeConn:
        def execute(self, *a, **k):
            class R:
                def scalar(self_inner):
                    return False

            return R()

        def commit(self):
            pass

        def close(self):
            pass

    class FakeEngine:
        url = "postgresql://x/y"

        def connect(self):
            return FakeConn()

    monkeypatch.setattr(P, "engine", FakeEngine())
    assert _poller()._acquire_singleton() is None


def test_acquire_singleton_lock_error_degrades(monkeypatch):
    class FakeEngine:
        url = "postgresql://x/y"

        def connect(self):
            raise RuntimeError("db down")

    monkeypatch.setattr(P, "engine", FakeEngine())
    assert _poller()._acquire_singleton() == "no-lock-needed"


# ── run_forever (one iteration then stop) ────────────────────────────────────


class _StopLoop(Exception):
    pass


def test_run_forever_unconfigured_idles(monkeypatch):
    z = P.ZohoPoller(user="", password="")

    def _sleep(_s):
        raise _StopLoop()

    monkeypatch.setattr(P.time, "sleep", _sleep)
    with pytest.raises(_StopLoop):
        z.run_forever(interval_s=1)


def test_run_forever_transient_error_backs_off(monkeypatch):
    z = _poller()
    monkeypatch.setattr(z, "_acquire_singleton", lambda: "no-lock-needed")
    monkeypatch.setattr(z, "poll_once", lambda: (_ for _ in ()).throw(OSError("net")))

    def _sleep(_s):
        raise _StopLoop()

    monkeypatch.setattr(P.time, "sleep", _sleep)
    with pytest.raises(_StopLoop):
        z.run_forever(interval_s=1)


def test_run_forever_unexpected_error_backs_off(monkeypatch):
    z = _poller()
    monkeypatch.setattr(z, "_acquire_singleton", lambda: "no-lock-needed")
    monkeypatch.setattr(z, "poll_once", lambda: (_ for _ in ()).throw(ValueError("weird")))

    def _sleep(_s):
        raise _StopLoop()

    monkeypatch.setattr(P.time, "sleep", _sleep)
    with pytest.raises(_StopLoop):
        z.run_forever(interval_s=1)


def test_run_forever_idle_unavailable_uses_interval(monkeypatch):
    z = _poller()
    monkeypatch.setattr(z, "_acquire_singleton", lambda: "no-lock-needed")
    monkeypatch.setattr(z, "poll_once", lambda: 1)
    monkeypatch.setattr(z, "_idle_wait", lambda: False)

    def _sleep(_s):
        raise _StopLoop()

    monkeypatch.setattr(P.time, "sleep", _sleep)
    with pytest.raises(_StopLoop):
        z.run_forever(interval_s=1)


def test_run_forever_standby_waits_for_lock(monkeypatch):
    z = _poller()
    calls = {"n": 0}

    def _acq():
        calls["n"] += 1
        return "no-lock-needed" if calls["n"] >= 2 else None

    monkeypatch.setattr(z, "_acquire_singleton", _acq)
    monkeypatch.setattr(z, "poll_once", lambda: 0)
    monkeypatch.setattr(z, "_idle_wait", lambda: False)

    seq = {"n": 0}

    def _sleep(_s):
        seq["n"] += 1
        # first sleep = standby retry; second = interval poll after idle unavailable. Stop on 2nd.
        if seq["n"] >= 2:
            raise _StopLoop()

    monkeypatch.setattr(P.time, "sleep", _sleep)
    with pytest.raises(_StopLoop):
        z.run_forever(interval_s=1)
    assert calls["n"] >= 2


# ── imap_health ───────────────────────────────────────────────────────────────


def test_imap_health_missing_creds(monkeypatch):
    monkeypatch.setattr(P, "ZOHO_IMAP_USER", "")
    monkeypatch.setattr(P, "ZOHO_IMAP_PASSWORD", "")
    assert P.imap_health() == "missing_creds"


def test_imap_health_ok_and_cache(monkeypatch):
    monkeypatch.setattr(P, "ZOHO_IMAP_USER", "u@x.test")
    monkeypatch.setattr(P, "ZOHO_IMAP_PASSWORD", "pw")
    assert P.imap_health() == "ok"
    # second call hits the cache (no new connect) — flip login_error, still 'ok'
    FakeIMAP.login_error = True
    assert P.imap_health() == "ok"


def test_imap_health_auth_failed(monkeypatch):
    monkeypatch.setattr(P, "ZOHO_IMAP_USER", "u@x.test")
    monkeypatch.setattr(P, "ZOHO_IMAP_PASSWORD", "pw")
    FakeIMAP.login_error = True
    assert P.imap_health() == "auth_failed"


def test_imap_health_unreachable(monkeypatch):
    monkeypatch.setattr(P, "ZOHO_IMAP_USER", "u@x.test")
    monkeypatch.setattr(P, "ZOHO_IMAP_PASSWORD", "pw")
    FakeIMAP.connect_error = True
    assert P.imap_health() == "unreachable"


# ── main() CLI ────────────────────────────────────────────────────────────────


def test_main_loop_mode(monkeypatch):
    monkeypatch.setattr("sys.argv", ["poller", "--loop"])
    called = {}
    monkeypatch.setattr(P.ZohoPoller, "run_forever", lambda self, interval_s: called.setdefault("ran", True))
    P.main()
    assert called.get("ran") is True


def test_main_oneshot_unconfigured_exits(monkeypatch):
    monkeypatch.setattr("sys.argv", ["poller"])
    monkeypatch.setattr(P.ZohoPoller, "configured", lambda self: False)
    with pytest.raises(SystemExit):
        P.main()


def test_main_oneshot_configured_polls(monkeypatch):
    monkeypatch.setattr("sys.argv", ["poller"])
    monkeypatch.setattr(P.ZohoPoller, "configured", lambda self: True)
    monkeypatch.setattr(P.ZohoPoller, "poll_once", lambda self: 3)
    P.main()  # should not raise

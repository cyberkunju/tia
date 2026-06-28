"""Zoho IMAP poller.

Polls `INBOX` for UNSEEN messages every ZOHO_POLL_INTERVAL_SEC seconds.
For each one:
  1. Parses headers + body + attachments via stdlib `email`
  2. Builds an `EmailIntake` payload
  3. POSTs internally to `/intake/email` (same code path as the manual /intake)
  4. Marks the message as SEEN on success (so we don't reprocess)
  5. If processing raises, leaves message unseen so we retry next round

Idempotency: we extract the `Message-ID` header and pass it as the
Idempotency-Key on the intake call - replays return the original outcome.

Run it as a separate process:

    uv run python -m tia_ai.mailbox.poller          # one pass
    uv run python -m tia_ai.mailbox.poller --loop   # forever
"""

from __future__ import annotations

import email as email_pkg
import imaplib
import logging
import time
from email.message import Message
from typing import Iterator

import httpx
from sqlalchemy import text

from ..config import (
    ZOHO_IMAP_FOLDER,
    ZOHO_IMAP_HOST,
    ZOHO_IMAP_PASSWORD,
    ZOHO_IMAP_PORT,
    ZOHO_IMAP_USER,
    ZOHO_POLL_INTERVAL_SEC,
)
from ..db import engine

# App-wide constant so every worker process competes for the SAME advisory lock.
_SINGLETON_LOCK_KEY = 873421001

log = logging.getLogger("tia.mailbox.poller")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s  %(message)s")


def _decode(b: bytes | str | None) -> str:
    if b is None:
        return ""
    if isinstance(b, str):
        return b
    try:
        return b.decode()
    except UnicodeDecodeError:
        return b.decode("latin-1", errors="replace")


def _addrs_from_header(raw: str | None) -> list[str]:
    if not raw:
        return []
    parsed = email_pkg.utils.getaddresses([raw])
    return [a.strip() for _name, a in parsed if a and a.strip()]


def _is_bounce_or_autoreply(msg: Message) -> bool:
    """Detect bounces / DSNs / auto-replies / mail loops.

    Standard signals (RFC 3464 + RFC 3834 + everyday spam-control conventions):
      1. `Auto-Submitted` header set to anything other than "no"
      2. `Content-Type: multipart/report` (DSN format)
      3. `Precedence: bulk|junk|list`
      4. From address is mailer-daemon / postmaster / noreply / bounce
      5. Subject indicates undeliverable / out-of-office / auto-reply
      6. Null Return-Path (`<>`)
    """
    auto = (msg.get("Auto-Submitted") or "").lower().strip()
    if auto and auto != "no":
        return True
    ctype = (msg.get_content_type() or "").lower()
    if "multipart/report" in ctype:
        return True
    precedence = (msg.get("Precedence") or "").lower().strip()
    if precedence in ("bulk", "junk", "list", "auto_reply"):
        return True
    from_raw = (msg.get("From") or "").lower()
    bounce_markers = (
        "mailer-daemon",
        "postmaster",
        "noreply",
        "no-reply",
        "bounce",
        "do-not-reply",
        "donotreply",
    )
    if any(m in from_raw for m in bounce_markers):
        return True
    return_path = (msg.get("Return-Path") or "").strip()
    if return_path == "<>":
        return True
    subj = _decode(msg.get("Subject", "")).lower()
    subj_markers = (
        "undelivered",
        "delivery status",
        "delivery failure",
        "mail delivery failed",
        "returned mail",
        "out of office",
        "auto-reply",
        "automatic reply",
    )
    if any(m in subj for m in subj_markers):
        return True
    return False


def _walk_body(msg: Message) -> tuple[str, list[tuple[str, str, bytes]]]:
    """Return `(body_text, [(filename, mime, bytes)])`."""
    body_chunks: list[str] = []
    attachments: list[tuple[str, str, bytes]] = []
    for part in msg.walk():
        if part.is_multipart():
            continue
        cd = (part.get("Content-Disposition") or "").lower()
        if "attachment" in cd or part.get_filename():
            payload = part.get_payload(decode=True) or b""
            if not payload:
                continue
            name = part.get_filename() or f"attachment-{len(attachments) + 1}.bin"
            mime = part.get_content_type() or "application/octet-stream"
            attachments.append((name, mime, payload))
            continue
        ctype = (part.get_content_type() or "").lower()
        if ctype == "text/plain":
            payload = part.get_payload(decode=True) or b""
            body_chunks.append(_decode(payload))
        elif ctype == "text/html" and not body_chunks:
            import re

            payload = part.get_payload(decode=True) or b""
            body_chunks.append(re.sub(r"<[^>]+>", "", _decode(payload)))
    return ("\n".join(body_chunks).strip(), attachments)


class ZohoPoller:
    def __init__(
        self,
        api_base: str = "http://127.0.0.1:8000",
        host: str = ZOHO_IMAP_HOST,
        port: int = ZOHO_IMAP_PORT,
        user: str = ZOHO_IMAP_USER,
        password: str = ZOHO_IMAP_PASSWORD,
        folder: str = ZOHO_IMAP_FOLDER,
    ):
        self.api_base = api_base.rstrip("/")
        self.host = host
        self.port = port
        self.user = user
        self.password = password
        self.folder = folder

    def configured(self) -> bool:
        return bool(self.user and self.password)

    def _connect(self) -> imaplib.IMAP4_SSL:
        c = imaplib.IMAP4_SSL(self.host, self.port)
        c.login(self.user, self.password)
        c.select(self.folder)
        return c

    def fetch_unseen(self) -> Iterator[tuple[bytes, Message]]:
        """Yield (imap_uid, parsed_message) for each UNSEEN message in INBOX."""
        c = self._connect()
        try:
            typ, data = c.uid("search", None, "UNSEEN")
            if typ != "OK":
                log.warning("imap search returned %s", typ)
                return
            uids = data[0].split()
            log.info("zoho: %d UNSEEN message(s) in %s", len(uids), self.folder)
            for uid in uids:
                typ, rfc = c.uid("fetch", uid, "(RFC822)")
                if typ != "OK" or not rfc or not rfc[0]:
                    continue
                raw = rfc[0][1] if isinstance(rfc[0], tuple) else None
                if not raw:
                    continue
                yield uid, email_pkg.message_from_bytes(raw)
        finally:
            try:
                c.close()
            except Exception:  # noqa: BLE001
                pass
            c.logout()

    def mark_seen(self, uid: bytes) -> None:
        c = self._connect()
        try:
            c.uid("store", uid, "+FLAGS", "(\\Seen)")
        finally:
            try:
                c.close()
            except Exception:  # noqa: BLE001
                pass
            c.logout()

    def process_message(self, msg: Message) -> dict:
        """Adapt a parsed email Message into our intake shape and POST it.

        Behaviour:
          - If the message has NO attachments, the body goes through `/intake/email`
            (legacy path — case_02/03/06 etc, plain-text rosters in the body).
          - If the message HAS attachments, the body intake is skipped: the
            attachment IS the timesheet, the body is just context. The body
            text is forwarded as an `email_body` form field on `/intake/upload`
            so the extractor can still mine it for period/client hints when
            the OCR didn't pick them up (orchestrator.process_doc fills those
            null-only — OCR always wins).

        Bounces / auto-replies / mail loops are filtered upfront — replying to
        a bounce just creates another bounce, and TIA's outbound reply path
        would create a doom-loop.
        """
        if _is_bounce_or_autoreply(msg):
            log.info(
                "zoho-poll skipping bounce/auto-reply: subj=%r from=%s",
                _decode(msg.get("Subject", "")),
                msg.get("From"),
            )
            return {"skipped": "bounce_or_autoreply"}

        from_addr_list = _addrs_from_header(msg.get("From"))
        to_addrs = _addrs_from_header(msg.get("To"))
        cc_addrs = _addrs_from_header(msg.get("Cc"))
        subject = _decode(msg.get("Subject", "(no subject)"))
        message_id = (msg.get("Message-ID") or "").strip().strip("<>") or None

        body, attachments = _walk_body(msg)
        from_addr = from_addr_list[0] if from_addr_list else None

        # Loop guard: never process a message sent FROM our own mailbox. TIA's
        # outbound replies go to the client, not to itself, so this is normally a
        # no-op — but if our address is ever CC'd back or a reply lands in INBOX,
        # processing it would generate another reply and loop. Skip outright.
        if from_addr and from_addr.strip().lower() == (ZOHO_IMAP_USER or "").strip().lower():
            log.info("zoho-poll skipping self-sent message (loop guard): subj=%r", subject)
            return {"skipped": "self_sent"}

        # 1) Body intake — skipped when attachments are present (the attachment
        #    is the timesheet; one logical email = one timesheet = one reply).
        result: dict
        if attachments:
            log.info(
                "zoho-poll: %d attachment(s) present, skipping body intake "
                "(body forwarded as context to /intake/upload)",
                len(attachments),
            )
            result = {"skipped": "has_attachments", "attachment_count": len(attachments)}
        else:
            payload = {
                "body": body or "(empty)",
                "subject": subject,
                "from_addr": from_addr,
                "to_addrs": to_addrs,
                "cc_addrs": cc_addrs,
                "uploaded_by": from_addr or "zoho-poller",
                "message_id": message_id,
            }
            headers = {}
            if message_id:
                headers["Idempotency-Key"] = f"zoho:{message_id}"
            r = httpx.post(
                f"{self.api_base}/intake/email",
                json=payload,
                headers=headers,
                timeout=120.0,
            )
            r.raise_for_status()
            result = r.json()
            log.info(
                "zoho-poll → /intake/email  from=%s subj=%r → ts=%s routing=%s mode=%s",
                from_addr,
                subject,
                result.get("timesheet_id", "")[:8],
                result.get("routing"),
                result.get("intake_mode"),
            )

        # 2) for each attachment, push it through /intake/upload as a separate
        #    DocAsset. We pass from_addr/message_id/subject so the eventual
        #    invoice email or hold reply can thread back to the original sender
        #    (the attachment DocAsset is the timesheet's parent doc). The body
        #    is forwarded as `email_body` so the extractor can pull period /
        #    client_hint from it when the OCR didn't.
        att_results: list[dict] = []
        body_for_meta = (body or "").strip()
        for i, (name, mime, payload_bytes) in enumerate(attachments):
            files = {"file": (name, payload_bytes, mime)}
            data: dict[str, str] = {
                "uploaded_by": from_addr or "zoho-poller",
            }
            if from_addr:
                data["from_addr"] = from_addr
            if message_id:
                data["message_id"] = message_id
            if subject:
                data["subject"] = subject
            if body_for_meta:
                # Cap at 4 KB to keep DocAsset.meta JSON small.
                data["email_body"] = body_for_meta[:4000]
            ahdr = {}
            if message_id:
                ahdr["Idempotency-Key"] = f"zoho:{message_id}:att:{i}"
            try:
                ar = httpx.post(
                    f"{self.api_base}/intake/upload",
                    files=files,
                    data=data,
                    headers=ahdr,
                    timeout=180.0,
                )
                ar.raise_for_status()
                att_results.append({"filename": name, "result": ar.json()})
                log.info(
                    "zoho-poll → /intake/upload attachment %r → %s",
                    name,
                    ar.json().get("routing"),
                )
            except httpx.HTTPError as e:
                log.warning("zoho-poll: attachment %r failed: %s", name, e)
                att_results.append({"filename": name, "error": str(e)[:200]})

        result["attachments"] = att_results
        result["message_id"] = message_id
        return result

    def poll_once(self) -> int:
        """One pass over UNSEEN on a SINGLE IMAP connection.

        Previously this reconnected (TLS+LOGIN+SELECT) once to fetch and AGAIN per
        message to mark-seen. Now search + fetch + mark-seen all reuse one login,
        cutting the per-message round trips. Returns the count processed."""
        if not self.configured():
            log.warning("zoho poller not configured - set ZOHO_IMAP_USER and ZOHO_IMAP_PASSWORD")
            return 0
        n = 0
        c = self._connect()
        try:
            typ, data = c.uid("search", None, "UNSEEN")
            if typ != "OK":
                log.warning("imap search returned %s", typ)
                return 0
            uids = data[0].split()
            if uids:  # quiet when idle — no more "0 UNSEEN" log spam every cycle
                log.info("zoho: %d UNSEEN message(s) in %s", len(uids), self.folder)
            for uid in uids:
                typ, rfc = c.uid("fetch", uid, "(RFC822)")
                if typ != "OK" or not rfc or not rfc[0]:
                    continue
                raw = rfc[0][1] if isinstance(rfc[0], tuple) else None
                if not raw:
                    continue
                msg = email_pkg.message_from_bytes(raw)
                try:
                    self.process_message(msg)
                    c.uid("store", uid, "+FLAGS", "(\\Seen)")  # same connection
                    n += 1
                except Exception as e:  # noqa: BLE001
                    log.error("zoho: failed to process UID %s: %s", uid, e)
                    # leave UNSEEN so we retry next round
        finally:
            try:
                c.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                c.logout()
            except Exception:  # noqa: BLE001
                pass
        return n

    def _idle_wait(self, idle_timeout_s: float = 600.0) -> bool:
        """Block on IMAP IDLE until Zoho signals new mail (near-instant) or
        `idle_timeout_s` elapses, whichever first.

        This is the latency fix: instead of waiting up to one poll interval, the
        server pushes us the moment a message lands and we process it immediately.

        Returns True if IDLE was used (we genuinely waited), False if IDLE is
        unusable on this connection so the caller falls back to interval polling.
        Never raises — any problem degrades to the polling path (≡ old behaviour).
        Refresh window is kept well under Zoho's ~29-min IDLE cap."""
        import socket

        try:
            c = self._connect()
        except Exception:  # noqa: BLE001
            return False
        try:
            if "IDLE" not in (getattr(c, "capabilities", ()) or ()):
                return False
            tag = c._new_tag()  # bytes
            c.send(tag + b" IDLE\r\n")
            if not c.readline().startswith(b"+"):  # server must enter idle
                return False
            c.sock.settimeout(idle_timeout_s)
            try:
                while True:
                    line = c.readline()
                    if not line:
                        break  # connection closed → re-poll/re-connect
                    up = line.upper()
                    if b"EXISTS" in up or b"RECENT" in up:
                        break  # new mail → stop idling so the caller polls now
            except (socket.timeout, TimeoutError, OSError):
                pass  # idle window elapsed → loop re-polls then re-idles
            try:
                c.send(b"DONE\r\n")
                c.readline()
            except Exception:  # noqa: BLE001
                pass
            return True
        except Exception as e:  # noqa: BLE001
            log.debug("zoho IDLE aborted (%s) — falling back to polling", e)
            return False
        finally:
            try:
                c.logout()
            except Exception:  # noqa: BLE001
                pass

    def _acquire_singleton(self):
        """Win the right to be the ONE active poller across all API worker
        processes. We run uvicorn with multiple workers, each of which would
        otherwise start its own poller thread and hammer the same mailbox.

        Postgres: take a session-level advisory lock on a dedicated connection;
        the lock is held for the life of that connection and auto-releases if the
        owning worker dies, so a standby worker can take over. Non-Postgres (dev
        SQLite, single process): no lock needed.

        Returns a truthy handle when this process is the active poller, else None."""
        if not str(engine.url).startswith("postgresql"):
            return "no-lock-needed"
        try:
            conn = engine.connect()
            got = conn.execute(
                text("SELECT pg_try_advisory_lock(:k)"), {"k": _SINGLETON_LOCK_KEY}
            ).scalar()
            conn.commit()  # close the txn; the session-level lock persists on conn
            if got:
                return conn  # keep the connection open to hold the lock
            conn.close()
            return None
        except Exception as e:  # noqa: BLE001 — never let lock issues stop mail entirely
            log.warning("singleton lock unavailable (%s) — proceeding without it", e)
            return "no-lock-needed"

    def run_forever(self, interval_s: int = ZOHO_POLL_INTERVAL_SEC) -> None:
        # Idle (don't exit) when unconfigured so the container never crash-loops on a
        # restart policy; creds can be added and the service restarted to enable it.
        if not self.configured():
            log.warning(
                "zoho poller idle: ZOHO_IMAP_USER / ZOHO_IMAP_PASSWORD not set — "
                "sleeping (set creds in .env and restart to enable email intake)"
            )
            while not self.configured():
                time.sleep(max(interval_s, 30))

        # Singleton election: only ONE worker process polls the mailbox. Standby
        # workers wait and retry, so if the active one dies another takes over.
        lock = self._acquire_singleton()
        while lock is None:
            log.info("zoho poller standby — another worker holds the mailbox lock; retry in 30s")
            time.sleep(30)
            lock = self._acquire_singleton()

        log.info(
            "zoho poller starting: %s @ %s:%d (IMAP IDLE push, %ds poll fallback)",
            self.user,
            self.host,
            self.port,
            interval_s,
        )
        use_idle = True
        while True:
            try:
                n = self.poll_once()
                if n:
                    log.info("zoho: processed %d message(s) this round", n)
            except (imaplib.IMAP4.error, OSError) as e:
                log.warning("zoho transient error: %s - backing off", e)
                time.sleep(interval_s)
                continue
            except Exception as e:  # noqa: BLE001
                log.exception("zoho poller unexpected error: %s", e)
                time.sleep(interval_s)
                continue
            # Wait for the next message. Prefer an IMAP IDLE push (near-instant
            # pickup); if IDLE isn't usable on this server/connection, degrade to
            # fixed-interval polling — never worse than the original behaviour.
            if use_idle:
                if not self._idle_wait():
                    use_idle = False
                    log.info("zoho: IMAP IDLE unavailable — using %ds interval polling", interval_s)
                    time.sleep(interval_s)
            else:
                time.sleep(interval_s)


# Convenience module-level entry points
_DEFAULT = ZohoPoller()
poll_once = _DEFAULT.poll_once
run_forever = _DEFAULT.run_forever


# ── Health probe for /status ────────────────────────────────────────────────
# The dashboard dot must reflect *real* mailbox reachability, not just whether
# env vars are set. We do a genuine IMAP login but cache the verdict so /status
# (polled every 15s by every open tab) never hammers Zoho or blocks on the wire.
_HEALTH_CACHE: dict = {"value": None, "at": 0.0}


def imap_health(ttl_s: float = 60.0) -> str:
    """Return cached mailbox health: 'ok' | 'auth_failed' | 'unreachable' | 'missing_creds'.

    'ok' means we actually logged in to Zoho IMAP within the last `ttl_s` seconds.
    """
    if not (ZOHO_IMAP_USER and ZOHO_IMAP_PASSWORD):
        return "missing_creds"
    now = time.time()
    cached = _HEALTH_CACHE.get("value")
    if cached is not None and (now - _HEALTH_CACHE.get("at", 0.0)) < ttl_s:
        return cached
    verdict = "ok"
    try:
        c = imaplib.IMAP4_SSL(ZOHO_IMAP_HOST, ZOHO_IMAP_PORT, timeout=5)
        try:
            c.login(ZOHO_IMAP_USER, ZOHO_IMAP_PASSWORD)
            try:
                c.logout()
            except Exception:  # noqa: BLE001
                pass
        except imaplib.IMAP4.error:
            verdict = "auth_failed"
    except (OSError, Exception):  # noqa: BLE001 — connect/timeout/TLS → treat as unreachable
        verdict = "unreachable"
    _HEALTH_CACHE.update(value=verdict, at=now)
    return verdict


def main() -> None:
    import argparse

    p = argparse.ArgumentParser(description="TIA Zoho IMAP poller")
    p.add_argument("--loop", action="store_true", help="run forever")
    p.add_argument("--interval", type=int, default=ZOHO_POLL_INTERVAL_SEC)
    p.add_argument("--api", default="http://127.0.0.1:8000")
    args = p.parse_args()
    z = ZohoPoller(api_base=args.api)
    if args.loop:
        # --loop is the deploy mode: run_forever idles safely when unconfigured.
        z.run_forever(interval_s=args.interval)
    else:
        if not z.configured():
            log.error("ZOHO_IMAP_USER and ZOHO_IMAP_PASSWORD must be set (in .env or env).")
            raise SystemExit(2)
        n = z.poll_once()
        log.info("done - %d message(s) processed", n)


if __name__ == "__main__":
    main()

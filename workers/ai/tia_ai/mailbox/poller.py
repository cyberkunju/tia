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

from ..config import (
    ZOHO_IMAP_FOLDER,
    ZOHO_IMAP_HOST,
    ZOHO_IMAP_PASSWORD,
    ZOHO_IMAP_PORT,
    ZOHO_IMAP_USER,
    ZOHO_POLL_INTERVAL_SEC,
)

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
        """Adapt a parsed email Message into our `/intake/email` shape and POST it.

        Attachments go through `/intake/upload` separately (one DocAsset each)
        - the body itself goes through `/intake/email`.
        """
        from_addr_list = _addrs_from_header(msg.get("From"))
        to_addrs = _addrs_from_header(msg.get("To"))
        cc_addrs = _addrs_from_header(msg.get("Cc"))
        subject = _decode(msg.get("Subject", "(no subject)"))
        message_id = (msg.get("Message-ID") or "").strip().strip("<>") or None

        body, attachments = _walk_body(msg)

        # 1) ingest the body via /intake/email
        payload = {
            "body": body or "(empty)",
            "subject": subject,
            "from_addr": from_addr_list[0] if from_addr_list else None,
            "to_addrs": to_addrs,
            "cc_addrs": cc_addrs,
            "uploaded_by": from_addr_list[0] if from_addr_list else "zoho-poller",
            "message_id": message_id,
        }
        headers = {}
        if message_id:
            headers["Idempotency-Key"] = f"zoho:{message_id}"
        r = httpx.post(
            f"{self.api_base}/intake/email", json=payload, headers=headers, timeout=120.0
        )
        r.raise_for_status()
        result = r.json()
        log.info(
            "zoho-poll → /intake/email  from=%s subj=%r → ts=%s routing=%s mode=%s",
            payload["from_addr"],
            subject,
            result.get("timesheet_id", "")[:8],
            result.get("routing"),
            result.get("intake_mode"),
        )

        # 2) for each attachment, push it through /intake/upload as a separate
        #    DocAsset. We pass from_addr/message_id/subject so the eventual
        #    invoice email or hold reply can thread back to the original sender
        #    (the attachment DocAsset is the timesheet's parent doc).
        att_results: list[dict] = []
        for i, (name, mime, payload_bytes) in enumerate(attachments):
            files = {"file": (name, payload_bytes, mime)}
            data = {
                "uploaded_by": payload["from_addr"] or "zoho-poller",
            }
            if payload["from_addr"]:
                data["from_addr"] = payload["from_addr"]
            if message_id:
                data["message_id"] = message_id
            if subject:
                data["subject"] = subject
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
                    "zoho-poll → /intake/upload attachment %r → %s", name, ar.json().get("routing")
                )
            except httpx.HTTPError as e:
                log.warning("zoho-poll: attachment %r failed: %s", name, e)
                att_results.append({"filename": name, "error": str(e)[:200]})

        result["attachments"] = att_results
        result["message_id"] = message_id
        return result

    def poll_once(self) -> int:
        """One pass. Returns the count of messages processed."""
        if not self.configured():
            log.warning("zoho poller not configured - set ZOHO_IMAP_USER and ZOHO_IMAP_PASSWORD")
            return 0
        n = 0
        for uid, msg in self.fetch_unseen():
            try:
                self.process_message(msg)
                self.mark_seen(uid)
                n += 1
            except Exception as e:  # noqa: BLE001
                log.error("zoho: failed to process UID %s: %s", uid, e)
                # leave UNSEEN so we retry next round
        return n

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
        log.info(
            "zoho poller starting: %s @ %s:%d, every %ds",
            self.user,
            self.host,
            self.port,
            interval_s,
        )
        while True:
            try:
                n = self.poll_once()
                if n:
                    log.info("zoho: processed %d message(s) this round", n)
            except (imaplib.IMAP4.error, OSError) as e:
                log.warning("zoho transient error: %s - backing off", e)
            except Exception as e:  # noqa: BLE001
                log.exception("zoho poller unexpected error: %s", e)
            time.sleep(interval_s)


# Convenience module-level entry points
_DEFAULT = ZohoPoller()
poll_once = _DEFAULT.poll_once
run_forever = _DEFAULT.run_forever


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

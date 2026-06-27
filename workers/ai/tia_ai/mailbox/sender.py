"""Zoho SMTP sender — close the loop on cc_silent replies.

When the cc_silent flow drafts a reply, we write it to `staging/outbox/`.
If ZOHO_SMTP_USE_SSL + credentials are set, we ALSO send it through Zoho's
SMTP so the reply lands in the original sender's inbox.

Production hook is the same module — swap in any other transport
(SendGrid, SES, Mailgun) and the rest of TIA doesn't notice.
"""

from __future__ import annotations

import logging
import smtplib
from pathlib import Path

from ..config import (
    ZOHO_IMAP_PASSWORD,
    ZOHO_IMAP_USER,
    ZOHO_SMTP_HOST,
    ZOHO_SMTP_PORT,
    ZOHO_SMTP_USE_SSL,
)

log = logging.getLogger("tia.mailbox.sender")


def smtp_configured() -> bool:
    return bool(ZOHO_IMAP_USER and ZOHO_IMAP_PASSWORD)


def send_reply_via_zoho(eml_path: Path) -> dict:
    """Send a drafted `.eml` through Zoho SMTP. Returns a result dict.

    Reads From/To/Cc headers from the file itself. Auth uses the same Zoho
    account as the IMAP poller (single mailbox in/out).

    With SMTP creds missing, returns `{"sent": False, "reason": ...}` —
    the draft still lives on disk and the demo still works.
    """
    if not smtp_configured():
        return {"sent": False, "reason": "ZOHO SMTP not configured"}

    raw = eml_path.read_bytes()
    # parse the saved headers to know who to deliver to
    import email as _email

    msg = _email.message_from_bytes(raw)
    to_addr = msg.get("To") or ""
    cc_addr = msg.get("Cc") or ""
    recipients = [
        a.strip()
        for a in (to_addr + "," + cc_addr).split(",")
        if a.strip() and a.strip() != "unknown"
    ]
    if not recipients:
        return {"sent": False, "reason": "no recipients on draft"}

    sender = ZOHO_IMAP_USER  # Zoho enforces From = authenticated user
    # Override From: header so it shows our Zoho account (Zoho rejects spoofed senders)
    if msg.get("From") and msg["From"] != sender:
        del msg["From"]
        msg["From"] = sender
        raw = msg.as_bytes()

    try:
        if ZOHO_SMTP_USE_SSL:
            with smtplib.SMTP_SSL(ZOHO_SMTP_HOST, ZOHO_SMTP_PORT, timeout=30) as s:
                s.login(ZOHO_IMAP_USER, ZOHO_IMAP_PASSWORD)
                s.sendmail(sender, recipients, raw)
        else:
            with smtplib.SMTP(ZOHO_SMTP_HOST, ZOHO_SMTP_PORT, timeout=30) as s:
                s.ehlo()
                s.starttls()
                s.ehlo()
                s.login(ZOHO_IMAP_USER, ZOHO_IMAP_PASSWORD)
                s.sendmail(sender, recipients, raw)
        log.info("zoho-smtp: sent %s to %s", eml_path.name, recipients)
        return {"sent": True, "to": recipients, "from": sender}
    except smtplib.SMTPException as e:
        log.warning("zoho-smtp: send failed: %s", e)
        return {"sent": False, "reason": f"smtp error: {e}"}

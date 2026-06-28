"""Zoho SMTP sender — close the email loop.

Two public surfaces:

  send_reply_via_zoho(eml_path)
      Legacy: send a pre-drafted .eml file (used by the cc_silent path that
      writes the draft to disk first). Still in place so the dashboard's
      "outbox" view keeps working.

  send_email_reply(to_addr, subject, body, attachments=[(name, mime, bytes)], ...)
      Stdlib EmailMessage builder + In-Reply-To threading. Used by the
      universal hold-ack and the invoice-PDF send.

  send_invoice_email(session, invoice, ...)
      High-level: look up timesheet → doc.meta.from_addr + message_id, attach
      the rendered PDF, fire send_email_reply, log an audit event. Idempotent.

  send_hold_reply(session, ts, doc, ...)
      High-level: "we got your timesheet, holding for review because X."
      Same threading + audit pattern.

Zoho enforces From = authenticated user, so the display name is the only
brand surface — we always send as `"TIA — Touchless Invoice Agent" <user>`.
"""

from __future__ import annotations

import logging
import mimetypes
import smtplib
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from pathlib import Path
from typing import Iterable

from sqlalchemy.orm import Session

from ..config import (
    ZOHO_IMAP_PASSWORD,
    ZOHO_IMAP_USER,
    ZOHO_SMTP_HOST,
    ZOHO_SMTP_PORT,
    ZOHO_SMTP_USE_SSL,
)

log = logging.getLogger("tia.mailbox.sender")

TIA_DISPLAY_NAME = "TIA — Touchless Invoice Agent"


def smtp_configured() -> bool:
    return bool(ZOHO_IMAP_USER and ZOHO_IMAP_PASSWORD)


# ---------------------------------------------------------------------------
# Low-level: pure SMTP send with threading + attachments.
# ---------------------------------------------------------------------------


def send_email_reply(
    to_addr: str,
    subject: str,
    body_text: str,
    attachments: Iterable[tuple[str, str, bytes]] = (),
    in_reply_to: str | None = None,
    references: str | None = None,
    cc_addrs: list[str] | None = None,
) -> dict:
    """Send a plain-text email via Zoho SMTP, optionally threaded.

    `attachments` is an iterable of (filename, mime_type, bytes).
    `in_reply_to` should be the bare Message-ID (no angle brackets) of the
    message we're replying to — we wrap it correctly per RFC 5322.

    Returns `{"sent": bool, "to": str, "message_id": str|None, "reason": str?}`.
    """
    if not smtp_configured():
        return {"sent": False, "reason": "ZOHO SMTP not configured"}
    if not to_addr or to_addr.strip().lower() in ("", "unknown"):
        return {"sent": False, "reason": "no recipient"}

    sender = ZOHO_IMAP_USER  # Zoho rejects any other From
    msg = EmailMessage()
    msg["From"] = formataddr((TIA_DISPLAY_NAME, sender))
    msg["To"] = to_addr
    if cc_addrs:
        msg["Cc"] = ", ".join(a for a in cc_addrs if a and a.lower() != "unknown")
    msg["Subject"] = subject
    msg["Message-ID"] = make_msgid(
        domain=sender.split("@", 1)[-1] if "@" in sender else "tia.local"
    )
    if in_reply_to:
        irt = in_reply_to.strip().strip("<>")
        msg["In-Reply-To"] = f"<{irt}>"
        # references chain: prepend prior references then in_reply_to
        ref_chain = (references or "").strip()
        if ref_chain:
            msg["References"] = f"{ref_chain} <{irt}>"
        else:
            msg["References"] = f"<{irt}>"

    msg.set_content(body_text)

    for filename, mime_type, payload_bytes in attachments:
        if not payload_bytes:
            continue
        maintype, _, subtype = (mime_type or "").partition("/")
        if not maintype or not subtype:
            guessed = mimetypes.guess_type(filename)[0] or "application/octet-stream"
            maintype, _, subtype = guessed.partition("/")
            if not subtype:
                maintype, subtype = "application", "octet-stream"
        msg.add_attachment(
            payload_bytes,
            maintype=maintype,
            subtype=subtype,
            filename=filename,
        )

    recipients = [to_addr] + [a for a in (cc_addrs or []) if a and a.lower() != "unknown"]
    try:
        if ZOHO_SMTP_USE_SSL:
            with smtplib.SMTP_SSL(ZOHO_SMTP_HOST, ZOHO_SMTP_PORT, timeout=30) as s:
                s.login(ZOHO_IMAP_USER, ZOHO_IMAP_PASSWORD)
                s.send_message(msg, from_addr=sender, to_addrs=recipients)
        else:
            with smtplib.SMTP(ZOHO_SMTP_HOST, ZOHO_SMTP_PORT, timeout=30) as s:
                s.ehlo()
                s.starttls()
                s.ehlo()
                s.login(ZOHO_IMAP_USER, ZOHO_IMAP_PASSWORD)
                s.send_message(msg, from_addr=sender, to_addrs=recipients)
        log.info("zoho-smtp: sent %r → %s", subject, recipients)
        return {
            "sent": True,
            "to": to_addr,
            "from": sender,
            "message_id": msg["Message-ID"],
        }
    except (smtplib.SMTPException, OSError) as e:
        log.warning("zoho-smtp: send failed: %s", e)
        return {"sent": False, "reason": f"smtp error: {e}"}


# ---------------------------------------------------------------------------
# Legacy: keep the .eml-file path the cc_silent draft uses.
# ---------------------------------------------------------------------------


def send_reply_via_zoho(eml_path: Path) -> dict:
    """Send a drafted `.eml` through Zoho SMTP. Returns a result dict.

    Reads From/To/Cc/Subject + body from the file and reposts via
    `send_email_reply` so all sends go through the same threaded code path.
    """
    if not smtp_configured():
        return {"sent": False, "reason": "ZOHO SMTP not configured"}
    raw = eml_path.read_bytes()
    import email as _email

    parsed = _email.message_from_bytes(raw)
    to_addr = (parsed.get("To") or "").strip()
    cc_raw = parsed.get("Cc") or ""
    cc_list = [a.strip() for a in cc_raw.split(",") if a.strip() and a.strip().lower() != "unknown"]
    subject = parsed.get("Subject") or "(no subject)"
    # body is whatever follows the headers — the cc_silent drafter writes plain text
    body: str | bytes = ""
    if parsed.is_multipart():
        for part in parsed.walk():
            if part.get_content_type() == "text/plain":
                raw_body = part.get_payload(decode=True) or b""
                if isinstance(raw_body, bytes):
                    body = raw_body.decode("utf-8", errors="replace")
                else:
                    body = str(raw_body)
                break
    else:
        single = parsed.get_payload(decode=False)
        body = single if isinstance(single, str) else str(single or "")
    if isinstance(body, bytes):
        body = body.decode("utf-8", errors="replace")
    return send_email_reply(
        to_addr=to_addr,
        subject=subject,
        body_text=body or "(empty)",
        cc_addrs=cc_list or None,
    )


# ---------------------------------------------------------------------------
# High-level: invoice email + hold reply, both audit-logged + idempotent.
# ---------------------------------------------------------------------------


def _email_meta_for_timesheet(
    session: Session, ts
) -> tuple[str | None, str | None, str | None, list[str]]:
    """Walk timesheet → doc to find the original email's reply target.

    Returns (from_addr, message_id, subject, cc_addrs). Any field may be None.
    For attachments processed as separate DocAssets, the parent_doc_id chain
    is walked one hop so an extracted PDF still finds its sender."""
    from ..models import DocAsset

    if not ts or not ts.doc_id:
        return None, None, None, []
    doc = session.get(DocAsset, ts.doc_id)
    while doc is not None and not (doc.meta or {}).get("from_addr") and doc.parent_doc_id:
        doc = session.get(DocAsset, doc.parent_doc_id)
    if doc is None:
        return None, None, None, []
    m = doc.meta or {}
    return (
        m.get("from_addr"),
        m.get("message_id"),
        m.get("subject"),
        m.get("cc_addrs") or [],
    )


def send_invoice_email(
    session: Session,
    invoice,
    idempotency_key: str | None = None,
    by_user: str = "system",
) -> dict:
    """Email the rendered invoice PDF back to whoever sent the timesheet.

    No-op (with reason) if:
      - source channel wasn't email
      - no from_addr captured
      - SMTP not configured
      - same idempotency_key already sent
      - PDF missing on disk

    Logs event `email.invoice_sent` (or `email.invoice_send_skipped`) on the
    invoice. Returns the result dict from `send_email_reply` plus a `skipped`
    reason when applicable.
    """
    from ..models import DocAsset, Event, Timesheet
    from ..orchestrator import log_event

    key = idempotency_key or f"invoice-reply:{invoice.id}"

    # idempotency: a prior send (any path) wins
    prior = session.query(Event).filter_by(idempotency_key=key).first()
    if prior:
        return {"sent": False, "skipped": "already_sent", "idempotency_key": key}

    ts = session.get(Timesheet, invoice.timesheet_id) if invoice.timesheet_id else None
    from_addr, message_id, orig_subject, _cc = _email_meta_for_timesheet(session, ts)

    doc = session.get(DocAsset, ts.doc_id) if (ts and ts.doc_id) else None
    if not doc or doc.source_channel != "email":
        log_event(
            session,
            by_user,
            "invoice",
            invoice.id,
            "email.invoice_send_skipped",
            {"reason": "source channel not email"},
        )
        return {"sent": False, "skipped": "not_email_source"}

    if not from_addr:
        log_event(
            session,
            by_user,
            "invoice",
            invoice.id,
            "email.invoice_send_skipped",
            {"reason": "no from_addr on doc"},
        )
        return {"sent": False, "skipped": "no_from_addr"}

    if not smtp_configured():
        log_event(
            session,
            by_user,
            "invoice",
            invoice.id,
            "email.invoice_send_skipped",
            {"reason": "smtp not configured"},
        )
        return {"sent": False, "skipped": "smtp_unconfigured"}

    if not invoice.pdf_path or not Path(invoice.pdf_path).exists():
        log_event(
            session,
            by_user,
            "invoice",
            invoice.id,
            "email.invoice_send_skipped",
            {"reason": "pdf missing", "pdf_path": invoice.pdf_path},
        )
        return {"sent": False, "skipped": "no_pdf"}

    pdf_bytes = Path(invoice.pdf_path).read_bytes()
    seq = invoice.invoice_sequence_no or invoice.id[:8]
    attach_name = f"invoice_{seq}.pdf"
    subject_bits = [f"[TIA] Invoice {seq}"]
    if invoice.client_code:
        subject_bits.append(invoice.client_code)
    if invoice.period:
        subject_bits.append(invoice.period)
    subject = " · ".join(subject_bits)
    total_str = f"{invoice.total_incl_vat or invoice.amount or 0:.2f} {invoice.currency or 'AED'}"
    body = (
        f"Hi,\n\n"
        f"Your timesheet has been processed and the invoice is attached.\n\n"
        f"Invoice: {seq}\n"
        f"Client:  {invoice.client_code or '-'}\n"
        f"Period:  {invoice.period or '-'}\n"
        f"Amount:  {total_str} (incl. VAT)\n\n"
        f"Reply to this thread with any questions.\n\n"
        f"— TIA · Touchless Invoice Agent\n"
        f"   TASC Outsourcing FZ-LLC\n"
    )

    res = send_email_reply(
        to_addr=from_addr,
        subject=subject,
        body_text=body,
        attachments=[(attach_name, "application/pdf", pdf_bytes)],
        in_reply_to=message_id,
    )

    if res.get("sent"):
        log_event(
            session,
            by_user,
            "invoice",
            invoice.id,
            "email.invoice_sent",
            {
                "to": from_addr,
                "subject": subject,
                "in_reply_to": message_id,
                "pdf_bytes": len(pdf_bytes),
                "outbound_message_id": res.get("message_id"),
            },
            idempotency_key=key,
        )
    else:
        log_event(
            session,
            by_user,
            "invoice",
            invoice.id,
            "email.invoice_send_failed",
            {"to": from_addr, "reason": res.get("reason")},
        )
    return res


def send_hold_reply(
    session: Session,
    ts,
    doc,
    payload_subject: str | None,
    payload_from_addr: str | None,
    payload_message_id: str | None,
    cc_addrs: list[str] | None = None,
    extra_reason: str | None = None,
    by_user: str = "system",
) -> dict:
    """Tell the sender we got the timesheet and it's held for review.

    Idempotent on `hold-reply:{message_id}` (or doc.id when message_id absent).
    Logs `email.hold_reply_sent` / `email.hold_reply_send_failed` on the doc.
    Never raises — returns a result dict in all paths so callers can swallow.
    """
    from ..models import Event, Invoice
    from ..orchestrator import log_event
    from ..validate.rules_v2 import friendly_message

    if not payload_from_addr:
        return {"sent": False, "skipped": "no_from_addr"}
    if not smtp_configured():
        return {"sent": False, "skipped": "smtp_unconfigured"}

    key = f"hold-reply:{payload_message_id or doc.id}"
    prior = session.query(Event).filter_by(idempotency_key=key).first()
    if prior:
        return {"sent": False, "skipped": "already_sent", "idempotency_key": key}

    # friendly reason — same heuristic as cc_silent draft (E1)
    friendly: str | None = None
    inv = (
        (
            session.query(Invoice)
            .filter_by(timesheet_id=ts.id)
            .order_by(Invoice.created_at.desc())
            .first()
        )
        if ts
        else None
    )
    candidates = []
    if inv and inv.rule_results:
        candidates = inv.rule_results
    elif ts and ts.validations:
        candidates = ts.validations
    for r in candidates or []:
        if not r.get("passed") and r.get("severity") != "warning":
            friendly = friendly_message(r.get("rule_id"))
            if friendly:
                break

    reason_line = (
        extra_reason
        or friendly
        or (ts.hitl_reason if ts else None)
        or "flagged for review by our FinOps team"
    )

    # subject + body
    base = payload_subject or "your timesheet submission"
    if not base.lower().startswith("re:"):
        base = f"Re: {base}"
    subj_bits = [base]
    if ts and ts.client_code:
        subj_bits.append(ts.client_code)
    if ts and ts.period:
        subj_bits.append(ts.period)
    if ts:
        subj_bits.append(f"ref {ts.id[:8]}")
    subject = " · ".join(subj_bits)

    body = (
        f"Hi,\n\n"
        f"Thanks for the timesheet — we've received it and paused it for human review.\n\n"
        f"What happened: {reason_line}\n\n"
        f"Reference: timesheet {ts.id[:8] if ts else doc.id[:8]} · "
        f"routing {ts.routing if ts else 'escalate'}"
        f"{f' · confidence {ts.confidence_calibrated}' if ts and ts.confidence_calibrated is not None else ''}\n"
        f"Period: {ts.period if (ts and ts.period) else '(not provided)'}\n\n"
        f"A FinOps reviewer at TASC Outsourcing will follow up shortly. No action required from\n"
        f"you in the meantime — if you'd like to clarify anything, just reply to this thread.\n\n"
        f"— TIA · Touchless Invoice Agent\n"
        f"   TASC Outsourcing FZ-LLC\n"
    )

    res = send_email_reply(
        to_addr=payload_from_addr,
        subject=subject,
        body_text=body,
        in_reply_to=payload_message_id,
        cc_addrs=cc_addrs or None,
    )

    if res.get("sent"):
        log_event(
            session,
            by_user,
            "doc",
            doc.id,
            "email.hold_reply_sent",
            {
                "to": payload_from_addr,
                "subject": subject,
                "in_reply_to": payload_message_id,
                "reason": reason_line,
                "outbound_message_id": res.get("message_id"),
                "timesheet_id": ts.id if ts else None,
            },
            idempotency_key=key,
        )
    else:
        log_event(
            session,
            by_user,
            "doc",
            doc.id,
            "email.hold_reply_send_failed",
            {"to": payload_from_addr, "reason": res.get("reason")},
        )
    return res


def deliver_email_outcome(session: Session, ts, by_user: str = "zoho-poller") -> dict | None:
    """Send the right email reply for an email-sourced timesheet — the email
    analogue of `notify_whatsapp_result`.

      - routing == "auto"            → email the finished invoice PDF
      - routing == "hitl"/"escalate" → email a "received, holding for review" notice

    No-op (returns None) for non-email docs or when no reply address was captured.

    Why this exists: previously only the email-BODY path replied, and only on HITL.
    An emailed *attachment* (the common case) went through /intake/upload which sent
    nothing, and an auto-approved email never got its invoice. So emailed timesheets
    silently got no reply. This closes that gap for every email routing outcome."""
    from ..models import DocAsset, Invoice

    if ts is None or not ts.doc_id:
        return None
    doc = session.get(DocAsset, ts.doc_id)
    if doc is None or doc.source_channel != "email":
        return None
    from_addr, message_id, subject, cc = _email_meta_for_timesheet(session, ts)
    if not from_addr:
        return None

    if ts.routing == "auto":
        inv = (
            session.query(Invoice)
            .filter_by(timesheet_id=ts.id)
            .order_by(Invoice.created_at.desc())
            .first()
        )
        if inv is None:
            return None
        return send_invoice_email(session, inv, by_user=by_user)

    # hitl / escalate / anything not auto-approved → received-and-holding notice
    return send_hold_reply(
        session,
        ts,
        doc,
        payload_subject=subject,
        payload_from_addr=from_addr,
        payload_message_id=message_id,
        cc_addrs=cc or None,
        by_user=by_user,
    )

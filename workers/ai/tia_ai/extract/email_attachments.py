"""E3 — Extract attachments from a `.eml` (RFC 5322) message.

Real email clients ship attachments as MIME multipart parts. TIA's intake path
needs to:
  1. Detect the parent doc as `message/rfc822` (or `.eml`)
  2. Walk the message, pull each non-text part, save it as bytes + filename
  3. Hand each off to `ingest_file()` as a child doc with `parent_doc_id`
     linking back to the email
"""

from __future__ import annotations

import email
from email.message import Message
from pathlib import Path
from typing import Iterator


def _is_attachment(part: Message) -> bool:
    """Heuristic: not a text body, has a filename or a non-inline disposition."""
    cd = (part.get("Content-Disposition") or "").lower()
    if "attachment" in cd:
        return True
    if part.get_filename():
        return True
    ctype = (part.get_content_type() or "").lower()
    # don't treat the human body as an attachment
    if part.is_multipart() or ctype.startswith("text/"):
        return False
    return True


def extract_attachments(eml_bytes: bytes) -> Iterator[tuple[str, str, bytes]]:
    """Yield `(filename, mime, payload_bytes)` for each attachment in the message.

    Falls back to a synthetic filename `attachment-{i}.bin` when the part has
    no filename. Skips text/plain and text/html bodies (the message body).
    """
    msg = email.message_from_bytes(eml_bytes)
    i = 0
    for part in msg.walk():
        if part.is_multipart():
            continue
        if not _is_attachment(part):
            continue
        i += 1
        payload = part.get_payload(decode=True) or b""
        if not payload:
            continue
        name = part.get_filename() or f"attachment-{i}.bin"
        mime = part.get_content_type() or "application/octet-stream"
        yield name, mime, payload


def _demo() -> None:
    """Offline self-check — build a synthetic email with two attachments."""
    from email.mime.application import MIMEApplication
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText

    m = MIMEMultipart()
    m["From"] = "manager@steel.test"
    m["To"] = "tia@cyberkunju.com"
    m["Subject"] = "June timesheet"
    m.attach(MIMEText("See attached.\nEMP10001 Carlos Smith - 22 days"))
    a = MIMEApplication(
        b"PK\x03\x04 fake xlsx bytes",
        _subtype="vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    a.add_header("Content-Disposition", "attachment", filename="timesheet_june.xlsx")
    m.attach(a)
    b = MIMEApplication(b"%PDF-1.4 fake pdf bytes", _subtype="pdf")
    b.add_header("Content-Disposition", "attachment", filename="signed.pdf")
    m.attach(b)
    raw = m.as_bytes()
    files = list(extract_attachments(raw))
    assert len(files) == 2, files
    names = [f[0] for f in files]
    assert "timesheet_june.xlsx" in names and "signed.pdf" in names, names
    print("email attachment extractor: PASS — found", names)


if __name__ == "__main__":
    _demo()

"""Demo-only: inject a synthetic email into the watched Zoho INBOX via IMAP APPEND.

Zoho IMAP lets you APPEND a message into a folder. The poller treats appended
messages exactly like real inbound mail (they show up as UNSEEN), so this is
the cleanest way to drive a stage demo without needing a second mailbox or
a phone in hand.

    uv run python -m tia_ai.mailbox.demo_inject --case 07 --from-addr alice@demo.test
    uv run python -m tia_ai.mailbox.demo_inject --case 08 --from-addr bob@demo.test
    uv run python -m tia_ai.mailbox.demo_inject --case 11 --from-addr ceo@demo.test --subject 'June timesheet, please invoice'

`--case NN` looks up data/synthetic/case_NN_*.{xlsx,pdf,png,eml,txt} and:
  - if it's an .eml, APPENDs it verbatim (rewriting From if asked)
  - otherwise wraps a small body + the file as an attachment

After injection, the running poller will pick it up within ZOHO_POLL_INTERVAL_SEC
seconds (10s in demo .env), run it through the pipeline, and either auto-email
the invoice PDF back OR send a hold reply — both threaded via In-Reply-To so
they land in the same Zoho thread.
"""

from __future__ import annotations

import argparse
import email as email_pkg
import imaplib
import mimetypes
import sys
import time
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid
from pathlib import Path

from ..config import (
    ZOHO_IMAP_FOLDER,
    ZOHO_IMAP_HOST,
    ZOHO_IMAP_PASSWORD,
    ZOHO_IMAP_PORT,
    ZOHO_IMAP_USER,
)

REPO_ROOT = Path(__file__).resolve().parents[4]
SYNTH_DIR = REPO_ROOT / "data" / "synthetic"


def find_case(case_id: str) -> Path:
    """Resolve `--case 07` to data/synthetic/case_07_*.* (any extension)."""
    key = case_id.zfill(2)
    matches = sorted(SYNTH_DIR.glob(f"case_{key}_*"))
    if not matches:
        raise SystemExit(f"no test case file found for id={case_id} in {SYNTH_DIR}")
    return matches[0]


def build_message(case_path: Path, from_addr: str, to_addr: str, subject: str | None) -> bytes:
    """Return raw RFC822 bytes ready to APPEND."""
    if case_path.suffix.lower() == ".eml":
        # parse the existing .eml, rewrite From + To + Date so it looks fresh
        msg = email_pkg.message_from_bytes(case_path.read_bytes())
        del msg["From"]
        msg["From"] = from_addr
        if msg.get("To"):
            del msg["To"]
        msg["To"] = to_addr
        if subject:
            del msg["Subject"]
            msg["Subject"] = subject
        del msg["Date"]
        msg["Date"] = formatdate(localtime=True)
        if not msg.get("Message-ID"):
            msg["Message-ID"] = make_msgid(domain="demo.test")
        return msg.as_bytes()

    # build a fresh multipart with the case file as attachment
    em = EmailMessage()
    em["From"] = from_addr
    em["To"] = to_addr
    em["Subject"] = subject or f"Timesheet — {case_path.stem}"
    em["Date"] = formatdate(localtime=True)
    em["Message-ID"] = make_msgid(domain="demo.test")
    em.set_content(
        f"Hi TIA team,\n\n"
        f"Please find this period's timesheet attached.\n"
        f"Let me know once the invoice is ready.\n\n"
        f"— Demo Client\n"
        f"(case file: {case_path.name})\n"
    )
    payload = case_path.read_bytes()
    mime_type = mimetypes.guess_type(case_path.name)[0] or "application/octet-stream"
    maintype, _, subtype = mime_type.partition("/")
    if not subtype:
        maintype, subtype = "application", "octet-stream"
    em.add_attachment(
        payload,
        maintype=maintype,
        subtype=subtype,
        filename=case_path.name,
    )
    return em.as_bytes()


def append(raw: bytes, folder: str = ZOHO_IMAP_FOLDER) -> None:
    """APPEND a message into the given Zoho IMAP folder as UNSEEN."""
    if not (ZOHO_IMAP_USER and ZOHO_IMAP_PASSWORD):
        raise SystemExit("ZOHO_IMAP_USER / ZOHO_IMAP_PASSWORD not set in .env")
    c = imaplib.IMAP4_SSL(ZOHO_IMAP_HOST, ZOHO_IMAP_PORT)
    c.login(ZOHO_IMAP_USER, ZOHO_IMAP_PASSWORD)
    try:
        # blank flags = UNSEEN, which is what the poller filters on
        typ, data = c.append(folder, "", imaplib.Time2Internaldate(time.time()), raw)
        if typ != "OK":
            raise SystemExit(f"IMAP APPEND failed: {typ} {data!r}")
        print(f"[demo-inject] APPEND OK → {folder} ({len(raw)} bytes)")
    finally:
        try:
            c.logout()
        except Exception:  # noqa: BLE001
            pass


def main() -> int:
    p = argparse.ArgumentParser(description="Inject a demo email into the Zoho INBOX (no SMTP).")
    p.add_argument("--case", required=True, help="case id, e.g. 07 or 08")
    p.add_argument("--from-addr", default="alice@demo.test", help="display sender")
    p.add_argument("--to-addr", default=None, help="defaults to the configured Zoho mailbox")
    p.add_argument("--subject", default=None, help="override subject")
    p.add_argument("--folder", default=ZOHO_IMAP_FOLDER, help="IMAP folder (default INBOX)")
    args = p.parse_args()

    to_addr = args.to_addr or ZOHO_IMAP_USER or "tia@example.test"
    from_display = formataddr(("Demo Client", args.from_addr))
    case_path = find_case(args.case)
    print(f"[demo-inject] case={case_path.name}  from={from_display}  to={to_addr}")
    raw = build_message(case_path, from_display, to_addr, args.subject)
    append(raw, folder=args.folder)
    print("[demo-inject] done. Poller will pick this up within ZOHO_POLL_INTERVAL_SEC seconds.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

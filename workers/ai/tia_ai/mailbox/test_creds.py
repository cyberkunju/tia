"""Quick Zoho-credentials tester — verifies IMAP + SMTP login work.

    uv run python -m tia_ai.mailbox.test_creds

Reads creds from .env (via the standard config loader). Doesn't fetch any
messages, doesn't send anything — just logs in and out so you know the
password is good before starting the poller.
"""

from __future__ import annotations

import imaplib
import smtplib
import sys

from ..config import (
    ZOHO_IMAP_HOST,
    ZOHO_IMAP_PASSWORD,
    ZOHO_IMAP_PORT,
    ZOHO_IMAP_USER,
    ZOHO_SMTP_HOST,
    ZOHO_SMTP_PORT,
    ZOHO_SMTP_USE_SSL,
)


def check_imap() -> bool:
    print(f"[imap] connect {ZOHO_IMAP_HOST}:{ZOHO_IMAP_PORT} as {ZOHO_IMAP_USER}", flush=True)
    try:
        c = imaplib.IMAP4_SSL(ZOHO_IMAP_HOST, ZOHO_IMAP_PORT)
        c.login(ZOHO_IMAP_USER, ZOHO_IMAP_PASSWORD)
        typ, data = c.list()
        n_folders = len(data) if data else 0
        c.logout()
        print(f"[imap] OK · {n_folders} folders visible")
        return True
    except imaplib.IMAP4.error as e:
        print(f"[imap] LOGIN FAILED: {e}")
        return False
    except OSError as e:
        print(f"[imap] CONNECT FAILED: {e}")
        return False


def check_smtp() -> bool:
    print(
        f"[smtp] connect {ZOHO_SMTP_HOST}:{ZOHO_SMTP_PORT} (ssl={ZOHO_SMTP_USE_SSL}) as {ZOHO_IMAP_USER}",
        flush=True,
    )
    try:
        if ZOHO_SMTP_USE_SSL:
            with smtplib.SMTP_SSL(ZOHO_SMTP_HOST, ZOHO_SMTP_PORT, timeout=15) as s:
                s.login(ZOHO_IMAP_USER, ZOHO_IMAP_PASSWORD)
        else:
            with smtplib.SMTP(ZOHO_SMTP_HOST, ZOHO_SMTP_PORT, timeout=15) as s:
                s.ehlo()
                s.starttls()
                s.ehlo()
                s.login(ZOHO_IMAP_USER, ZOHO_IMAP_PASSWORD)
        print("[smtp] OK")
        return True
    except smtplib.SMTPException as e:
        print(f"[smtp] LOGIN FAILED: {e}")
        return False
    except OSError as e:
        print(f"[smtp] CONNECT FAILED: {e}")
        return False


def main() -> int:
    if not (ZOHO_IMAP_USER and ZOHO_IMAP_PASSWORD):
        print(
            "ZOHO_IMAP_USER and ZOHO_IMAP_PASSWORD must be set in .env.\n"
            "See README → 'Zoho Mail integration' for App Password steps.",
            file=sys.stderr,
        )
        return 2
    ok_imap = check_imap()
    ok_smtp = check_smtp()
    if ok_imap and ok_smtp:
        print("\n✓ All Zoho creds verified. Run `make mail` to start polling.")
        return 0
    print("\n✗ Fix the failures above before running `make mail`.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

"""TIA Mailbox - Zoho IMAP/SMTP integration for `tia@cyberkunju.com`.

What this gives us on stage:
  - Real email sent to `tia@cyberkunju.com` (Zoho Mail) gets pulled into TIA
    every ZOHO_POLL_INTERVAL_SEC seconds and processed end-to-end through the
    same `/intake/email` pipeline as the simulated channels.
  - When TIA drafts a reply (cc_silent + exception), it can actually SMTP-send
    it through Zoho so the reply lands in the sender's inbox.

Why IMAP rather than a webhook:
  - Zoho's inbound webhook needs a public HTTPS URL with valid cert.
  - IMAP polling works from any laptop, no inbound firewall hole, no DNS,
    no SSL cert. Production-shape just substitutes a webhook adapter.
"""

from .poller import ZohoPoller, poll_once, run_forever  # noqa: F401
from .sender import send_reply_via_zoho  # noqa: F401

__all__ = ["ZohoPoller", "poll_once", "run_forever", "send_reply_via_zoho"]

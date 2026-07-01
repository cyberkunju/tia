"""Covers the best-effort error path of _email_reply_for_upload (api/app.py).

Regression guard for a fixed latent bug: the handler's `except` clause used a
`log` name that was only bound inside the lifespan, so any failure in
deliver_email_outcome raised NameError instead of degrading gracefully. This
forces deliver_email_outcome to raise and asserts the handler swallows it and
returns a structured failure (never crashing the intake).
"""

from __future__ import annotations

import tia_ai.mailbox.sender as sender_mod
from tia_ai.api.app import _email_reply_for_upload


def test_email_reply_handler_swallows_delivery_errors(monkeypatch):
    def boom(_s, _ts):
        raise RuntimeError("smtp down")

    monkeypatch.setattr(sender_mod, "deliver_email_outcome", boom)
    # session/timesheet are irrelevant — the patched delivery raises first.
    out = _email_reply_for_upload(None, object())
    assert out == {"sent": False, "reason": "smtp down"}

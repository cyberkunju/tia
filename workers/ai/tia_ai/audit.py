"""Tamper-evident audit chain helpers.

Every `Event` carries `prev_hash` and `hash`. `verify_audit_chain()` re-walks
the chain and reports any break - the canonical use is a nightly compliance
check, an admin endpoint, or as part of the audit ZIP bundle.

Algorithm (matches `orchestrator._event_hash`):

    hash = sha256(canonical_json({
      prev, actor, kind, entity_id, action, payload, before, after
    }))

If `events.hash` doesn't match the recomputed value, that's tampering
(or a bug in our own writer - same defence either way).
"""

from __future__ import annotations

import hashlib
import json
from typing import Iterator

from sqlalchemy.orm import Session

from .models import Event


def _recompute_hash(e: Event) -> str:
    body = json.dumps(
        {
            "prev": e.prev_hash or "",
            "actor": e.actor or "",
            "kind": e.entity_kind,
            "entity_id": e.entity_id,
            "action": e.action,
            "payload": e.payload or {},
            "before": e.before or None,
            "after": e.after or None,
        },
        sort_keys=True,
        default=str,
    ).encode()
    return hashlib.sha256(body).hexdigest()


def walk_chain(session: Session) -> Iterator[Event]:
    yield from session.query(Event).order_by(Event.at.asc()).all()


def verify_audit_chain(session: Session) -> dict:
    """Return a verification report.

    Result shape:
      {
        "ok": bool,
        "total": int,
        "errors": [{"event_id", "kind": "hash_mismatch" | "prev_mismatch", ...}],
        "head": str | None,  # latest hash (the value to publish/sign)
      }
    """
    errors: list[dict] = []
    last_hash: str | None = None
    count = 0
    for e in walk_chain(session):
        count += 1
        # prev_hash matches the actual last_hash we've seen?
        if e.prev_hash != last_hash:
            errors.append(
                {
                    "event_id": e.id,
                    "at": e.at.isoformat() if e.at else None,
                    "kind": "prev_mismatch",
                    "expected_prev": last_hash,
                    "actual_prev": e.prev_hash,
                }
            )
        # the stored hash matches a recompute over the canonical body?
        recomputed = _recompute_hash(e)
        if e.hash != recomputed:
            errors.append(
                {
                    "event_id": e.id,
                    "at": e.at.isoformat() if e.at else None,
                    "kind": "hash_mismatch",
                    "stored": e.hash,
                    "recomputed": recomputed,
                }
            )
            # don't propagate corrupted hash forward; use recomputed
            last_hash = recomputed
        else:
            last_hash = e.hash
    return {
        "ok": not errors,
        "total": count,
        "errors": errors,
        "head": last_hash,
    }

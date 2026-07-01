"""Retention / PII-footprint tooling.

IMPORTANT: invoices are UAE FTA tax records (5-year retention) and are NEVER
purged here, nor are timesheets, events (the tamper-evident audit chain), or any
DB row. This tool only trims OLD RAW SOURCE FILES (uploaded scans / emails) from
the staging directory to reduce standing PII, keeping the DocAsset row (with its
audit trail) but clearing its staging_path.

Dry-run by default. Wire `purge_raw_files(dry_run=False)` into a scheduled job
only after you've set a retention window that matches your legal policy.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy.orm import Session

from .models import DocAsset

DEFAULT_RAW_RETENTION_DAYS = 365


@dataclass
class RetentionItem:
    doc_id: str
    staging_path: str
    size_bytes: int


def _as_aware(d: dt.datetime) -> dt.datetime:
    """Coerce a possibly-naive DB timestamp to aware UTC so comparisons never raise."""
    return d if d.tzinfo is not None else d.replace(tzinfo=dt.timezone.utc)


def scan(
    session: Session,
    now: dt.datetime | None = None,
    raw_retention_days: int = DEFAULT_RAW_RETENTION_DAYS,
) -> list[RetentionItem]:
    """Raw source files older than the window whose file still exists on disk.
    Comparison is done in Python (tz-coerced) to stay correct on SQLite + Postgres."""
    current = now or dt.datetime.now(dt.timezone.utc)
    cutoff = _as_aware(current) - dt.timedelta(days=raw_retention_days)
    items: list[RetentionItem] = []
    # ponytail: full scan of docs-with-a-staging-file is fine at this scale; add a
    # date index + WHERE clause if doc_assets ever grows into the millions.
    for doc in session.query(DocAsset).filter(DocAsset.staging_path.isnot(None)).all():
        if _as_aware(doc.uploaded_at) < cutoff:
            path = Path(doc.staging_path)
            if path.exists():
                items.append(RetentionItem(doc.id, str(path), path.stat().st_size))
    return items


def purge_raw_files(
    session: Session,
    now: dt.datetime | None = None,
    raw_retention_days: int = DEFAULT_RAW_RETENTION_DAYS,
    dry_run: bool = True,
) -> dict:
    """Report (dry_run) or delete old raw staging files. Deletes only the file and
    clears DocAsset.staging_path; never touches invoices, timesheets, or events."""
    items = scan(session, now, raw_retention_days)
    total_bytes = sum(i.size_bytes for i in items)
    if dry_run:
        return {"eligible": len(items), "purged": 0, "bytes": total_bytes, "dry_run": True}
    for it in items:
        Path(it.staging_path).unlink(missing_ok=True)
        doc = session.get(DocAsset, it.doc_id)
        doc.staging_path = None
    session.commit()
    return {"eligible": len(items), "purged": len(items), "bytes": total_bytes, "dry_run": False}


def main(argv: list[str] | None = None) -> None:
    """CLI: `python -m tia_ai.retention` reports (dry-run); add `--purge` to delete."""
    import json
    import sys

    from .db import get_session

    args = argv if argv is not None else sys.argv[1:]
    do_purge = "--purge" in args
    with get_session() as s:
        report = purge_raw_files(s, dry_run=not do_purge)
    print(json.dumps(report))


if __name__ == "__main__":  # pragma: no cover
    main()

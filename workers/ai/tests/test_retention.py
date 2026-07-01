"""Retention tooling (tia_ai/retention.py).

Verifies the safe, file-only trim: old raw staging files are eligible, recent or
missing ones are not, dry-run never deletes, and a real purge removes the file +
clears staging_path while leaving the DocAsset row intact. Uses an injected
`now` and tmp files so it never depends on wall-clock or real staging.
"""

from __future__ import annotations

import datetime as dt
import uuid

import pytest

from tia_ai import retention
from tia_ai.db import SessionLocal
from tia_ai.models import DocAsset

_NOW = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)


@pytest.fixture()
def s():
    sess = SessionLocal()
    try:
        yield sess
    finally:
        sess.rollback()
        sess.close()


def _doc(s, staging_path, uploaded_at):
    d = DocAsset(
        id=str(uuid.uuid4()),
        content_hash=uuid.uuid4().hex,
        source_channel="upload",
        uploaded_by="ret-test",
        staging_path=str(staging_path) if staging_path else None,
        uploaded_at=uploaded_at,
        filename="x.xlsx",
    )
    s.add(d)
    s.flush()
    return d


def test_as_aware_coerces_naive_and_preserves_aware():
    naive = dt.datetime(2020, 1, 1)
    assert retention._as_aware(naive).tzinfo is dt.timezone.utc
    aware = dt.datetime(2020, 1, 1, tzinfo=dt.timezone.utc)
    assert retention._as_aware(aware) is aware


def test_scan_flags_old_existing_file(s, tmp_path):
    f = tmp_path / "old.xlsx"
    f.write_bytes(b"data")
    d = _doc(s, f, dt.datetime(2000, 1, 1))  # naive + ancient
    items = retention.scan(s, now=_NOW, raw_retention_days=365)
    match = [i for i in items if i.doc_id == d.id]
    assert match and match[0].size_bytes == 4


def test_scan_ignores_recent_file(s, tmp_path):
    f = tmp_path / "new.xlsx"
    f.write_bytes(b"data")
    d = _doc(s, f, dt.datetime(2025, 12, 31, tzinfo=dt.timezone.utc))
    assert d.id not in [i.doc_id for i in retention.scan(s, now=_NOW, raw_retention_days=365)]


def test_scan_ignores_old_row_with_missing_file(s, tmp_path):
    d = _doc(s, tmp_path / "never_written.xlsx", dt.datetime(2000, 1, 1))
    assert d.id not in [i.doc_id for i in retention.scan(s, now=_NOW)]


def test_purge_dry_run_reports_and_keeps_file(s, tmp_path):
    f = tmp_path / "old.xlsx"
    f.write_bytes(b"data")
    d = _doc(s, f, dt.datetime(2000, 1, 1))
    rep = retention.purge_raw_files(s, now=_NOW, raw_retention_days=365, dry_run=True)
    assert rep["dry_run"] is True and rep["eligible"] >= 1 and rep["purged"] == 0
    assert f.exists()
    assert d.staging_path == str(f)


def test_purge_deletes_file_and_clears_path(s, tmp_path):
    f = tmp_path / "old.xlsx"
    f.write_bytes(b"data")
    d = _doc(s, f, dt.datetime(2000, 1, 1))
    rep = retention.purge_raw_files(s, now=_NOW, raw_retention_days=365, dry_run=False)
    assert rep["dry_run"] is False and rep["purged"] >= 1
    assert not f.exists()
    s.refresh(d)
    assert d.staging_path is None


def test_main_dry_run_and_purge_flag(monkeypatch, capsys):
    seen = {}

    def _fake_purge(session, dry_run=True):
        seen["dry_run"] = dry_run
        return {"eligible": 0, "purged": 0, "bytes": 0, "dry_run": dry_run}

    monkeypatch.setattr(retention, "purge_raw_files", _fake_purge)

    retention.main([])  # default: dry-run report
    assert seen["dry_run"] is True
    assert '"dry_run": true' in capsys.readouterr().out

    retention.main(["--purge"])  # explicit purge
    assert seen["dry_run"] is False

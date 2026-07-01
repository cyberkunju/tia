"""Final small-gap coverage: qa citation dedup + audit-log exception, extract
dispatch wrappers + image-mime, vision helper edges + fallback exceptions."""

from __future__ import annotations

import uuid

import pytest
from PIL import Image

from tia_ai import extract as EX
from tia_ai.db import SessionLocal
from tia_ai.extract import vision as V
from tia_ai.qa import agent as A
from tia_ai.schema import TimesheetExtraction, TimesheetRow


@pytest.fixture()
def s():
    sess = SessionLocal()
    try:
        yield sess
    finally:
        sess.rollback()
        sess.close()


# ── qa/agent small gaps ─────────────────────────────────────────────────────


def test_extract_citations_dedupes():
    cites = A._extract_citations("see [invoice:abc123] and again [invoice:abc123] and [rule:R4]")
    assert cites.count({"kind": "invoice", "id": "abc123"}) == 1
    assert {"kind": "rule", "id": "R4"} in cites


def test_log_agent_invocation_swallows_errors(monkeypatch, s):
    import tia_ai.orchestrator as orch

    monkeypatch.setattr(orch, "log_event", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("chain down")))
    # must not raise despite log_event blowing up
    A._log_agent_invocation(s, "recover_leakage", "some-id", {"x": 1}, "ok")


def test_reject_timesheet_whatsapp_notify_swallowed(monkeypatch, s):
    from tia_ai.models import DocAsset, Timesheet
    import datetime as dt

    doc = DocAsset(id=str(uuid.uuid4()), content_hash=uuid.uuid4().hex, source_channel="whatsapp", uploaded_by="971500000001")
    s.add(doc)
    s.flush()
    ts = Timesheet(id=str(uuid.uuid4()), doc_id=doc.id, client_code="CL001", period="June 2026",
                   status="awaiting_review", routing="hitl", created_at=dt.datetime.now(dt.timezone.utc))
    s.add(ts)
    s.flush()
    import tia_ai.whatsapp as wa
    monkeypatch.setattr(wa, "push_text_to_sender", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("bridge")))
    res = A.tool_reject_timesheet(s, ts.id, reason="illegible")
    assert res["ok"] is True and res["whatsapp_notified"] is False


# ── extract dispatch wrappers + image mime ──────────────────────────────────


def test_image_mime_variants(tmp_path):
    from pathlib import Path

    webp = tmp_path / "a.bin"
    webp.write_bytes(b"RIFF\x00\x00\x00\x00WEBPxxxx")
    assert EX._image_mime(Path(webp)) == "image/webp"
    other = tmp_path / "b.bin"
    other.write_bytes(b"\x00\x01\x02\x03")
    assert EX._image_mime(Path(other)) == "image/png"
    png = tmp_path / "c.bin"
    png.write_bytes(b"\x89PNG\r\n\x1a\n")
    assert EX._image_mime(Path(png)) == "image/png"


def test_extract_wrappers_direct(monkeypatch, tmp_path):
    import tia_ai.ocr as ocr
    from pathlib import Path

    # _email_file
    ef = tmp_path / "e.txt"
    ef.write_text("Client Code: CL001\nEMP10001 22 days", encoding="utf-8")
    assert isinstance(EX._email_file(Path(ef)), TimesheetExtraction)
    # _image (mock OCR)
    img = tmp_path / "i.png"
    Image.new("RGB", (20, 20), "white").save(img)
    monkeypatch.setattr(ocr, "glm_markdown", lambda *a, **k: "")
    monkeypatch.setattr(ocr, "glm_kie", lambda *a, **k: TimesheetExtraction())
    monkeypatch.setattr(ocr, "glm_layout", lambda *a, **k: [])
    assert isinstance(EX._image(Path(img)), TimesheetExtraction)
    # _docx via a real docx
    import docx

    d = docx.Document()
    d.add_paragraph("EMP10001 22 days")
    dp = tmp_path / "d.docx"
    d.save(dp)
    assert isinstance(EX._docx(Path(dp)), TimesheetExtraction)
    # _doc on a non-OLE file → empty extraction (no crash)
    doc_p = tmp_path / "legacy.doc"
    doc_p.write_bytes(b"not ole")
    assert isinstance(EX._doc(Path(doc_p)), TimesheetExtraction)
    # _pdf on a real image-only PDF
    pdf_p = tmp_path / "p.pdf"
    Image.new("RGB", (20, 20), "white").save(pdf_p, "PDF")
    assert isinstance(EX._pdf(Path(pdf_p)), TimesheetExtraction)


# ── vision helper edges + fallback exceptions ────────────────────────────────


def test_vision_num_emdash_and_field():
    assert V._num("—") is None
    assert V._num("42") == 42.0


def test_extract_image_llm_exception_swallowed(monkeypatch, tmp_path):
    import tia_ai.ocr as ocr

    monkeypatch.setattr(ocr, "glm_markdown", lambda *a, **k: "markdown with no parseable rows")
    monkeypatch.setattr(ocr, "glm_kie", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("kie")))
    monkeypatch.setattr(ocr, "glm_layout", lambda *a, **k: [])
    monkeypatch.setattr(V, "_llm_extract_markdown", lambda md: (_ for _ in ()).throw(RuntimeError("llm")))
    p = tmp_path / "i.png"
    Image.new("RGB", (20, 20), "white").save(p)
    ex = V.extract_image(p)
    assert ex.rows == []


def test_extract_image_provenance_exception_swallowed(monkeypatch, tmp_path):
    import tia_ai.ocr as ocr

    md = "Employee Name: Carlos Smith\nClient Code: CL001\nMonth: June 2026\nTotal Working Days: 22\nTotal Hours: 176"
    monkeypatch.setattr(ocr, "glm_markdown", lambda *a, **k: md)
    monkeypatch.setattr(ocr, "glm_kie", lambda *a, **k: TimesheetExtraction())
    monkeypatch.setattr(ocr, "glm_layout", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("layout")))
    p = tmp_path / "i.png"
    Image.new("RGB", (40, 30), "white").save(p)
    ex = V.extract_image(p)
    assert ex.rows and ex.rows[0].employee_name == "Carlos Smith"

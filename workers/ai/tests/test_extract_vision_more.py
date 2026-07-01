"""extract/vision.py fallback + helper coverage (OCR mocked, no network).

Covers _image_dims, _num/_field/_find_total, the markdown-table OT sum, the
monthly-timesheet parser, _attach_provenance edge cases, _llm_extract_markdown
(configured + degraded), and extract_image's KIE / LLM / provenance fallbacks.
"""

from __future__ import annotations

import pytest
from PIL import Image

from tia_ai.extract import vision
from tia_ai.schema import TimesheetExtraction, TimesheetRow

from .fake_llm import FakeClient


def _png_bytes(w=40, h=30) -> bytes:
    import io

    buf = io.BytesIO()
    Image.new("RGB", (w, h), "white").save(buf, format="PNG")
    return buf.getvalue()


# ── pure helpers ────────────────────────────────────────────────────────────


def test_image_dims_valid_and_invalid():
    assert vision._image_dims(_png_bytes(40, 30)) == (40, 30)
    assert vision._image_dims(b"not an image") == (0, 0)


def test_num_variants():
    assert vision._num(None) is None
    assert vision._num("-") is None
    assert vision._num("1,234.5") == 1234.5
    assert vision._num("abc") is None


def test_field_match_and_miss():
    text = "Employee Name: Carlos Smith\nMonth: June 2026"
    assert vision._field(text, "Employee Name") == "Carlos Smith"
    assert vision._field(text, "Nonexistent") is None


def test_find_total_standalone_and_table():
    assert vision._find_total("Total Working Days: 22", "Total Working Days") == 22
    assert vision._find_total("| Total Hours: | 176 |", "Total Hours") == 176
    assert vision._find_total("nothing here", "Total Hours") is None


def test_sum_overtime_from_markdown_table():
    table = (
        "| Date | Day | Hours | Overtime | Rem | Date | Day | Hours | Overtime | Rem |\n"
        "| :--- | :-- | :---- | :------- | :-- | :--- | :-- | :---- | :------- | :-- |\n"
        "| 01 | Mon | 8 | 2 | - | 16 | Tue | 8 | 3 | - |\n"
    )
    assert vision._sum_overtime_from_markdown_table(table) == 5.0
    assert vision._sum_overtime_from_markdown_table("no table rows") is None


def test_extract_monthly_markdown_parses_and_empties():
    good = (
        "Employee Name: Carlos Smith\nClient Code: CL001\nMonth: June 2026\n"
        "Total Working Days: 22\nTotal Hours: 176\nApproved By: Rohit\n"
    )
    ex = vision._extract_monthly_timesheet_markdown(good)
    assert ex.rows[0].employee_name == "Carlos Smith" and ex.client_code == "CL001"
    # missing employee name → empty extraction
    assert vision._extract_monthly_timesheet_markdown("Month: June 2026").rows == []


# ── _attach_provenance ──────────────────────────────────────────────────────


def test_attach_provenance_smallest_block_wins():
    ex = TimesheetExtraction(
        rows=[TimesheetRow(employee_name="Carlos Smith"), TimesheetRow(employee_name="Aisha Al Zaabi")]
    )
    blocks = [
        {"bbox": [10, 10, 200, 50], "category": "Text", "text": "Header June 2026"},
        {"bbox": [10, 60, 300, 90], "category": "Text", "text": "Carlos Smith 22 days"},
        {"bbox": [10, 100, 320, 130], "category": "Text", "text": "Aisha Al Zaabi 21 days"},
        {"bbox": [0, 0, 1000, 1000], "category": "Picture", "text": "Aisha Al Zaabi margin"},
    ]
    vision._attach_provenance(ex, blocks, img_w=1000, img_h=1400)
    assert len(ex.row_provenance) == 2
    aisha = next(p for p in ex.row_provenance if p["row_idx"] == 1)
    assert aisha["bbox"] == [10, 100, 320, 130]


def test_attach_provenance_noops_on_empty():
    ex = TimesheetExtraction(rows=[])
    vision._attach_provenance(ex, [], 0, 0)
    assert ex.row_provenance == []


def test_attach_provenance_rejects_all_same_block():
    ex = TimesheetExtraction(
        rows=[TimesheetRow(employee_name="Carlos"), TimesheetRow(employee_name="Carlos")]
    )
    blocks = [{"bbox": [10, 60, 300, 90], "category": "Text", "text": "Carlos here"}]
    vision._attach_provenance(ex, blocks, img_w=1000, img_h=1400)
    # both rows would collapse onto the one block → rejected
    assert ex.row_provenance == []


def test_attach_provenance_no_useful_blocks():
    ex = TimesheetExtraction(rows=[TimesheetRow(employee_name="Carlos")])
    # block too large (>40% of page) → filtered out → no useful blocks
    blocks = [{"bbox": [0, 0, 999, 1399], "category": "Text", "text": "Carlos"}]
    vision._attach_provenance(ex, blocks, img_w=1000, img_h=1400)
    assert ex.row_provenance == []


# ── _llm_extract_markdown ─────────────────────────────────────────────────────


def test_llm_extract_markdown_degraded():
    # chat not configured (conftest blanks creds) → empty extraction
    assert vision._llm_extract_markdown("some markdown").rows == []


def test_llm_extract_markdown_configured(monkeypatch):
    from tia_ai.qa import agent as A

    payload = '{"client_code": "CL001", "period": "June 2026", "rows": [{"employee_name": "Zed", "days_worked": 20}]}'
    monkeypatch.setattr(A, "_chat_configured", lambda: True)
    monkeypatch.setattr(A, "_client_and_model", lambda: (FakeClient([payload]), "m"))
    ex = vision._llm_extract_markdown("Zed worked 20 days")
    assert ex.rows[0].employee_name == "Zed"


def test_llm_extract_markdown_no_json_returns_empty(monkeypatch):
    from tia_ai.qa import agent as A

    monkeypatch.setattr(A, "_chat_configured", lambda: True)
    monkeypatch.setattr(A, "_client_and_model", lambda: (FakeClient(["no json here"]), "m"))
    assert vision._llm_extract_markdown("x").rows == []


# ── extract_image fallbacks ───────────────────────────────────────────────────


def test_extract_image_kie_fallback(monkeypatch, tmp_path):
    import tia_ai.ocr as ocr

    # markdown yields no parseable rows → KIE fallback returns rows
    monkeypatch.setattr(ocr, "glm_markdown", lambda *a, **k: "garbled unparseable text")
    monkeypatch.setattr(
        ocr, "glm_kie", lambda *a, **k: TimesheetExtraction(rows=[TimesheetRow(employee_name="KieGuy")])
    )
    monkeypatch.setattr(ocr, "glm_layout", lambda *a, **k: [])
    p = tmp_path / "i.png"
    p.write_bytes(_png_bytes())
    ex = vision.extract_image(p)
    assert ex.rows[0].employee_name == "KieGuy"


def test_extract_image_llm_fallback(monkeypatch, tmp_path):
    import tia_ai.ocr as ocr

    monkeypatch.setattr(ocr, "glm_markdown", lambda *a, **k: "some markdown with no rows")
    monkeypatch.setattr(ocr, "glm_kie", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("glm down")))
    monkeypatch.setattr(ocr, "glm_layout", lambda *a, **k: [])
    monkeypatch.setattr(
        vision, "_llm_extract_markdown", lambda md: TimesheetExtraction(rows=[TimesheetRow(employee_name="LlmGuy")])
    )
    p = tmp_path / "i.png"
    p.write_bytes(_png_bytes())
    ex = vision.extract_image(p)
    assert ex.rows[0].employee_name == "LlmGuy"


def test_extract_image_attaches_provenance(monkeypatch, tmp_path):
    import tia_ai.ocr as ocr

    md = (
        "Employee Name: Carlos Smith\nClient Code: CL001\nMonth: June 2026\n"
        "Total Working Days: 22\nTotal Hours: 176\n"
    )
    monkeypatch.setattr(ocr, "glm_markdown", lambda *a, **k: md)
    monkeypatch.setattr(ocr, "glm_kie", lambda *a, **k: TimesheetExtraction())
    monkeypatch.setattr(
        ocr,
        "glm_layout",
        lambda *a, **k: [{"bbox": [10, 60, 300, 90], "category": "Text", "text": "Carlos Smith 22"}],
    )
    p = tmp_path / "i.png"
    p.write_bytes(_png_bytes(400, 300))
    ex = vision.extract_image(p)
    assert ex.rows[0].employee_name == "Carlos Smith"
    assert ex.row_provenance and ex.row_provenance[0]["row_idx"] == 0


def test_extract_image_markdown_exception_is_swallowed(monkeypatch, tmp_path):
    import tia_ai.ocr as ocr

    monkeypatch.setattr(ocr, "glm_markdown", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    monkeypatch.setattr(ocr, "glm_kie", lambda *a, **k: TimesheetExtraction())
    monkeypatch.setattr(ocr, "glm_layout", lambda *a, **k: [])
    p = tmp_path / "i.png"
    p.write_bytes(_png_bytes())
    ex = vision.extract_image(p)
    assert ex.rows == []  # all paths failed gracefully

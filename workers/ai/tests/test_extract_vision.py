from __future__ import annotations

from PIL import Image

from tia_ai.extract.vision import extract_image


REAL_HANDWRITTEN_MARKDOWN = """TASC OUTSOURCING

MONTHLY TIMESHEET

Employee Name: Carlos Smith
Client Code: CL001
Month: June 2026

| Date | Day | Hours Worked | Overtime | Remarks | Date | Day | Hours Worked | Overtime | Remarks |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 01/06/2026 | Mon | 8 | 0 | - | 16/06/2026 | Tue | 8 | 0 | - |
| 06/06/2026 | Sat | - | - | Off | 21/06/2026 | Sun | - | - | Off |

Total Working Days: 22

Total Hours: 176

Associate Signature: Carlos Smith
Date: 01/07/2026

Approved By: Rohit Sharma
Date: 02/07/2026
"""


def test_image_extraction_parses_real_monthly_timesheet_markdown(monkeypatch, tmp_path):
    import tia_ai.ocr as ocr

    monkeypatch.setattr(ocr, "glm_markdown", lambda *args, **kwargs: REAL_HANDWRITTEN_MARKDOWN)
    monkeypatch.setattr(ocr, "glm_kie", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError))
    monkeypatch.setattr(ocr, "glm_layout", lambda *args, **kwargs: [])

    # OCR is mocked, so the image content is irrelevant; extract_image only needs
    # a readable file to exist for Path.read_bytes(). Write a tiny valid PNG.
    img_path = tmp_path / "handwritten.png"
    Image.new("RGB", (8, 8), "white").save(img_path)

    ex = extract_image(img_path)

    assert ex.client_code == "CL001"
    assert ex.period == "June 2026"
    assert ex.signed_by == "Rohit Sharma"
    assert len(ex.rows) == 1
    row = ex.rows[0]
    assert row.employee_name == "Carlos Smith"
    assert row.days_worked == 22
    assert row.hours == 176
    assert row.ot_hours == 0

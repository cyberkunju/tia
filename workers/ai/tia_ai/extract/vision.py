"""Image extractor (case 4: handwritten/photographed) — GLM-OCR only.

Strategy:
  1. Markdown pass (robust): page → markdown, parse with our text parser.
     The live test showed GLM-OCR transcribes our timesheet shape cleanly.
  2. KIE fallback: if no rows surfaced, ask for schema-constrained JSON.
"""

from __future__ import annotations

from pathlib import Path

from ..schema import TimesheetExtraction
from . import email as email_ex


def extract_image(path: str | Path, mime: str = "image/png") -> TimesheetExtraction:
    data = Path(path).read_bytes()
    from ..ocr import glm_kie, glm_markdown

    # Primary: markdown then text parser
    try:
        md = glm_markdown(data, mime=mime)
        result = email_ex.extract_email(md)
        if result.rows:
            return result
    except Exception:  # noqa: BLE001
        result = TimesheetExtraction()

    # Fallback: schema-constrained KIE JSON
    try:
        return glm_kie(data, mime=mime)
    except Exception:  # noqa: BLE001
        return result  # may be empty; pipeline will mark it as such

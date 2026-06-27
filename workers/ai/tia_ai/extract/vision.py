"""Image extractor (case 4: handwritten/photographed) — GLM-OCR primary, Tesseract fallback."""

from __future__ import annotations

from pathlib import Path

from ..schema import TimesheetExtraction
from . import email as email_ex


def extract_image(path: str | Path, mime: str = "image/png") -> TimesheetExtraction:
    data = Path(path).read_bytes()
    from ..ocr import glm_kie, tesseract_text

    try:
        return glm_kie(data, mime=mime)
    except Exception:  # noqa: BLE001 — any Modal/network/parse failure -> offline fallback
        pass
    try:
        text = tesseract_text(data)
        ex = email_ex.extract_email(text)
        ex.signed_by = ex.signed_by or None
        return ex
    except Exception:  # noqa: BLE001
        return TimesheetExtraction()

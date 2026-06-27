"""Extraction dispatch. Routes a staged document to the right extractor by mime/shape.

Excel / native-PDF / email run with zero LLM. Only true images/handwriting go to the
vision path (ocr_client). This is the "70% works without an LLM" backbone.

Empty or unparseable inputs return an empty `TimesheetExtraction` - the orchestrator
then routes the document to `escalate` rather than crashing the API.
"""

from __future__ import annotations

from pathlib import Path

from ..schema import TimesheetExtraction
from . import email as email_ex
from . import excel as excel_ex


def extract(
    path: str | Path, mime: str | None = None, channel: str = "upload"
) -> TimesheetExtraction:
    p = Path(path)
    try:
        if p.stat().st_size == 0:
            return TimesheetExtraction()
    except OSError:
        return TimesheetExtraction()

    suffix = p.suffix.lower()
    try:
        if suffix in {".xlsx", ".xlsm", ".xls"} or (mime and "spreadsheet" in mime):
            return excel_ex.extract_excel(p)
        if suffix in {".eml", ".txt"} or (mime and mime.startswith("text")):
            return email_ex.extract_email(p.read_text(encoding="utf-8", errors="ignore"))
        if suffix in {".png", ".jpg", ".jpeg", ".tif", ".tiff"} or (
            mime and mime.startswith("image")
        ):
            from . import vision as vision_ex

            return vision_ex.extract_image(p)
        if suffix == ".pdf" or (mime and mime == "application/pdf"):
            from . import pdf as pdf_ex

            return pdf_ex.extract_pdf(p)
        # last resort: treat as email/plain text
        return email_ex.extract_email(p.read_text(encoding="utf-8", errors="ignore"))
    except Exception:  # noqa: BLE001 - corrupt input → escalate, never crash the API
        return TimesheetExtraction()

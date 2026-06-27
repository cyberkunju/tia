"""Native-PDF extractor — pdfplumber text/tables; scanned PDFs route to GLM-OCR via vision."""

from __future__ import annotations

from pathlib import Path

from ..schema import TimesheetExtraction
from . import email as email_ex


def extract_pdf(path: str | Path) -> TimesheetExtraction:
    import pdfplumber

    text_parts: list[str] = []
    with pdfplumber.open(str(path)) as pdf:
        for page in pdf.pages:
            t = page.extract_text() or ""
            text_parts.append(t)
    text = "\n".join(text_parts).strip()

    if len(text) >= 20:
        # has a real text layer -> parse like an email body / structured text
        return email_ex.extract_email(text)

    # no text layer -> scanned/handwritten; rasterize page 1 and route to vision/GLM-OCR
    try:
        import io

        import pdfplumber as _pp

        from . import vision as vision_ex

        with _pp.open(str(path)) as pdf:
            im = pdf.pages[0].to_image(resolution=200)
            buf = io.BytesIO()
            im.original.save(buf, format="PNG")
        tmp = Path(path).with_suffix(".page1.png")
        tmp.write_bytes(buf.getvalue())
        return vision_ex.extract_image(tmp, mime="image/png")
    except Exception:  # noqa: BLE001
        return TimesheetExtraction()

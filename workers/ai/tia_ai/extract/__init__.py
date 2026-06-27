"""Extraction dispatch — accept any input, route on what the file *is*.

The real file type is detected from content (magic bytes / container), not the
extension or MIME, so a mislabeled upload still parses. Each type has a primary
extractor plus a fallback chain: if the primary finds no rows we try its siblings,
so a stray format never silently dead-ends. Empty/garbage inputs return an empty
TimesheetExtraction and the orchestrator routes them to `escalate` — never a crash.

Supported: xlsx/xlsm, xls, csv/tsv, docx, doc, pdf (native + scanned→OCR),
images (jpg/png/tiff/webp/heic → OCR), and email/plain text.
"""

from __future__ import annotations

from pathlib import Path

from ..schema import TimesheetExtraction
from . import email as email_ex
from . import excel as excel_ex
from .sniff import detect_kind

_IMAGE_MIME = {
    b"\xff\xd8\xff": "image/jpeg",
    b"\x89PNG": "image/png",
    b"GIF8": "image/gif",
    b"II*\x00": "image/tiff",
    b"MM\x00*": "image/tiff",
}


def _image_mime(p: Path) -> str:
    head = p.read_bytes()[:8]
    for magic, m in _IMAGE_MIME.items():
        if head.startswith(magic):
            return m
    if head[:4] == b"RIFF":
        return "image/webp"
    return "image/png"


def _email_file(p: Path) -> TimesheetExtraction:
    return email_ex.extract_email(p.read_text(encoding="utf-8", errors="ignore"))


def _pdf(p: Path) -> TimesheetExtraction:
    from . import pdf as pdf_ex

    return pdf_ex.extract_pdf(p)


def _image(p: Path) -> TimesheetExtraction:
    from . import vision as vision_ex

    return vision_ex.extract_image(p, mime=_image_mime(p))


def _docx(p: Path) -> TimesheetExtraction:
    from . import word as word_ex

    return word_ex.extract_docx(p)


def _doc(p: Path) -> TimesheetExtraction:
    from . import word as word_ex

    return word_ex.extract_doc(p)


# Per-kind extractor chains. The first that yields rows wins; otherwise we keep the
# richest result so client/period hints aren't lost on the way to escalate.
_CHAINS: dict[str, list] = {
    "xlsx": [excel_ex.extract_excel, excel_ex.extract_xls, excel_ex.extract_csv],
    "xls": [excel_ex.extract_xls, excel_ex.extract_excel, excel_ex.extract_csv],
    "csv": [excel_ex.extract_csv, _email_file],
    "docx": [_docx, _email_file],
    "doc": [_doc, _docx],
    "pdf": [_pdf],
    "image": [_image],
    "text": [_email_file, excel_ex.extract_csv],
    # containers we couldn't pin down → try everything reasonable, cheap-to-dear
    "zip": [excel_ex.extract_excel, _docx, excel_ex.extract_csv, _email_file],
    "ole": [excel_ex.extract_xls, _doc, _email_file],
    "unknown": [excel_ex.extract_excel, excel_ex.extract_xls, _docx, excel_ex.extract_csv, _email_file, _pdf],
}


def extract(
    path: str | Path,
    mime: str | None = None,
    channel: str = "upload",
    filename: str | None = None,
) -> TimesheetExtraction:
    p = Path(path)
    try:
        if p.stat().st_size == 0:
            return TimesheetExtraction()
    except OSError:
        return TimesheetExtraction()

    kind = detect_kind(p, mime=mime, filename=filename or p.name)
    chain = _CHAINS.get(kind, _CHAINS["unknown"])

    best = TimesheetExtraction()
    for fn in chain:
        try:
            result = fn(p)
        except Exception:  # noqa: BLE001 — a bad parser must not sink the whole input
            continue
        if result.rows:
            return result
        # keep the result that carries the most context (client/period) for escalate
        if len(result.model_dump(exclude_none=True)) > len(best.model_dump(exclude_none=True)):
            best = result
    return best

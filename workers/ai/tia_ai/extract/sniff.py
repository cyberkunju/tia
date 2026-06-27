"""Content-based file-type detection.

The extension and even the MIME can be wrong (a WhatsApp xlsx once arrived named
`.png`). So we decide the real type from the file's magic bytes / container, and only
use the MIME + extension as a tiebreaker. This is what makes "send anything" robust:
the dispatcher routes on what the file *is*, not what it's called.

Returns one of:
  pdf | image | xlsx | xls | docx | doc | csv | text | unknown
"""

from __future__ import annotations

import zipfile
from pathlib import Path

_OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


def _image_magic(head: bytes) -> bool:
    return (
        head.startswith(b"\xff\xd8\xff")  # jpeg
        or head.startswith(b"\x89PNG\r\n\x1a\n")  # png
        or head.startswith(b"GIF8")  # gif
        or head.startswith(b"BM")  # bmp
        or head.startswith(b"II*\x00")  # tiff (le)
        or head.startswith(b"MM\x00*")  # tiff (be)
        or (head[:4] == b"RIFF" and head[8:12] == b"WEBP")  # webp
        or (len(head) >= 12 and head[4:8] == b"ftyp" and head[8:12] in (b"heic", b"heif", b"mif1", b"heix"))
    )


def _zip_kind(path: Path) -> str:
    """An OOXML file is a zip; distinguish by its internal layout."""
    try:
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
    except Exception:  # noqa: BLE001
        return "zip"
    if any(n.startswith("xl/") for n in names):
        return "xlsx"
    if any(n.startswith("word/") for n in names):
        return "docx"
    if any(n.startswith("ppt/") for n in names):
        return "pptx"
    return "zip"


def _ole_kind(path: Path) -> str:
    """OLE2 compound file — distinguish legacy .xls from .doc by its streams."""
    try:
        import olefile

        with olefile.OleFileIO(str(path)) as ole:
            entries = {e[-1] for e in ole.listdir()}
    except Exception:  # noqa: BLE001
        return "ole"
    if "Workbook" in entries or "Book" in entries:
        return "xls"
    if "WordDocument" in entries:
        return "doc"
    return "ole"


def _looks_csv(text: str) -> bool:
    lines = [ln for ln in text.splitlines() if ln.strip()][:10]
    if len(lines) < 2:
        return False
    for delim in (",", ";", "\t", "|"):
        counts = [ln.count(delim) for ln in lines]
        # at least one delimiter on most lines, and a consistent column count
        if min(counts) >= 1 and len(set(counts)) <= 2:
            return True
    return False


def detect_kind(path: str | Path, mime: str | None = None, filename: str | None = None) -> str:
    p = Path(path)
    try:
        with p.open("rb") as fh:
            head = fh.read(8192)
    except OSError:
        return "unknown"
    if not head:
        return "unknown"

    if head.startswith(b"%PDF"):
        return "pdf"
    if _image_magic(head):
        return "image"
    if head.startswith(b"PK\x03\x04"):
        return _zip_kind(p)
    if head.startswith(_OLE_MAGIC):
        return _ole_kind(p)

    # text-ish: decide csv vs free text
    try:
        text = head.decode("utf-8")
    except UnicodeDecodeError:
        text = head.decode("latin-1", "ignore")
    if _looks_csv(text):
        return "csv"
    # printable-ratio guard: mostly-binary unknowns shouldn't be treated as text
    printable = sum(1 for ch in text if ch.isprintable() or ch in "\r\n\t")
    if text and printable / len(text) > 0.85:
        return "text"

    # last resort: trust the hint
    m = (mime or "").lower()
    suf = (Path(filename).suffix.lower() if filename else p.suffix.lower())
    if "pdf" in m or suf == ".pdf":
        return "pdf"
    if m.startswith("image") or suf in {".png", ".jpg", ".jpeg", ".tiff", ".webp", ".heic", ".gif", ".bmp"}:
        return "image"
    if "spreadsheet" in m or suf in {".xlsx", ".xlsm"}:
        return "xlsx"
    if suf == ".xls" or "ms-excel" in m:
        return "xls"
    if "wordprocessing" in m or suf == ".docx":
        return "docx"
    if suf == ".doc" or "msword" in m:
        return "doc"
    if "csv" in m or suf in {".csv", ".tsv"}:
        return "csv"
    return "unknown"

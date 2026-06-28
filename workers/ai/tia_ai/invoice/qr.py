"""Branded WhatsApp QR for the Tax Invoice.

Encodes a `wa.me` deep link pre-filled with the invoice number, so a scan opens
a WhatsApp chat ready to send. TIA's WhatsApp bridge (`/intake/whatsapp`) +
grounded chat can then read the invoice number from the message and pull the
full record, status, and audit history from the database.

The code is rendered by hand (Pillow) for a distinctive on-brand look:
  - soft rounded data modules in ink (near-black) for scan reliability,
  - the three finder "eyes" stylised in TASC orange,
  - a clean white knockout in the centre carrying the TIA logo.

High error correction (H, ~30% recovery) keeps it scannable despite the centre
logo. The encoded payload is plain ASCII so any reader/bot can parse it.
"""

from __future__ import annotations

import urllib.parse
from pathlib import Path

import qrcode
from qrcode.constants import ERROR_CORRECT_H
from PIL import Image, ImageDraw

# WhatsApp business line (international format, no '+').
WHATSAPP_NUMBER = "919400245958"

_INK = (15, 23, 42)        # ink-900
_BRAND = (217, 83, 30)     # TASC orange-red
_BRAND_DK = (155, 52, 20)  # brand-700, for the eye centre
_WHITE = (255, 255, 255)

# TIA logo geometry (matches TIA_logo.svg viewBox). The wide "A" carries an
# inner counter that we punch out explicitly so it reads cleanly at small size.
_LOGO_VIEWBOX = (1680, 769)
_LOGO_PATHS = (
    ((0, 0), (631, 0), (631, 177), (426, 177), (426, 767), (236, 767), (236, 177), (0, 177)),
    ((676, 0), (862, 0), (862, 557), (739, 767), (675, 767)),
    ((1233, 1), (1287, 90), (1680, 769), (1052, 769), (1153, 592), (1367, 591),
     (1235, 352), (1232, 352), (1162, 481), (1001, 767), (792, 768), (791, 765), (815, 723)),
)
# Inner counter (hole) of the A - punched back to background after fill.
_LOGO_COUNTER = ((1153, 592), (1367, 591), (1235, 352), (1232, 352), (1162, 481))


def whatsapp_url(invoice_no: str) -> str:
    # Plain ASCII, kept short so the QR stays low-version (easy to scan). The
    # invoice number is embedded verbatim so TIA's WhatsApp bridge can extract
    # it and pull the full record from the database.
    msg = f"Need to chat about Invoice {invoice_no}"
    return f"https://wa.me/{WHATSAPP_NUMBER}?text=" + urllib.parse.quote(msg, safe="")


def _draw_logo(draw: ImageDraw.ImageDraw, cx: float, cy: float, target_w: float, color) -> None:
    vw, vh = _LOGO_VIEWBOX
    s = target_w / vw
    w, h = vw * s, vh * s
    ox, oy = cx - w / 2, cy - h / 2
    for path in _LOGO_PATHS:
        draw.polygon([(ox + x * s, oy + y * s) for x, y in path], fill=color)
    # Guarantee the A's counter reads as a hole regardless of fill rule.
    draw.polygon([(ox + x * s, oy + y * s) for x, y in _LOGO_COUNTER], fill=_WHITE)


def _rounded(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def make_whatsapp_qr(invoice_no: str, out_path: str | Path, box: int = 26, quiet: int = 4) -> str:
    """Render the branded QR PNG for `invoice_no` to `out_path`. Returns the path.

    Design (validated to decode down to ~200px with OpenCV's detector):
      - soft rounded data modules in ink (the finder eyes stay near-square,
        which QR detectors depend on);
      - finder eyes filled in TASC orange with a brand-700 core;
      - white centre knockout carrying the TIA logo;
      - high error correction so the centre logo doesn't compromise scanning.
    """
    url = whatsapp_url(invoice_no)
    qr = qrcode.QRCode(error_correction=ERROR_CORRECT_H, box_size=1, border=0)
    qr.add_data(url)
    qr.make(fit=True)
    mat = qr.get_matrix()
    n = len(mat)

    px = (n + quiet * 2) * box
    img = Image.new("RGBA", (px, px), (255, 255, 255, 0))
    d = ImageDraw.Draw(img)

    # White rounded backing card (own quiet zone + crisp scan background).
    _rounded(d, [0, 0, px - 1, px - 1], radius=box * 2.2, fill=_WHITE)

    off = quiet * box

    def in_finder(r, c):
        return (r < 7 and c < 7) or (r < 7 and c >= n - 7) or (r >= n - 7 and c < 7)

    # Centre logo clear-zone (in module coords).
    clear = max(7, int(round(n * 0.22)))
    if (n - clear) % 2:  # keep it centred on the module grid
        clear += 1
    c0 = (n - clear) // 2
    c1 = c0 + clear

    def in_clear(r, c):
        return c0 <= r < c1 and c0 <= c < c1

    # Data modules - soft rounded squares (no inter-module gap, for reliability).
    rad = box * 0.35
    for r in range(n):
        for c in range(n):
            if not mat[r][c] or in_finder(r, c) or in_clear(r, c):
                continue
            x0 = off + c * box
            y0 = off + r * box
            _rounded(d, [x0, y0, x0 + box, y0 + box], radius=rad, fill=_INK)

    # Finder eyes - brand, with just-perceptible corner softening.
    def eye(r, c):
        x0 = off + c * box
        y0 = off + r * box
        _rounded(d, [x0, y0, x0 + 7 * box, y0 + 7 * box], radius=box * 0.6, fill=_BRAND)
        _rounded(d, [x0 + box, y0 + box, x0 + 6 * box, y0 + 6 * box], radius=box * 0.45, fill=_WHITE)
        _rounded(d, [x0 + 2 * box, y0 + 2 * box, x0 + 5 * box, y0 + 5 * box], radius=box * 0.3, fill=_BRAND_DK)

    eye(0, 0)
    eye(0, n - 7)
    eye(n - 7, 0)

    # Centre knockout + TIA logo.
    cx = cy = px / 2
    half = (clear * box) / 2
    _rounded(d, [cx - half, cy - half, cx + half, cy + half], radius=box * 1.4, fill=_WHITE)
    _draw_logo(d, cx, cy, clear * box * 0.80, _BRAND)

    out_path = str(out_path)
    img.save(out_path)
    return out_path


if __name__ == "__main__":
    p = make_whatsapp_qr("TIA-CL002-JUNE2026-0001", "_qr_demo.png")
    print("wrote", p, "url:", whatsapp_url("TIA-CL002-JUNE2026-0001"))

"""Invoice PDF rendering via Typst (Rust-backed, deterministic, typographic-grade).

The Typst compiler is shipped as a Python wheel (`typst-py`), so no system install
is needed and the rendering path is fully reproducible. Every PDF carries an audit
hash in the footer for tamper-evidence.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import typst

from ..config import STAGING_DIR

BRAND_HEX = "#d9531e"  # TASC orange-red

# ── TIA brand mark ──────────────────────────────────────────────────────────
# The logo is three straight-edged glyphs (T, the central I bar, the wide A),
# vector-traced from the master TIA_logo.svg. We draw them natively as Typst
# polygons (rather than embedding an external asset) so the PDF stays fully
# self-contained and deterministic. Coordinate space matches the SVG viewBox.
_LOGO_VIEWBOX = (1680, 769)
_LOGO_PATHS = (
    ((0, 0), (631, 0), (631, 177), (426, 177), (426, 767), (236, 767), (236, 177), (0, 177)),
    ((676, 0), (862, 0), (862, 557), (739, 767), (675, 767)),
    ((1233, 1), (1287, 90), (1680, 769), (1052, 769), (1153, 592), (1367, 591),
     (1235, 352), (1232, 352), (1162, 481), (1001, 767), (792, 768), (791, 765), (815, 723)),
)


def _logo_box(height_pt: float, color_expr: str = "brand") -> str:
    """Return a Typst `box[...]` expression that draws the TIA logo at the
    given height (pt). `color_expr` is a Typst color expression (e.g. a `#let`
    name like `brand`, or `rgb("#fff")`)."""
    vw, vh = _LOGO_VIEWBOX
    s = height_pt / vh
    width = vw * s
    polys = []
    for path in _LOGO_PATHS:
        pts = ", ".join(f"({x * s:.2f}pt, {y * s:.2f}pt)" for x, y in path)
        polys.append(f"  #place(top + left, polygon(fill: {color_expr}, stroke: none, {pts}))")
    body = "\n".join(polys)
    return f"box(width: {width:.2f}pt, height: {height_pt:.2f}pt)[\n{body}\n]"


_LOGO = _logo_box(22.0)
_LOGO_SM = _logo_box(8.5)  # footer mark, drawn at true size (no visual scaling)

# ponytail: emitting Typst source by string templating - safer than ad-hoc DSL,
# upgrade path is a sidecar .typ template file if the layout grows.

_MARKUP_SPECIALS = ("\\", "#", "*", "_", "`", "$", "<", ">", "[", "]", "~", "@")


def _esc(s) -> str:
    """Escape a value for Typst markup (plain text, no formatting)."""
    s = "" if s is None else str(s)
    for ch in _MARKUP_SPECIALS:
        s = s.replace(ch, "\\" + ch)
    return s


def _num(x) -> str:
    try:
        return f"{float(x):.2f}"
    except (TypeError, ValueError):
        return "0.00"


def _audit_hash(invoice: dict) -> str:
    payload = json.dumps(invoice, sort_keys=True, default=str).encode()
    return hashlib.sha256(payload).hexdigest()[:16]


_TEMPLATE = r"""
#set document(title: "Tax Invoice " + "{seq_no}")
#set text(size: 9.5pt, font: ("DejaVu Sans", "Liberation Sans", "Arial"), fill: rgb("#0f172a"))

#let brand = rgb("{brand}")
#let ink = rgb("#0f172a")
#let ink600 = rgb("#475569")
#let ink500 = rgb("#64748b")
#let ink400 = rgb("#94a3b8")
#let line200 = rgb("#e7ecf2")
#let fill50 = rgb("#f8fafc")
#let fill100 = rgb("#f1f5f9")
#let brand50 = rgb("#fef4ef")
#let tialogo = {logo}
#let tialogosm = {logo_sm}
#let eyebrow(s) = text(size: 6.5pt, weight: "bold", fill: ink400, tracking: 1.2pt, upper(s))
#let hcell(s) = text(size: 6.5pt, weight: "bold", fill: ink500, tracking: 0.7pt, upper(s))
#let hfill = (_, row) => if row == 0 {{ fill100 }} else {{ none }}

#set page(paper: "a4", margin: (x: 1.5cm, top: 1.35cm, bottom: 1.65cm), footer: [
  #line(length: 100%, stroke: 0.6pt + line200)
  #v(4pt)
  #grid(columns: (auto, 1fr), column-gutter: 9pt, align: (left + horizon, left + horizon),
    tialogosm,
    text(size: 6pt, fill: ink400)[Issued under UAE Federal Decree-Law No. 8 of 2017 on VAT  ·  All amounts in AED  ·  Audit hash #text(fill: ink500, weight: "medium")[{hash}]],
  )
])

// ── Masthead ──────────────────────────────────────────────────────────────
#grid(columns: (1fr, auto), align: (left + horizon, right + horizon),
  [ #tialogo ],
  [
    #text(size: 16pt, weight: "bold", tracking: 3pt, fill: ink)[TAX INVOICE]
    #linebreak() #v(1pt)
    #text(size: 8.5pt, fill: ink500)[No. ]
    #text(size: 8.5pt, weight: "medium", fill: ink600)[{seq_no}]
  ],
)
#v(7pt)
#line(length: 100%, stroke: 1.2pt + brand)
#v(13pt)

// ── Parties ───────────────────────────────────────────────────────────────
#grid(columns: (1fr, 1fr), gutter: 18pt,
  [
    #eyebrow("From") #v(4pt)
    #text(weight: "bold", size: 10.5pt)[TASC Outsourcing FZ-LLC] #linebreak()
    #text(fill: ink600)[Dubai, United Arab Emirates] #linebreak()
    #text(fill: ink500)[TRN ] #text(weight: "medium", fill: ink)[{supplier_trn}]
  ],
  [
    #eyebrow("Bill To") #v(4pt)
    #text(weight: "bold", size: 10.5pt)[{client}] #linebreak()
    #text(fill: ink600)[{place_of_supply}] #linebreak()
    #text(fill: ink500)[TRN ] #text(weight: "medium", fill: ink)[{customer_trn}]
  ],
)
#v(13pt)

// ── Invoice meta ──────────────────────────────────────────────────────────
#grid(columns: (1fr, 1fr, 1fr, 1fr), stroke: 0.6pt + line200, inset: (x: 10pt, y: 7pt),
  [#eyebrow("Invoice No.")#linebreak()#v(2pt)#text(size: 9pt, weight: "medium")[{seq_no}]],
  [#eyebrow("Issue Date")#linebreak()#v(2pt)#text(size: 9pt, weight: "medium")[{issue_date}]],
  [#eyebrow("Billing Period")#linebreak()#v(2pt)#text(size: 9pt, weight: "medium")[{period}]],
  [#eyebrow("Due Date")#linebreak()#v(2pt)#text(size: 9pt, weight: "medium")[{due_date}]],
)
#v(8pt)

// ── Service classification ────────────────────────────────────────────────
#block(width: 100%, fill: fill50, inset: (x: 10pt, y: 7pt), radius: 3pt)[
  #grid(columns: (auto, 1fr), column-gutter: 16pt,
    [#eyebrow("Service")#linebreak()#v(2pt)#text(size: 9pt, weight: "medium")[{service_code}]],
    [#eyebrow("Description")#linebreak()#v(2pt)#text(size: 9pt)[{service_desc}]],
  )
]
#v(13pt)

// ── Line items ────────────────────────────────────────────────────────────
#table(
  columns: (2.1cm, 1fr, 1cm, 2.1cm, 1.6cm, 1.9cm, 2.4cm),
  align: (left, left, right, right, right, right, right),
  inset: (x: 7pt, y: 6.5pt),
  stroke: (x: none, y: 0.6pt + line200),
  fill: hfill,
  table.header(
    hcell("Emp ID"), hcell("Employee - manpower supply"), hcell("Days"),
    hcell("Prorated"), hcell("OT"), hcell("Reimb"), hcell("Line Total"),
  ),
  {rows}
)
#v(13pt)

// ── Totals ────────────────────────────────────────────────────────────────
#grid(columns: (1fr, auto), gutter: 16pt, align: (left + bottom, right),
  [
    #eyebrow("Payment") #v(3pt)
    #text(size: 8.5pt, fill: ink600)[Payable within 30 days to TASC Outsourcing FZ-LLC.] #linebreak()
    #text(size: 8.5pt, fill: ink600)[Bank details on request  ·  quote the invoice number above.]
  ],
  box(width: 7.8cm)[
    #grid(columns: (1fr, auto), row-gutter: 6pt, align: (left, right),
      text(fill: ink600)[Subtotal (excl. VAT)], [AED {amount}],
      text(fill: ink600)[VAT @ {vat_pct}%], [AED {vat_amount}],
    )
    #v(7pt)
    #block(width: 100%, fill: brand50, inset: (x: 11pt, y: 9pt), radius: 4pt)[
      #grid(columns: (1fr, auto), align: (left + horizon, right + horizon),
        text(weight: "bold", size: 10.5pt)[Total (incl. VAT)],
        text(weight: "bold", size: 13pt, fill: brand)[AED {total_incl}],
      )
    ]
  ],
)

{warning}
{exceptions}
{qr_block}
"""


def _row_line(li: dict) -> str:
    cells = [
        _esc(li.get("emp_id")),
        _esc(li.get("employee_name")),
        _esc(li.get("days_worked")),
        _num(li.get("prorated")),
        _num(li.get("ot_amount")),
        _num(li.get("reimbursements")),
        _num(li.get("amount")),
    ]
    return ", ".join(f"[{c}]" for c in cells) + ","


def _qr_panel(qr_filename: str, seq_disp: str) -> str:
    """Typst block: branded WhatsApp QR + call-to-action. References lets
    (fill50/line200/ink/ink600/eyebrow) defined in the main template."""
    return (
        "\n#v(13pt)\n"
        '#block(width: 100%, fill: fill50, radius: 5pt, inset: 13pt, stroke: 0.6pt + line200)[\n'
        "  #grid(columns: (auto, 1fr), column-gutter: 15pt, align: (left + horizon, left + horizon),\n"
        f'    image("{qr_filename}", width: 3.1cm),\n'
        "    [\n"
        '      #eyebrow("Questions about this invoice?")\n'
        "      #v(5pt)\n"
        '      #text(size: 10.5pt, weight: "bold", fill: ink)[Scan to chat with TIA on WhatsApp]\n'
        "      #v(3pt)\n"
        '      #text(size: 8.5pt, fill: ink600)[Point your phone camera at the code to open a pre-filled '
        f'WhatsApp chat about Invoice #text(weight: "medium", fill: ink)[{seq_disp}]. Just hit send, and TIA '
        "replies with the live status, amounts, and full audit history, pulled straight from the system.]\n"
        "    ],\n"
        "  )\n"
        "]\n"
    )


def _warning_block(invoice: dict) -> str:
    if not invoice.get("requires_finance_approval"):
        return ""
    return (
        "\n#v(11pt)\n"
        f'#block(width: 100%, fill: rgb("#fef4ef"), stroke: (left: 2.5pt + rgb("{BRAND_HEX}")), '
        "inset: (x: 11pt, y: 9pt), radius: 2pt)[\n"
        f'  #text(fill: rgb("{BRAND_HEX}"), weight: "bold")[Above client threshold]'
        '#text(fill: rgb("#475569"))[ - requires Finance approval before dispatch.]\n'
        "]\n"
    )


def _exceptions_block(invoice: dict) -> str:
    exs = invoice.get("exceptions") or []
    if not exs:
        return ""
    n = len(exs)
    label = f"Held for review · {n} row" + ("s" if n != 1 else "")
    lines = "\n".join(
        f"  - #text(weight: \"medium\")[{_esc(ex.get('employee_name'))}]: "
        f"#text(fill: rgb(\"#475569\"))[{_esc(ex.get('reason'))}]"
        for ex in exs
    )
    return (
        "\n#v(11pt)\n"
        '#block(width: 100%, fill: rgb("#f8fafc"), stroke: (left: 2.5pt + rgb("#94a3b8")), '
        "inset: (x: 11pt, y: 9pt), radius: 2pt)[\n"
        f'  #text(size: 6.5pt, weight: "bold", fill: rgb("#64748b"), tracking: 1.2pt)[{label.upper()}]\n'
        "  #v(4pt)\n"
        f"{lines}\n"
        "]\n"
    )


def _sac_block(invoice: dict) -> str:
    sac = invoice.get("sac_code")
    if not sac:
        return ""
    return (
        "\n#v(4pt)\n"
        f'#text(size: 9pt, fill: rgb("#444"))[Service Accounting Code (SAC): *{_esc(sac)}* '
        "- Contract Staffing Services]\n"
    )


def _service_code_for(invoice: dict) -> tuple[str, str]:
    """Return (code, description) shown on every Tax Invoice.

    India uses HSN/SAC under GST - for staffing services that's SAC 998513
    ("Contract Staffing Services") or 998514 ("Temporary Staffing Services").
    UAE has no equivalent mandated taxonomy, so we surface the SAC code anyway
    as an informational service classification (TASC's actual practice on
    cross-jurisdiction invoices), with the UAE Tax Invoice mandatory
    'description of services' filled in.
    """
    sac = invoice.get("sac_code")
    if sac:
        return sac, "Contract Staffing Services"
    # UAE default - surface SAC as informational classification, not as a tax code
    return "SAC 998513 (informational)", "Manpower supply services - UAE FTA service category"


def render_invoice(invoice: dict, invoice_id: str) -> str:
    import datetime as dt

    audit = _audit_hash(invoice)
    rows = "\n  ".join(_row_line(li) for li in invoice.get("line_items", []))
    amount = float(invoice.get("amount") or invoice.get("total_excl_vat") or 0)
    vat_rate = float(invoice.get("vat_rate") or 0.05)
    vat_amount = float(invoice.get("vat_amount") or round(amount * vat_rate, 2))
    total_incl = float(invoice.get("total_incl_vat") or round(amount + vat_amount, 2))
    seq_no = invoice.get("invoice_sequence_no") or f"TIA-{invoice_id}"
    supplier_trn = invoice.get("supplier_trn") or "100123456700003"
    customer_trn = invoice.get("customer_trn") or "-"
    place_of_supply = invoice.get("place_of_supply") or "UAE"
    today = dt.date.today().isoformat()
    due_date = invoice.get("due_date") or (dt.date.today() + dt.timedelta(days=30)).isoformat()
    service_code, service_desc = _service_code_for(invoice)

    # Branded WhatsApp QR (deep link pre-filled with this invoice number).
    qr_block = ""
    try:
        from .qr import make_whatsapp_qr

        qr_name = f"qr_{invoice_id}.png"
        make_whatsapp_qr(seq_no, Path(STAGING_DIR) / qr_name)
        qr_block = _qr_panel(qr_name, _esc(seq_no))
    except Exception:  # noqa: BLE001 - QR is enhancement-only, never block the invoice
        qr_block = ""

    source = _TEMPLATE.format(
        seq_no=_esc(seq_no),
        brand=BRAND_HEX,
        logo=_LOGO,
        logo_sm=_LOGO_SM,
        client=_esc(invoice.get("client_name") or invoice.get("client_code") or "-"),
        period=_esc(invoice.get("period") or "-"),
        amount=_num(amount),
        vat_pct=_num(vat_rate * 100),
        vat_amount=_num(vat_amount),
        total_incl=_num(total_incl),
        supplier_trn=_esc(supplier_trn),
        customer_trn=_esc(customer_trn),
        place_of_supply=_esc(place_of_supply),
        issue_date=today,
        due_date=_esc(due_date),
        service_code=_esc(service_code),
        service_desc=_esc(service_desc),
        rows=rows or "[-], [no line items], [], [], [], [], [],",
        warning=_warning_block(invoice),
        exceptions=_exceptions_block(invoice),
        qr_block=qr_block,
        hash=audit,
    )
    typ_path = Path(STAGING_DIR) / f"invoice_{invoice_id}.typ"
    pdf_path = Path(STAGING_DIR) / f"invoice_{invoice_id}.pdf"
    typ_path.write_text(source, encoding="utf-8")
    typst.compile(str(typ_path), output=str(pdf_path))
    return str(pdf_path)


def _demo() -> None:
    inv = {
        "client_name": "Emaar Properties PJSC",
        "client_code": "CL002",
        "period": "June 2026",
        "currency": "AED",
        "amount": 12345.67,
        "vat_rate": 0.05,
        "vat_amount": 617.28,
        "total_excl_vat": 12345.67,
        "total_incl_vat": 12962.95,
        "supplier_trn": "100123456700003",
        "customer_trn": "200200200000003",
        "invoice_sequence_no": "TIA-CL002-JUNE2026-0001",
        "place_of_supply": "Dubai, UAE",
        "sac_code": None,
        "requires_finance_approval": True,
        "line_items": [
            {
                "emp_id": "EMP10001",
                "employee_name": "Carlos Smith",
                "days_worked": 22,
                "prorated": 10000.0,
                "ot_amount": 500.0,
                "reimbursements": 0.0,
                "amount": 12075.0,
            },
        ],
        "exceptions": [{"employee_name": "Aisha Al Zaabi", "reason": "ambiguous match"}],
    }
    out = render_invoice(inv, "demo-001")
    assert Path(out).exists() and Path(out).stat().st_size > 1000, out
    print("typst tax invoice rendered:", out, Path(out).stat().st_size, "bytes")


# ─────────────────────────────────────────────────────────────────────────────
#  Credit-note rendering - Page 2 appended to the original Tax Invoice.
#
#  UAE FTA Decision No. 7 of 2019 permits a single physical document that
#  shows "Tax Invoice / Tax Credit Note" - that's the legal basis for combining
#  the two on one PDF. We keep them on separate pages (page 1 unchanged,
#  page 2 = credit note) so a buyer's AP system can reconcile cleanly.
# ─────────────────────────────────────────────────────────────────────────────


_CREDIT_NOTE_REASON_FRIENDLY: dict[str, str] = {
    "PRICING_ERROR": "Pricing error - the billing rate on the original invoice was incorrect",
    "GOODS_RETURNED": "Services returned or cancelled by the customer",
    "DISCOUNT": "A post-sale discount was granted to the customer",
    "DUPLICATE": "The original invoice was a duplicate of an earlier issuance",
    "OTHER": "An adjustment was required (see reason text below)",
}


_CREDIT_NOTE_TEMPLATE = r"""
#pagebreak()

#let cnred = rgb("#b42318")
#let cnred50 = rgb("#fef3f2")
#let eyebrow_r(s) = text(size: 6.5pt, weight: "bold", fill: rgb("#94a3b8"), tracking: 1.2pt, upper(s))

// ── Masthead ──────────────────────────────────────────────────────────────
#grid(columns: (1fr, auto), align: (left + horizon, right + horizon),
  [ #tialogo ],
  [
    #text(size: 16pt, weight: "bold", tracking: 2.5pt, fill: cnred)[TAX CREDIT NOTE]
    #linebreak() #v(1pt)
    #text(size: 8.5pt, fill: ink500)[No. ]
    #text(size: 8.5pt, weight: "medium", fill: ink600)[{cn_seq}]
  ],
)
#v(7pt)
#line(length: 100%, stroke: 1.2pt + cnred)
#v(11pt)

#block(width: 100%, fill: cnred50, stroke: (left: 2.5pt + cnred), inset: (x: 11pt, y: 9pt), radius: 2pt)[
  #text(fill: cnred, weight: "bold")[Adjusts Tax Invoice {orig_seq}] #text(fill: ink600)[ dated {orig_date}. Combined Tax Invoice / Tax Credit Note document, issued under FTA Decision No. 7 of 2019.]
]
#v(13pt)

// ── Parties ───────────────────────────────────────────────────────────────
#grid(columns: (1fr, 1fr), gutter: 18pt,
  [
    #eyebrow_r("From") #v(4pt)
    #text(weight: "bold", size: 10.5pt)[TASC Outsourcing FZ-LLC] #linebreak()
    #text(fill: ink600)[Dubai, United Arab Emirates] #linebreak()
    #text(fill: ink500)[TRN ] #text(weight: "medium", fill: ink)[{supplier_trn}]
  ],
  [
    #eyebrow_r("Bill To") #v(4pt)
    #text(weight: "bold", size: 10.5pt)[{client}] #linebreak()
    #text(fill: ink600)[{place_of_supply}] #linebreak()
    #text(fill: ink500)[TRN ] #text(weight: "medium", fill: ink)[{customer_trn}]
  ],
)
#v(13pt)

// ── Credit note meta ──────────────────────────────────────────────────────
#grid(columns: (1fr, 1fr, 1fr, 1fr), stroke: 0.6pt + line200, inset: (x: 10pt, y: 7pt),
  [#eyebrow_r("Credit Note No.")#linebreak()#v(2pt)#text(size: 9pt, weight: "medium")[{cn_seq}]],
  [#eyebrow_r("Issue Date")#linebreak()#v(2pt)#text(size: 9pt, weight: "medium")[{cn_date}]],
  [#eyebrow_r("Period")#linebreak()#v(2pt)#text(size: 9pt, weight: "medium")[{period}]],
  [#eyebrow_r("Currency")#linebreak()#v(2pt)#text(size: 9pt, weight: "medium")[{currency}]],
)
#v(8pt)

// ── Reason ────────────────────────────────────────────────────────────────
#block(width: 100%, fill: fill50, inset: (x: 10pt, y: 8pt), radius: 3pt)[
  #eyebrow_r("Reason") #h(5pt) #text(size: 6.5pt, weight: "bold", fill: cnred, tracking: 1pt)[{reason_code}]
  #v(3pt)
  #text(size: 9pt)[{reason_friendly}]
  {reason_text_block}
]
#v(13pt)

#text(size: 7pt, weight: "bold", fill: cnred, tracking: 1.2pt)[REVERSAL OF CHARGES]
#v(5pt)

// ── Reversed line items ───────────────────────────────────────────────────
#table(
  columns: (2.1cm, 1fr, 1cm, 2.1cm, 1.6cm, 1.9cm, 2.4cm),
  align: (left, left, right, right, right, right, right),
  inset: (x: 7pt, y: 6.5pt),
  stroke: (x: none, y: 0.6pt + line200),
  fill: hfill,
  table.header(
    hcell("Emp ID"), hcell("Employee - manpower supply"), hcell("Days"),
    hcell("Prorated"), hcell("OT"), hcell("Reimb"), hcell("Reversed"),
  ),
  {rows}
)
#v(13pt)

// ── Totals (negative) ─────────────────────────────────────────────────────
#grid(columns: (1fr, auto), gutter: 16pt, align: (left + bottom, right),
  [
    #eyebrow_r("Note") #v(3pt)
    #text(size: 8.5pt, fill: ink600)[This credit note reverses the charges shown on the referenced invoice.]
  ],
  box(width: 7.8cm)[
    #grid(columns: (1fr, auto), row-gutter: 6pt, align: (left, right),
      text(fill: ink600)[Subtotal reversal (excl. VAT)], [AED -{amount}],
      text(fill: ink600)[VAT @ {vat_pct}% reversal], [AED -{vat_amount}],
    )
    #v(7pt)
    #block(width: 100%, fill: cnred50, inset: (x: 11pt, y: 9pt), radius: 4pt)[
      #grid(columns: (1fr, auto), align: (left + horizon, right + horizon),
        text(weight: "bold", size: 10.5pt)[Total credit (incl. VAT)],
        text(weight: "bold", size: 13pt, fill: cnred)[AED -{total_incl}],
      )
    ]
  ],
)

#v(13pt)
#text(size: 7pt, fill: ink400)[
  Issued under UAE VAT Law Article 60 (tax credit notes) and Article 62 (VAT adjustments),
  and FTA Decision No. 7 of 2019. Retain for 5 years (FTA tax records retention).
]
{qr_block}
"""


def _credit_note_source(invoice_dict: dict, audit_hash: str) -> str:
    """Render just the credit-note (page 2) Typst source given the invoice dict
    plus the credit-note fields."""
    import datetime as dt

    reason_code = invoice_dict.get("credit_note_reason_code") or "OTHER"
    reason_friendly = _CREDIT_NOTE_REASON_FRIENDLY.get(
        reason_code, _CREDIT_NOTE_REASON_FRIENDLY["OTHER"]
    )
    reason_text = invoice_dict.get("credit_note_reason_text") or ""
    reason_text_block = f"\n  #v(2pt) _Operator note:_ {_esc(reason_text)}\n" if reason_text else ""
    issued_at = invoice_dict.get("credit_note_issued_at")
    if isinstance(issued_at, dt.datetime):
        cn_date = issued_at.date().isoformat()
    elif isinstance(issued_at, str):
        cn_date = issued_at[:10]
    else:
        cn_date = dt.date.today().isoformat()

    amount = float(invoice_dict.get("amount") or invoice_dict.get("total_excl_vat") or 0)
    vat_rate = float(invoice_dict.get("vat_rate") or 0.05)
    vat_amount = float(invoice_dict.get("vat_amount") or round(amount * vat_rate, 2))
    total_incl = float(invoice_dict.get("total_incl_vat") or round(amount + vat_amount, 2))

    rows = "\n  ".join(_row_line(li) for li in invoice_dict.get("line_items", []))

    # WhatsApp QR references the original invoice number (what the client asks about).
    qr_block = ""
    try:
        from .qr import make_whatsapp_qr

        orig_no = invoice_dict.get("invoice_sequence_no") or "-"
        qr_name = f"qr_{(invoice_dict.get('id') or 'cn')[:8]}_cn.png"
        make_whatsapp_qr(orig_no, Path(STAGING_DIR) / qr_name)
        qr_block = _qr_panel(qr_name, _esc(orig_no))
    except Exception:  # noqa: BLE001
        qr_block = ""

    return _CREDIT_NOTE_TEMPLATE.format(
        brand=BRAND_HEX,
        orig_seq=_esc(invoice_dict.get("invoice_sequence_no") or "-"),
        orig_date=_esc(
            (invoice_dict.get("created_at") or "")[:10]
            if isinstance(invoice_dict.get("created_at"), str)
            else dt.date.today().isoformat()
        ),
        supplier_trn=_esc(invoice_dict.get("supplier_trn") or "100123456700003"),
        customer_trn=_esc(invoice_dict.get("customer_trn") or "-"),
        place_of_supply=_esc(invoice_dict.get("place_of_supply") or "UAE"),
        client=_esc(invoice_dict.get("client_name") or invoice_dict.get("client_code") or "-"),
        cn_seq=_esc(invoice_dict.get("credit_note_sequence_no") or "-"),
        cn_date=_esc(cn_date),
        period=_esc(invoice_dict.get("period") or "-"),
        currency=_esc(invoice_dict.get("currency") or "AED"),
        reason_code=_esc(reason_code),
        reason_friendly=_esc(reason_friendly),
        reason_text_block=reason_text_block,
        rows=rows or "[-], [no line items], [], [], [], [], [],",
        amount=_num(amount),
        vat_pct=_num(vat_rate * 100),
        vat_amount=_num(vat_amount),
        total_incl=_num(total_incl),
        qr_block=qr_block,
        hash=audit_hash,
    )


def render_invoice_with_credit_note(invoice_obj) -> str:
    """Re-render an invoice's PDF with the credit note appended as page 2.

    `invoice_obj` is a SQLAlchemy `Invoice` row (we read its fields). The
    rendered PDF replaces the original at `invoice.pdf_path` so the client
    always sees the latest combined document. The original is preserved at
    `<pdf>.v1.pdf` for audit.
    """
    import shutil

    inv = {
        "id": invoice_obj.id,
        "client_code": invoice_obj.client_code,
        "client_name": getattr(invoice_obj, "client_name", None),
        "period": invoice_obj.period,
        "amount": invoice_obj.amount,
        "currency": invoice_obj.currency,
        "line_items": invoice_obj.line_items or [],
        "invoice_sequence_no": invoice_obj.invoice_sequence_no,
        "supplier_trn": invoice_obj.supplier_trn,
        "customer_trn": invoice_obj.customer_trn,
        "vat_rate": invoice_obj.vat_rate,
        "vat_amount": invoice_obj.vat_amount,
        "total_excl_vat": invoice_obj.total_excl_vat,
        "total_incl_vat": invoice_obj.total_incl_vat,
        "sac_code": invoice_obj.sac_code,
        "place_of_supply": invoice_obj.place_of_supply,
        "due_date": invoice_obj.due_date,
        "credit_note_sequence_no": invoice_obj.credit_note_sequence_no,
        "credit_note_issued_at": invoice_obj.credit_note_issued_at,
        "credit_note_reason_code": invoice_obj.credit_note_reason_code,
        "credit_note_reason_text": invoice_obj.credit_note_reason_text,
        "created_at": str(invoice_obj.created_at) if invoice_obj.created_at else None,
    }
    audit = _audit_hash(inv)
    # 1) build page 1 (the original Tax Invoice) - same as render_invoice does
    rows = "\n  ".join(_row_line(li) for li in inv.get("line_items", []))
    amount = float(inv.get("amount") or 0)
    vat_rate = float(inv.get("vat_rate") or 0.05)
    vat_amount = float(inv.get("vat_amount") or round(amount * vat_rate, 2))
    total_incl = float(inv.get("total_incl_vat") or round(amount + vat_amount, 2))
    seq_no = inv.get("invoice_sequence_no") or f"TIA-{inv['id'][:8]}"
    today = (
        str(invoice_obj.created_at)[:10]
        if invoice_obj.created_at
        else __import__("datetime").date.today().isoformat()
    )
    due_date = inv.get("due_date") or today
    service_code, service_desc = _service_code_for(inv)
    page1 = _TEMPLATE.format(
        seq_no=_esc(seq_no),
        brand=BRAND_HEX,
        logo=_LOGO,
        logo_sm=_LOGO_SM,
        client=_esc(inv.get("client_name") or inv.get("client_code") or "-"),
        period=_esc(inv.get("period") or "-"),
        amount=_num(amount),
        vat_pct=_num(vat_rate * 100),
        vat_amount=_num(vat_amount),
        total_incl=_num(total_incl),
        supplier_trn=_esc(inv.get("supplier_trn") or "100123456700003"),
        customer_trn=_esc(inv.get("customer_trn") or "-"),
        place_of_supply=_esc(inv.get("place_of_supply") or "UAE"),
        issue_date=today,
        due_date=_esc(due_date),
        service_code=_esc(service_code),
        service_desc=_esc(service_desc),
        rows=rows or "[-], [no line items], [], [], [], [], [],",
        warning="",  # the credit note supersedes any approval warning
        exceptions="",
        qr_block="",  # QR lives on the last page (the credit note)
        hash=audit,
    )
    # 2) append the credit note as page 2
    page2 = _credit_note_source(inv, audit)
    full_source = page1 + page2

    inv_id = invoice_obj.id[:8]
    typ_path = Path(STAGING_DIR) / f"invoice_{inv_id}_with_cn.typ"
    new_pdf = Path(STAGING_DIR) / f"invoice_{inv_id}_with_cn.pdf"
    typ_path.write_text(full_source, encoding="utf-8")

    # preserve the original PDF (audit retention)
    if invoice_obj.pdf_path and Path(invoice_obj.pdf_path).exists():
        try:
            archive = Path(invoice_obj.pdf_path).with_suffix(".v1.pdf")
            if not archive.exists():
                shutil.copy2(invoice_obj.pdf_path, archive)
        except Exception:  # noqa: BLE001
            pass

    typst.compile(str(typ_path), output=str(new_pdf))
    return str(new_pdf)


if __name__ == "__main__":
    _demo()

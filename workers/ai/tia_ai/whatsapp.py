"""WhatsApp loop helpers for the core.

The bridge (`workers/whatsapp`) is a stateless transport adapter; the core is the
single source of truth. This module holds the small amount of core-side logic the
full loop needs:

  1. classify_inbound_text  — decide whether a typed WhatsApp message is a new
     timesheet or a question about an existing invoice ("talk to the invoice").
  2. resolve_sender         — map a WhatsApp phone number back to its most recent
     timesheet/invoice (the doc was ingested with uploaded_by=<phone>), so chat is
     strictly scoped to that sender's client (data-isolation trust boundary).
  3. answer_for_sender      — run the grounded /qa agent scoped to the sender.
  4. push_invoice_to_sender — after a human approves a flagged timesheet on the web
     console, push the finished invoice PDF back to the WhatsApp sender via the
     bridge's secret-guarded /internal/notify endpoint.

The core never talks to Meta directly: it hands the bridge a URL to the PDF and the
bridge uploads + sends it. That keeps the two services decoupled.
"""

from __future__ import annotations

import re

from sqlalchemy.orm import Session

from .config import INTERNAL_SECRET, TIA_SELF_URL, WHATSAPP_BRIDGE_URL
from .models import Client, DocAsset, Invoice, Timesheet

WHATSAPP_CHANNEL = "whatsapp"

HELP_TEXT = (
    "👋 I'm AIDA, TASC's invoice assistant.\n\n"
    "Send a timesheet and I'll turn it into a VAT invoice:\n"
    "• an Excel or PDF file\n"
    "• a photo of a handwritten sheet\n"
    "• or just type it — e.g. \"EMP10001 worked 22 days, 5 OT hours\"\n\n"
    "Once your invoice is ready you can ask me about it — the total, the VAT, "
    "or why a line is what it is."
)

# ---------------------------------------------------------------- intent

# Standalone greetings / commands / pleasantries — answered with help, never pushed
# into the extraction pipeline (so a "hi" doesn't create a junk escalate timesheet).
_GREETING = re.compile(
    r"^\s*(hi+|hey+|hello+|hii+|yo|hai|namaste|as-?salam(u)?( alaikum)?|salam|"
    r"good\s*(morning|afternoon|evening|day)|start|menu|help|/start|/help|"
    r"thanks|thank\s*you|thx|ok|okay|cool|nice|great|test|ping)[\s!.?😊👍🙏]*$",
    re.IGNORECASE,
)

# ---------------------------------------------------------------- intent

# Strong timesheet signals: an explicit employee id, a "<n> days" token, OT/leave
# vocabulary, or a payout/timesheet keyword. A typed timesheet is unambiguous, so
# when any of these fire we treat the message as intake even if it also reads like
# a sentence.
_TIMESHEET_PATTERNS = (
    re.compile(r"\bEMP\d{3,}\b", re.IGNORECASE),
    re.compile(r"\b\d+(\.\d+)?\s*days?\b", re.IGNORECASE),
    re.compile(r"\bO\.?T\b", re.IGNORECASE),
    re.compile(r"\b(annual|sick|unpaid|leave|present|absent)\b", re.IGNORECASE),
    re.compile(r"\b(timesheet|payout|reimburse|attendance|worked)\b", re.IGNORECASE),
)

# Question signals: an explicit question, or invoice/billing vocabulary.
_QUESTION_LEAD = re.compile(
    r"^\s*(why|what|whats|what's|how|how's|when|who|which|where|can|could|is|are|do|does|did|"
    r"explain|tell me|show me|breakdown|break down|status|help)\b",
    re.IGNORECASE,
)
_QUESTION_VOCAB = re.compile(
    r"\b(invoice|vat|tax|total|amount|bill(ing|ed)?|charge|breakdown|rate|markup|"
    r"due|paid|payment|approve[d]?|reject(ed)?|review|why)\b",
    re.IGNORECASE,
)


def classify_inbound_text(text: str | None) -> str:
    """Return "greeting", "timesheet", or "question".

    A standalone greeting/command wins first (so "hi" gets help, not a junk doc).
    Then timesheet signals (a typed timesheet is unambiguous). Otherwise a leading
    question word, billing vocabulary, or trailing '?' marks a question. Empty /
    unclear text defaults to "timesheet" so first-contact data still flows in (the
    caller only routes to chat when the sender has prior context).
    """
    t = (text or "").strip()
    if not t:
        return "timesheet"
    if _GREETING.fullmatch(t):
        return "greeting"
    if any(p.search(t) for p in _TIMESHEET_PATTERNS):
        return "timesheet"
    if t.endswith("?") or _QUESTION_LEAD.search(t) or _QUESTION_VOCAB.search(t):
        return "question"
    return "timesheet"


# ---------------------------------------------------------------- sender → client


def _digits(s: str | None) -> str:
    return re.sub(r"\D", "", s or "")


def client_for_sender(session: Session, phone: str | None) -> str | None:
    """Map a WhatsApp sender phone to a registered client via
    `Client.settings.whatsapp_number`.

    Comparison is digit-only with a suffix match so stored "9400245958",
    "919400245958", and "+91 94002 45958" all resolve to the same client (country
    code / formatting differences are common). Requires ≥8 shared digits to avoid
    spurious matches. This makes a known client's WhatsApp submissions correctly
    attributed even when the document text is silent or ambiguous about the client.
    """
    pd = _digits(phone)
    if len(pd) < 8:
        return None
    for c in session.query(Client).all():
        wn = _digits((c.settings or {}).get("whatsapp_number"))
        if len(wn) >= 8 and (pd == wn or pd.endswith(wn) or wn.endswith(pd)):
            return c.code
    return None


# ---------------------------------------------------------------- sender context


def resolve_sender(session: Session, phone: str | None) -> dict | None:
    """Resolve a WhatsApp phone to its latest timesheet + invoice + owning client.

    Falls back to the registered-client binding (`Client.settings.whatsapp_number`)
    when the sender has no submission history yet, so a known client contact can still
    chat scoped to their own client. Returns None only when neither resolves (so the
    caller refuses to answer rather than leak another client's data).
    """
    if not phone:
        return None
    ts = (
        session.query(Timesheet)
        .join(DocAsset, Timesheet.doc_id == DocAsset.id)
        .filter(
            DocAsset.source_channel == WHATSAPP_CHANNEL,
            DocAsset.uploaded_by == phone,
        )
        .order_by(Timesheet.created_at.desc())
        .first()
    )
    if ts is None:
        bound = client_for_sender(session, phone)
        if bound is None:
            return None
        return {"client_code": bound, "timesheet_id": None, "invoice_id": None}
    inv = (
        session.query(Invoice)
        .filter(Invoice.timesheet_id == ts.id)
        .order_by(Invoice.created_at.desc())
        .first()
    )
    return {
        "client_code": ts.client_code or client_for_sender(session, phone),
        "timesheet_id": ts.id,
        "invoice_id": inv.id if inv else None,
    }


def answer_for_sender(session: Session, phone: str | None, question: str) -> dict:
    """Run the grounded chat agent scoped to this WhatsApp sender's client.

    Strictly client-scoped: the sender can only get answers about their own data.
    When the sender has no history we return a friendly prompt instead of an
    unscoped (leaky) answer.
    """
    ctx = resolve_sender(session, phone)
    if ctx is None or not ctx.get("client_code"):
        return {
            "answer": (
                "I don't have a timesheet or invoice from this number yet. Send a "
                "timesheet first (file, photo, or text) and then you can ask me about it."
            ),
            "citations": [],
            "tool_calls": [],
            "scoped": False,
        }

    entity_context = None
    if ctx.get("invoice_id"):
        entity_context = {"kind": "invoice", "id": ctx["invoice_id"]}
    elif ctx.get("timesheet_id"):
        entity_context = {"kind": "timesheet", "id": ctx["timesheet_id"]}

    from .qa import answer

    result = answer(
        session,
        question,
        entity_context=entity_context,
        client_scope=ctx["client_code"],
    )
    result["scoped"] = True
    result["client_code"] = ctx["client_code"]
    return result


# ---------------------------------------------------------------- outbound push


def notify_bridge(to: str, kind: str, **fields) -> tuple[bool, str]:
    """POST to the bridge's /internal/notify (secret-guarded). Best-effort.

    Returns (ok, detail). Never raises — a WhatsApp delivery failure must not break
    the approval transaction on the web console.
    """
    import httpx

    body = {"to": to, "kind": kind, **fields}
    try:
        r = httpx.post(
            f"{WHATSAPP_BRIDGE_URL.rstrip('/')}/internal/notify",
            headers={"x-internal-secret": INTERNAL_SECRET, "content-type": "application/json"},
            json=body,
            timeout=25.0,
        )
        if r.status_code == 200:
            data = r.json()
            return bool(data.get("ok")), str(data.get("result") or data)
        return False, f"bridge returned {r.status_code}: {r.text[:200]}"
    except Exception as e:  # noqa: BLE001 — best-effort transport, surfaced to audit
        return False, f"bridge unreachable: {str(e)[:200]}"


def _ref(doc_or_inv_id: str) -> str:
    """Match the bridge's TIA-XXXXXXXX reference style for a consistent UX."""
    return "TIA-" + doc_or_inv_id.replace("-", "")[:8].upper()


def push_invoice_to_sender(session: Session, invoice: Invoice) -> dict | None:
    """If the invoice originated from a WhatsApp submission, push the PDF back to
    that sender. Returns a result dict (logged by the caller) or None when the
    invoice did not come from WhatsApp (so there's nothing to push)."""
    ts = session.get(Timesheet, invoice.timesheet_id)
    doc = session.get(DocAsset, ts.doc_id) if ts and ts.doc_id else None
    if not doc or doc.source_channel != WHATSAPP_CHANNEL or not doc.uploaded_by:
        return None

    to = doc.uploaded_by
    ref = _ref(invoice.id)
    amount = invoice.total_incl_vat or invoice.amount or 0
    caption = (
        f"✅ Invoice ready ({ref})\n"
        f"{invoice.currency} {amount:,.2f} (incl. VAT)\n"
        f"Reviewed and approved by our team."
    )
    url = f"{TIA_SELF_URL.rstrip('/')}/invoices/{invoice.id}/pdf"
    ok, detail = notify_bridge(
        to,
        "document",
        url=url,
        filename=f"{ref}.pdf",
        caption=caption,
    )
    return {"to": to, "ok": ok, "detail": detail, "invoice_id": invoice.id, "ref": ref}


def push_text_to_sender(session: Session, ts: Timesheet, text: str) -> dict | None:
    """Push a plain-text status note back to the originating WhatsApp sender
    (used on rejection). Returns a result dict or None for non-WhatsApp origin."""
    doc = session.get(DocAsset, ts.doc_id) if ts and ts.doc_id else None
    if not doc or doc.source_channel != WHATSAPP_CHANNEL or not doc.uploaded_by:
        return None
    ok, detail = notify_bridge(doc.uploaded_by, "text", text=text)
    return {"to": doc.uploaded_by, "ok": ok, "detail": detail}

"""FastAPI app — public surface for the React frontend and the WhatsApp bridge.

Endpoints follow CONTRACTS.md. Idempotency-Key is honored on mutations.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any

from fastapi import (
    Depends,
    FastAPI,
    Form,
    Header,
    HTTPException,
    Request,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import DATA_DIR, STAGING_DIR
from ..db import SessionLocal, init_db
from ..models import Client, DocAsset, Event, Invoice, Query, Timesheet
from ..orchestrator import (
    approve_timesheet,
    dispatch_invoice,
    ingest_file,
    log_event,
    process_doc,
    reject_timesheet,
)

app = FastAPI(title="TIA — Touchless Invoice Agent", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=False,
)


def db_session() -> Session:  # FastAPI dependency
    s = SessionLocal()
    try:
        yield s
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


@app.on_event("startup")
def _startup() -> None:
    init_db()


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


# ---------------------------------------------------------------- intake


# Brief §9: "Don't hide the AI — surface accuracy scores and HITL moments."
# Brief §4.8 cross-cutting: file safety / size limits / MIME sniffing.
MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MB hard cap on uploads — generous for handwritten scans
ALLOWED_MIME_PREFIXES = (
    "image/",
    "application/pdf",
    "application/vnd.openxmlformats",
    "application/vnd.ms-excel",
    "text/",
    "message/rfc822",
    "application/octet-stream",
)


@app.post("/intake/upload")
async def intake_upload(
    file: UploadFile,
    uploaded_by: str = Form("client"),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    s: Session = Depends(db_session),
) -> dict:
    raw = await file.read()
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"file too large: {len(raw)} > {MAX_UPLOAD_BYTES} bytes")
    if file.content_type and not any(
        file.content_type.startswith(p) for p in ALLOWED_MIME_PREFIXES
    ):
        raise HTTPException(415, f"unsupported media type: {file.content_type}")
    tmp = Path(STAGING_DIR) / f"_inbox_{uuid.uuid4().hex}_{file.filename}"
    tmp.write_bytes(raw)
    doc = ingest_file(
        s,
        tmp,
        channel="upload",
        mime=file.content_type,
        uploaded_by=uploaded_by,
        idempotency_key=idempotency_key,
    )
    ts = process_doc(s, doc)
    return {
        "doc_id": doc.id,
        "timesheet_id": ts.id,
        "status": ts.status,
        "routing": ts.routing,
        "confidence": ts.confidence_calibrated,
    }


class EmailIntake(BaseModel):
    body: str
    subject: str | None = None
    from_addr: str | None = None
    to_addrs: list[str] = []
    cc_addrs: list[str] = []
    client_hint: str | None = None
    uploaded_by: str = "client"
    intake_mode: str | None = None  # if not provided we infer below


# TIA's own email address — anything to/cc'd here is treated as an intake.
TIA_EMAIL_ADDRESSES = {
    "tia@cyberkunju.com",
    "tia@tasc.test",
    "timesheets@tia.test",
    "billing@tia.test",
}


def _infer_intake_mode(payload: "EmailIntake", session: Session) -> str:
    """Return one of: 'direct_forward' | 'cc_silent' | 'watched_mailbox' | 'unknown'."""
    if payload.intake_mode:
        return payload.intake_mode
    to_l = [a.lower().strip() for a in (payload.to_addrs or [])]
    cc_l = [a.lower().strip() for a in (payload.cc_addrs or [])]
    if any(a in TIA_EMAIL_ADDRESSES for a in to_l):
        return "direct_forward"
    if any(a in TIA_EMAIL_ADDRESSES for a in cc_l):
        return "cc_silent"
    # watched mailbox: any address (to or cc) matches a per-client watched list
    all_addrs = set(to_l + cc_l)
    for c in session.query(Client).all():
        watched = [a.lower() for a in (c.settings or {}).get("watched_mailboxes", []) or []]
        if any(a in watched for a in all_addrs):
            return "watched_mailbox"
    return "unknown"


@app.post("/intake/email")
def intake_email(
    payload: EmailIntake,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    s: Session = Depends(db_session),
) -> dict:
    mode = _infer_intake_mode(payload, s)
    tmp = Path(STAGING_DIR) / f"_inbox_{uuid.uuid4().hex}.eml"
    parts = []
    if payload.subject:
        parts.append(f"Subject: {payload.subject}")
    if payload.from_addr:
        parts.append(f"From: {payload.from_addr}")
    if payload.to_addrs:
        parts.append(f"To: {', '.join(payload.to_addrs)}")
    if payload.cc_addrs:
        parts.append(f"Cc: {', '.join(payload.cc_addrs)}")
    parts.append("")
    parts.append(payload.body)
    tmp.write_text("\n".join(parts), encoding="utf-8")
    doc = ingest_file(
        s,
        tmp,
        channel="email",
        mime="text/plain",
        uploaded_by=payload.uploaded_by,
        idempotency_key=idempotency_key,
    )
    # log the email-mode decision on the doc so the Review screen can show it
    from ..orchestrator import log_event

    log_event(
        s,
        payload.from_addr or "email",
        "doc",
        doc.id,
        "email.mode_detected",
        {
            "intake_mode": mode,
            "to": payload.to_addrs,
            "cc": payload.cc_addrs,
            "from": payload.from_addr,
        },
    )
    ts = process_doc(s, doc)
    # cc_silent: if processed cleanly, no reply; if any exception, draft a reply
    reply_drafted = False
    if mode == "cc_silent" and ts.routing in ("hitl", "escalate"):
        reply_path = _draft_cc_silent_reply(payload, ts)
        log_event(
            s,
            "smart_bot_sap",
            "doc",
            doc.id,
            "email.cc_silent_reply_drafted",
            {"path": str(reply_path), "routing": ts.routing, "reason": ts.hitl_reason},
        )
        reply_drafted = True
    return {
        "doc_id": doc.id,
        "timesheet_id": ts.id,
        "status": ts.status,
        "routing": ts.routing,
        "confidence": ts.confidence_calibrated,
        "intake_mode": mode,
        "reply_drafted": reply_drafted,
    }


def _draft_cc_silent_reply(payload: "EmailIntake", ts) -> Path:
    """Write a .eml reply draft to staging/outbox/ — TIA's polite 'we paused this' note."""
    out = Path(STAGING_DIR) / "outbox" / f"reply_{ts.id[:8]}.eml"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        f"""From: tia@tasc.test
To: {payload.from_addr or "unknown"}
Cc: {", ".join(payload.cc_addrs)}
Subject: Re: {payload.subject or "Your timesheet submission"}

Hi,

Thanks for the submission — TIA processed it but paused for human review.

Reason: {ts.hitl_reason or "flagged for review"}
Reference: timesheet {ts.id[:8]} · routing {ts.routing} · confidence {ts.confidence_calibrated}

A FinOps reviewer will follow up shortly. No action required from you.

— TIA (Touchless Invoice Agent)
""",
        encoding="utf-8",
    )
    return out


class MailboxWebhook(BaseModel):
    """Postmark/SES-shape webhook for the watched-mailbox channel.

    A real production setup forwards inbound mail through Postmark or SES into
    this endpoint. For the demo any client can POST a payload and TIA will
    treat it as if it had come from a monitored billing inbox.
    """

    From: str | None = None
    To: str | None = None
    Cc: str | None = None
    Subject: str | None = None
    TextBody: str | None = None
    HtmlBody: str | None = None


@app.post("/intake/mailbox-webhook")
def intake_mailbox_webhook(
    payload: MailboxWebhook,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    s: Session = Depends(db_session),
) -> dict:
    """Watched-mailbox simulator. We adapt the Postmark shape to our internal
    EmailIntake and force intake_mode='watched_mailbox'."""
    body = payload.TextBody or ""
    if not body and payload.HtmlBody:
        import re

        body = re.sub(r"<[^>]+>", "", payload.HtmlBody)
    inner = EmailIntake(
        body=body,
        subject=payload.Subject,
        from_addr=payload.From,
        to_addrs=[a.strip() for a in (payload.To or "").split(",") if a.strip()],
        cc_addrs=[a.strip() for a in (payload.Cc or "").split(",") if a.strip()],
        intake_mode="watched_mailbox",
        uploaded_by=payload.From or "mailbox-watcher",
    )
    return intake_email(inner, idempotency_key=idempotency_key, s=s)


# ---------- Online Timesheet App (4th channel, brief §4.2 stretch) ----------


class OnlineFormSubmit(BaseModel):
    period: str  # e.g. "June 2026"
    rows: list[dict]  # [{emp_id?, employee_name?, days_worked, ot_hours?, leave_codes?}]
    submitted_by: str | None = None
    notes: str | None = None


@app.post("/submit/{client_code}")
def submit_online_form(
    client_code: str,
    payload: OnlineFormSubmit,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    s: Session = Depends(db_session),
) -> dict:
    """4th channel — Online Timesheet App. Client pre-bound by URL path.

    Renders the form payload as a parseable email-style document so the existing
    extractor pipeline handles it without a new format-specific path."""
    client = s.get(Client, client_code)
    if not client:
        raise HTTPException(404, f"client {client_code} not found")
    lines = [
        f"Client: {client.name} ({client.code})",
        f"Period: {payload.period}",
        "",
    ]
    for r in payload.rows:
        emp = r.get("emp_id")
        name = r.get("employee_name") or ""
        days = r.get("days_worked")
        ot = r.get("ot_hours") or 0
        leave = r.get("leave_codes") or []
        leave_str = f", leave: {','.join(leave)}" if leave else ""
        prefix = f"{emp} " if emp else ""
        lines.append(f"{prefix}{name} - {days} days, {ot} OT hours{leave_str}".strip())
    if payload.notes:
        lines += ["", "Notes:", payload.notes]
    body = "\n".join(lines)
    tmp = Path(STAGING_DIR) / f"_form_{uuid.uuid4().hex}.txt"
    tmp.write_text(body, encoding="utf-8")
    doc = ingest_file(
        s,
        tmp,
        channel="online_form",
        mime="text/plain",
        uploaded_by=payload.submitted_by or "client",
        idempotency_key=idempotency_key,
    )
    from ..orchestrator import log_event

    log_event(
        s,
        payload.submitted_by or "client",
        "doc",
        doc.id,
        "online_form_submitted",
        {"client_code": client_code, "row_count": len(payload.rows)},
    )
    ts = process_doc(s, doc)
    return {
        "doc_id": doc.id,
        "timesheet_id": ts.id,
        "status": ts.status,
        "routing": ts.routing,
        "confidence": ts.confidence_calibrated,
        "client_code": client_code,
    }


class WhatsAppIntake(BaseModel):
    from_: str | None = None
    client_hint: str | None = None
    attachment_url: str | None = None
    attachment_mime: str | None = None
    message_text: str | None = None


@app.post("/intake/whatsapp")
def intake_whatsapp(
    payload: WhatsAppIntake,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    s: Session = Depends(db_session),
) -> dict:
    """Teammate's WhatsApp bridge posts here. We download the attachment (if any) or
    treat message_text as an email-shaped body, then run the pipeline."""
    import httpx

    if payload.attachment_url:
        r = httpx.get(payload.attachment_url, timeout=60.0)
        r.raise_for_status()
        ext = ".png"
        if payload.attachment_mime == "image/jpeg":
            ext = ".jpg"
        elif payload.attachment_mime == "application/pdf":
            ext = ".pdf"
        tmp = Path(STAGING_DIR) / f"_wa_{uuid.uuid4().hex}{ext}"
        tmp.write_bytes(r.content)
        mime = payload.attachment_mime
    else:
        tmp = Path(STAGING_DIR) / f"_wa_{uuid.uuid4().hex}.txt"
        tmp.write_text(payload.message_text or "", encoding="utf-8")
        mime = "text/plain"

    doc = ingest_file(
        s,
        tmp,
        channel="whatsapp",
        mime=mime,
        uploaded_by=payload.from_ or "whatsapp",
        idempotency_key=idempotency_key,
    )
    ts = process_doc(s, doc)
    return JSONResponse(
        status_code=202,
        content={
            "doc_id": doc.id,
            "timesheet_id": ts.id,
            "status": ts.status,
        },
    )


# ---------------------------------------------------------------- docs / timesheets


@app.get("/documents")
def list_docs(s: Session = Depends(db_session), limit: int = 100) -> list[dict]:
    docs = s.query(DocAsset).order_by(DocAsset.uploaded_at.desc()).limit(limit).all()
    out = []
    for d in docs:
        ts = s.query(Timesheet).filter_by(doc_id=d.id).order_by(Timesheet.created_at.desc()).first()
        out.append(
            {
                "doc_id": d.id,
                "channel": d.source_channel,
                "mime": d.mime,
                "uploaded_at": d.uploaded_at.isoformat() if d.uploaded_at else None,
                "uploaded_by": d.uploaded_by,
                "timesheet_id": ts.id if ts else None,
                "status": ts.status if ts else "ingested",
                "routing": ts.routing if ts else None,
                "confidence": ts.confidence_calibrated if ts else None,
                "client_code": ts.client_code if ts else None,
                "period": ts.period if ts else None,
            }
        )
    return out


@app.get("/documents/{doc_id}")
def get_doc(doc_id: str, s: Session = Depends(db_session)) -> dict:
    d = s.get(DocAsset, doc_id)
    if not d:
        raise HTTPException(404, "doc not found")
    ts = s.query(Timesheet).filter_by(doc_id=doc_id).order_by(Timesheet.created_at.desc()).first()
    invoices = s.query(Invoice).filter_by(timesheet_id=ts.id).all() if ts else []
    return {
        "doc": {
            "id": d.id,
            "channel": d.source_channel,
            "mime": d.mime,
            "uploaded_at": d.uploaded_at.isoformat() if d.uploaded_at else None,
            "uploaded_by": d.uploaded_by,
            "filename": Path(d.staging_path or "").name,
        },
        "timesheet": _ts_dict(ts) if ts else None,
        "invoices": [_inv_dict(i) for i in invoices],
    }


@app.get("/documents/{doc_id}/source")
def get_doc_source(doc_id: str, s: Session = Depends(db_session)):
    d = s.get(DocAsset, doc_id)
    if not d or not d.staging_path or not Path(d.staging_path).exists():
        raise HTTPException(404, "source not available")
    return FileResponse(
        d.staging_path,
        media_type=d.mime or "application/octet-stream",
        filename=Path(d.staging_path).name,
    )


class ApprovePayload(BaseModel):
    by_user: str = "finops"
    corrections: list[dict] = []


@app.post("/timesheets/{ts_id}/approve")
def approve(
    ts_id: str,
    payload: ApprovePayload,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    s: Session = Depends(db_session),
) -> dict:
    ts = s.get(Timesheet, ts_id)
    if not ts:
        raise HTTPException(404, "timesheet not found")
    if idempotency_key and s.query(Event).filter_by(idempotency_key=idempotency_key).first():
        return {"status": "duplicate", "idempotency_key": idempotency_key}
    inv = approve_timesheet(
        s, ts, payload.by_user, payload.corrections, idempotency_key=idempotency_key
    )
    return {"timesheet_id": ts.id, "status": ts.status, "invoice_id": inv.id, "amount": inv.amount}


class RejectPayload(BaseModel):
    by_user: str = "finops"
    reason: str


@app.post("/timesheets/{ts_id}/reject")
def reject(
    ts_id: str,
    payload: RejectPayload,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    s: Session = Depends(db_session),
) -> dict:
    ts = s.get(Timesheet, ts_id)
    if not ts:
        raise HTTPException(404, "timesheet not found")
    reject_timesheet(s, ts, payload.by_user, payload.reason, idempotency_key=idempotency_key)
    return {"timesheet_id": ts.id, "status": ts.status}


# ---------------------------------------------------------------- invoices


def _inv_dict(i: Invoice) -> dict:
    return {
        "id": i.id,
        "timesheet_id": i.timesheet_id,
        "client_code": i.client_code,
        "period": i.period,
        "amount": i.amount,
        "currency": i.currency,
        "status": i.status,
        "line_items": i.line_items,
        "pdf_available": bool(i.pdf_path and Path(i.pdf_path).exists()),
        "dispatched_at": i.dispatch_attempted_at.isoformat() if i.dispatch_attempted_at else None,
        # UAE Tax Invoice mandatory fields
        "invoice_sequence_no": i.invoice_sequence_no,
        "supplier_trn": i.supplier_trn,
        "customer_trn": i.customer_trn,
        "vat_rate": i.vat_rate,
        "vat_amount": i.vat_amount,
        "total_excl_vat": i.total_excl_vat,
        "total_incl_vat": i.total_incl_vat,
        "sac_code": i.sac_code,
        "place_of_supply": i.place_of_supply,
        "due_date": i.due_date,
        # client approval flow + rule provenance
        "client_approval_status": i.client_approval_status,
        "client_approval_reason": i.client_approval_reason,
        "rule_results": i.rule_results or [],
    }


def _ts_dict(t: Timesheet | None) -> dict | None:
    if not t:
        return None
    return {
        "id": t.id,
        "doc_id": t.doc_id,
        "client_code": t.client_code,
        "period": t.period,
        "status": t.status,
        "routing": t.routing,
        "confidence": t.confidence_calibrated,
        "hitl_reason": t.hitl_reason,
        "extraction": t.extraction,
        "match_result": t.match_result,
        "validations": t.validations,
        "resolved_rows": t.resolved_rows,
    }


@app.get("/invoices")
def list_invoices(
    client_code: str | None = None,
    status: str | None = None,
    timesheet_id: str | None = None,
    s: Session = Depends(db_session),
) -> list[dict]:
    q = s.query(Invoice)
    if client_code:
        q = q.filter(Invoice.client_code == client_code)
    if status:
        q = q.filter(Invoice.status == status)
    if timesheet_id:
        q = q.filter(Invoice.timesheet_id == timesheet_id)
    return [_inv_dict(i) for i in q.order_by(Invoice.created_at.desc()).all()]


@app.get("/invoices/{inv_id}")
def get_invoice(inv_id: str, s: Session = Depends(db_session)) -> dict:
    i = s.get(Invoice, inv_id)
    if not i:
        raise HTTPException(404, "invoice not found")
    return _inv_dict(i)


@app.get("/invoices/{inv_id}/pdf")
def get_invoice_pdf(inv_id: str, s: Session = Depends(db_session)):
    i = s.get(Invoice, inv_id)
    if not i or not i.pdf_path or not Path(i.pdf_path).exists():
        raise HTTPException(404, "PDF not available")
    return FileResponse(i.pdf_path, media_type="application/pdf", filename=Path(i.pdf_path).name)


@app.get("/consolidate/{client_code}/{period}.xlsx")
def get_consolidated_excel(client_code: str, period: str, s: Session = Depends(db_session)):
    """Smart Bot + SAP step ①: consolidated SAP-ready (Ramco SRP-shaped) Excel.

    Brief §4.3: 'Normalize and consolidate everything into a single ERP-uploadable
    (e.g., SAP-style) Excel format.' The columns here mirror what Ramco SRP's
    payroll/billing import expects, so the export is a one-mapping-away path
    to real SAP/Ramco integration.
    """
    from ..erp.smart_bot_sap import build_consolidated_excel

    # period may be "June%202026" or "June-2026" or "2026-06" — accept both
    period_clean = period.replace("-", " ").replace("%20", " ")
    try:
        path = build_consolidated_excel(s, client_code, period_clean)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"failed to consolidate: {e}") from e
    if not path.exists():
        raise HTTPException(404, "no consolidated workbook generated")
    return FileResponse(
        path,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename=path.name,
    )


@app.get("/payroll/sif/{client_code}/{period}.sif")
def get_wps_sif(client_code: str, period: str, s: Session = Depends(db_session)):
    """WPS SIF file ready for the bank gateway (Central Bank + MOHRE channel).

    SCR header + EDR rows per employee. Real production would submit this to
    the corporate bank's WPS API; for the demo we materialise the file so judges
    can see the compliance artifact. Filename pattern matches MOHRE spec:
    `<13-digit MOHRE employer ID>_YYYYMMDD_HHMMSS_<client>.sif`.
    """
    from ..erp.smart_bot_sap import build_wps_sif

    period_clean = period.replace("-", " ").replace("%20", " ")
    try:
        path = build_wps_sif(s, client_code, period_clean)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"failed to build SIF: {e}") from e
    if not path.exists():
        raise HTTPException(404, "no SIF generated")
    return FileResponse(path, media_type="text/plain", filename=path.name)


# ---------- /qa chat agent (brief §4.8 cross-cutting) ----------


class QAQuery(BaseModel):
    question: str
    entity_context: dict | None = None  # {"kind": "invoice|client|timesheet", "id": "..."}
    # When the asker is a Client, pass their client_code so the agent is data-isolated
    # to that client. FinOps/Finance omit it for full visibility.
    client_scope: str | None = None


@app.post("/qa")
def qa(payload: QAQuery, s: Session = Depends(db_session)) -> dict:
    """Context-aware grounded Q&A. OpenAI tool-calling, DB tools, strict citations,
    client-scoped data isolation. Swap to local model via OPENAI_BASE_URL/OPENAI_MODEL."""
    from ..qa import answer

    try:
        return answer(
            s,
            payload.question,
            payload.entity_context,
            client_scope=payload.client_scope,
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"qa agent failed: {e}") from e


@app.get("/invoices/{inv_id}/audit")
def get_invoice_audit(inv_id: str, s: Session = Depends(db_session)) -> dict:
    i = s.get(Invoice, inv_id)
    if not i:
        raise HTTPException(404, "invoice not found")
    ts = s.get(Timesheet, i.timesheet_id)
    events: list[Event] = []
    if ts and ts.doc_id:
        events += s.query(Event).filter_by(entity_id=ts.doc_id).all()
    if ts:
        events += s.query(Event).filter_by(entity_id=ts.id).all()
    events += s.query(Event).filter_by(entity_id=i.id).all()
    events.sort(key=lambda e: e.at)
    return {
        "invoice": _inv_dict(i),
        "timesheet": _ts_dict(ts),
        "events": [
            {
                "id": e.id,
                "at": e.at.isoformat(),
                "actor": e.actor,
                "kind": e.entity_kind,
                "entity_id": e.entity_id,
                "action": e.action,
                "payload": e.payload,
                "idempotency_key": e.idempotency_key,
            }
            for e in events
        ],
    }


@app.get("/invoices/{inv_id}/why")
def get_invoice_why(inv_id: str, s: Session = Depends(db_session)) -> dict:
    """Structured 'Why this invoice?' payload — rules, audit, confidence, matches."""
    audit = get_invoice_audit(inv_id, s)
    ts = audit["timesheet"]
    why: dict[str, Any] = {
        "invoice": audit["invoice"],
        "extraction": ts.get("extraction") if ts else None,
        "match_result": ts.get("match_result") if ts else None,
        "validations": ts.get("validations") if ts else [],
        "confidence_calibrated": ts.get("confidence") if ts else None,
        "routing": ts.get("routing") if ts else None,
        "events": audit["events"],
    }
    return why


class DispatchPayload(BaseModel):
    by_user: str = "finops"


@app.post("/invoices/{inv_id}/dispatch")
def dispatch(
    inv_id: str,
    payload: DispatchPayload,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    s: Session = Depends(db_session),
) -> dict:
    if not idempotency_key:
        raise HTTPException(400, "Idempotency-Key required")
    i = s.get(Invoice, inv_id)
    if not i:
        raise HTTPException(404, "invoice not found")
    # Delegate to the Rust dispatch service when configured, else inline.
    import os

    rust_url = os.getenv("RUST_DISPATCH_URL", "").rstrip("/")
    if rust_url:
        import httpx

        s.commit()  # release sqlite lock so the Rust process can write
        try:
            r = httpx.post(
                f"{rust_url}/dispatch/{inv_id}",
                json={"by_user": payload.by_user},
                headers={"Idempotency-Key": idempotency_key},
                timeout=10.0,
            )
            r.raise_for_status()
            return r.json()
        except httpx.HTTPError as e:
            raise HTTPException(502, f"rust dispatch unreachable: {e}") from e
    return dispatch_invoice(s, i, payload.by_user, idempotency_key)


# ---------------------------------------------------------------- clients / dispatch rules


@app.get("/clients")
def list_clients(s: Session = Depends(db_session)) -> list[dict]:
    return [
        {
            "code": c.code,
            "name": c.name,
            "city": c.city,
            "industry": c.industry,
            "settings": c.settings or {},
        }
        for c in s.query(Client).order_by(Client.code).all()
    ]


class NewClient(BaseModel):
    code: str
    name: str
    city: str | None = None
    industry: str | None = None
    contact_email: str | None = None
    currency: str = "AED"
    jurisdiction: str = "UAE"
    customer_trn: str | None = None
    billing_entity: str | None = None
    validation_threshold_aed: float = 50000
    dispatch_order_rule: str = "asc_by_amount"  # asc/desc_by_amount, asc/desc_by_salary, by_emp_id
    dispatch_grouping_mode: str = "by_client_period"  # none, by_client_period
    sla_days_to_invoice: int = 5
    payment_terms_days: int = 30
    watched_mailboxes: list[str] = []
    whatsapp_number: str | None = None


@app.post("/clients", status_code=201)
def create_client(
    payload: NewClient,
    by_user: str = Header(default="finops", alias="X-User"),
    s: Session = Depends(db_session),
) -> dict:
    """Onboard a new client — brief §4.1 'setup screen to onboard a client'."""
    if s.get(Client, payload.code):
        raise HTTPException(409, f"client {payload.code} already exists")
    settings = {
        "customer_trn": payload.customer_trn,
        "jurisdiction": payload.jurisdiction,
        "billing_entity": payload.billing_entity or payload.name,
        "validation_threshold_aed": payload.validation_threshold_aed,
        "dispatch_order_rule": payload.dispatch_order_rule,
        "dispatch_grouping_mode": payload.dispatch_grouping_mode,
        "sla_days_to_invoice": payload.sla_days_to_invoice,
        "payment_terms_days": payload.payment_terms_days,
        "watched_mailboxes": payload.watched_mailboxes,
        "whatsapp_number": payload.whatsapp_number,
    }
    c = Client(
        code=payload.code,
        name=payload.name,
        city=payload.city,
        industry=payload.industry,
        contact_email=payload.contact_email,
        currency_default=payload.currency,
        settings=settings,
    )
    s.add(c)
    log_event(s, by_user, "client", c.code, "client.onboarded", {"name": c.name})
    return {"code": c.code, "name": c.name, "settings": settings}


class ClientSettings(BaseModel):
    dispatch_rule: str | None = None
    threshold_aed: float | None = None
    markup_pct: float | None = None
    customer_trn: str | None = None
    jurisdiction: str | None = None
    billing_entity: str | None = None
    validation_threshold_aed: float | None = None
    dispatch_order_rule: str | None = None
    dispatch_grouping_mode: str | None = None
    sla_days_to_invoice: int | None = None
    payment_terms_days: int | None = None
    watched_mailboxes: list[str] | None = None
    whatsapp_number: str | None = None


@app.put("/clients/{code}/settings")
def update_client_settings(
    code: str,
    payload: ClientSettings,
    by_user: str = Header(default="finops", alias="X-User"),
    s: Session = Depends(db_session),
) -> dict:
    c = s.get(Client, code)
    if not c:
        raise HTTPException(404, "client not found")
    settings = dict(c.settings or {})
    for k, v in payload.model_dump(exclude_none=True).items():
        settings[k] = v
    c.settings = settings
    log_event(s, by_user, "client", code, "settings.updated", settings)
    return {"code": code, "settings": settings}


# ---------- client approval flow (brief §4.7) ----------


class ClientApprovalPayload(BaseModel):
    by_user: str = "client"
    reason: str | None = None


@app.post("/invoices/{inv_id}/client-approve")
def client_approve_invoice(
    inv_id: str,
    payload: ClientApprovalPayload,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    s: Session = Depends(db_session),
) -> dict:
    from ..invoice.fsm import InvalidTransition, set_status

    i = s.get(Invoice, inv_id)
    if not i:
        raise HTTPException(404, "invoice not found")
    if i.client_approval_status == "approved":
        return {"status": "already_approved", "invoice_id": inv_id}
    import datetime as dt

    before = {"status": i.status, "client_approval_status": i.client_approval_status}
    try:
        set_status(s, i, "client_approved")
    except InvalidTransition as e:
        raise HTTPException(409, str(e)) from e
    i.client_approval_status = "approved"
    i.client_approved_at = dt.datetime.now(dt.timezone.utc)
    after = {"status": i.status, "client_approval_status": i.client_approval_status}
    log_event(
        s,
        payload.by_user,
        "invoice",
        inv_id,
        "client_approved",
        {"invoice_sequence_no": i.invoice_sequence_no, "reason": payload.reason},
        idempotency_key=idempotency_key,
        before=before,
        after=after,
    )
    return {"status": "approved", "invoice_id": inv_id}


@app.post("/invoices/{inv_id}/client-reject")
def client_reject_invoice(
    inv_id: str,
    payload: ClientApprovalPayload,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    s: Session = Depends(db_session),
) -> dict:
    import datetime as dt

    from ..invoice.fsm import InvalidTransition, set_status

    i = s.get(Invoice, inv_id)
    if not i:
        raise HTTPException(404, "invoice not found")
    before = {"status": i.status, "client_approval_status": i.client_approval_status}
    try:
        set_status(s, i, "client_rejected")
    except InvalidTransition as e:
        raise HTTPException(409, str(e)) from e
    i.client_approval_status = "rejected"
    i.client_approval_reason = payload.reason or "no reason given"
    after = {
        "status": i.status,
        "client_approval_status": i.client_approval_status,
        "reason": i.client_approval_reason,
    }
    log_event(
        s,
        payload.by_user,
        "invoice",
        inv_id,
        "client_rejected",
        {"reason": i.client_approval_reason},
        idempotency_key=idempotency_key,
        before=before,
        after=after,
    )
    # rejection auto-opens a query thread
    q = Query(
        client_code=i.client_code,
        invoice_id=inv_id,
        subject=f"Client rejected invoice {i.invoice_sequence_no or inv_id[:8]}",
        body=payload.reason,
        raised_by=payload.by_user,
        thread=[
            {
                "by": payload.by_user,
                "role": "client",
                "body": payload.reason or "",
                "at": dt.datetime.now(dt.timezone.utc).isoformat(),
            }
        ],
    )
    s.add(q)
    return {"status": "rejected", "invoice_id": inv_id, "query_id": q.id}


# ---------- finance approval queue ----------


@app.get("/finance/queue")
def finance_queue(s: Session = Depends(db_session)) -> list[dict]:
    """Invoices over per-client validation_threshold_aed — Finance must sign off."""
    out = []
    for inv in s.query(Invoice).order_by(Invoice.created_at.desc()).limit(200).all():
        c = s.get(Client, inv.client_code)
        threshold = float((c.settings or {}).get("validation_threshold_aed", 50000)) if c else 50000
        if (inv.amount or 0) >= threshold and inv.status not in ("dispatched", "rejected"):
            out.append(
                {
                    "id": inv.id,
                    "invoice_sequence_no": inv.invoice_sequence_no,
                    "client_code": inv.client_code,
                    "client_name": c.name if c else None,
                    "period": inv.period,
                    "amount": inv.amount,
                    "total_incl_vat": inv.total_incl_vat,
                    "currency": inv.currency,
                    "status": inv.status,
                    "threshold": threshold,
                    "rule_failures": [
                        r
                        for r in (inv.rule_results or [])
                        if not r.get("passed") and r.get("severity") != "warning"
                    ],
                }
            )
    return out


@app.post("/invoices/{inv_id}/finance-approve")
def finance_approve(
    inv_id: str,
    payload: ClientApprovalPayload,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    s: Session = Depends(db_session),
) -> dict:
    from ..invoice.fsm import InvalidTransition, set_status

    i = s.get(Invoice, inv_id)
    if not i:
        raise HTTPException(404, "invoice not found")
    if i.status == "dispatched":
        return {"status": "already_dispatched", "invoice_id": inv_id}
    before = {"status": i.status}
    try:
        set_status(s, i, "finance_approved")
    except InvalidTransition as e:
        raise HTTPException(409, str(e)) from e
    after = {"status": i.status}
    log_event(
        s,
        payload.by_user,
        "invoice",
        inv_id,
        "finance_approved",
        {"invoice_sequence_no": i.invoice_sequence_no, "reason": payload.reason},
        idempotency_key=idempotency_key,
        before=before,
        after=after,
    )
    return {"status": "finance_approved", "invoice_id": inv_id}


@app.post("/invoices/{inv_id}/finance-reject")
def finance_reject(
    inv_id: str,
    payload: ClientApprovalPayload,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    s: Session = Depends(db_session),
) -> dict:
    from ..invoice.fsm import InvalidTransition, set_status

    i = s.get(Invoice, inv_id)
    if not i:
        raise HTTPException(404, "invoice not found")
    before = {"status": i.status}
    try:
        set_status(s, i, "rejected")
    except InvalidTransition as e:
        raise HTTPException(409, str(e)) from e
    after = {"status": i.status, "reason": payload.reason}
    log_event(
        s,
        payload.by_user,
        "invoice",
        inv_id,
        "finance_rejected",
        {"reason": payload.reason},
        idempotency_key=idempotency_key,
        before=before,
        after=after,
    )
    return {"status": "rejected", "invoice_id": inv_id, "reason": payload.reason}


# ---------- payment flow (brief §4.7 — client pays the invoice) ----------


class NewPayment(BaseModel):
    amount: float
    method: str = "bank_transfer"  # bank_transfer | wire | card | cheque | ach
    reference: str | None = None
    notes: str | None = None
    paid_by: str | None = None


@app.post("/invoices/{inv_id}/payments", status_code=201)
def record_payment(
    inv_id: str,
    payload: NewPayment,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    s: Session = Depends(db_session),
) -> dict:
    """Mock payment flow — same shape as a real Stripe/Tap/bank-gateway adapter
    would consume. For demo: collect method + reference + amount, log a Payment
    row, fire an audit event, surface receipt number."""
    from ..models import Payment

    i = s.get(Invoice, inv_id)
    if not i:
        raise HTTPException(404, "invoice not found")
    import datetime as dt

    receipt_no = f"RCPT-{i.client_code}-{int(dt.datetime.utcnow().timestamp())}"
    p = Payment(
        invoice_id=inv_id,
        client_code=i.client_code,
        amount=float(payload.amount),
        currency=i.currency or "AED",
        method=payload.method,
        reference=payload.reference,
        notes=payload.notes,
        paid_by=payload.paid_by or "client",
        receipt_number=receipt_no,
        status="received",
    )
    s.add(p)
    log_event(
        s,
        payload.paid_by or "client",
        "invoice",
        inv_id,
        "payment_received",
        {
            "amount": payload.amount,
            "method": payload.method,
            "reference": payload.reference,
            "receipt_number": receipt_no,
        },
        idempotency_key=idempotency_key,
        after={"payment_amount": payload.amount, "receipt": receipt_no},
    )
    return {"id": p.id, "receipt_number": receipt_no, "status": "received"}


@app.get("/invoices/{inv_id}/payments")
def list_payments(inv_id: str, s: Session = Depends(db_session)) -> list[dict]:
    from ..models import Payment

    rows = s.query(Payment).filter_by(invoice_id=inv_id).order_by(Payment.paid_at.asc()).all()
    return [
        {
            "id": p.id,
            "amount": p.amount,
            "currency": p.currency,
            "method": p.method,
            "reference": p.reference,
            "paid_at": p.paid_at.isoformat() if p.paid_at else None,
            "paid_by": p.paid_by,
            "status": p.status,
            "receipt_number": p.receipt_number,
        }
        for p in rows
    ]


# ---------- period close lock (real-product staple) ----------


@app.post("/clients/{client_code}/periods/{period}/close")
def close_period(
    client_code: str,
    period: str,
    by_user: str = Header(default="finance", alias="X-User"),
    s: Session = Depends(db_session),
) -> dict:
    """Lock a (client, period) so no new invoices can be generated for it.
    Idempotent. Unlocking is a separate explicit admin action (`/reopen`).
    """
    c = s.get(Client, client_code)
    if not c:
        raise HTTPException(404, "client not found")
    settings = dict(c.settings or {})
    closed = list(settings.get("closed_periods") or [])
    if period not in closed:
        closed.append(period)
        settings["closed_periods"] = closed
        c.settings = settings
        log_event(
            s,
            by_user,
            "client",
            client_code,
            "period.closed",
            {"period": period},
            before={"closed_periods": [p for p in closed if p != period]},
            after={"closed_periods": closed},
        )
    return {"client_code": client_code, "period": period, "closed": True}


@app.post("/clients/{client_code}/periods/{period}/reopen")
def reopen_period(
    client_code: str,
    period: str,
    by_user: str = Header(default="finance", alias="X-User"),
    reason: str | None = None,
    s: Session = Depends(db_session),
) -> dict:
    c = s.get(Client, client_code)
    if not c:
        raise HTTPException(404, "client not found")
    settings = dict(c.settings or {})
    closed = [p for p in (settings.get("closed_periods") or []) if p != period]
    settings["closed_periods"] = closed
    c.settings = settings
    log_event(
        s,
        by_user,
        "client",
        client_code,
        "period.reopened",
        {"period": period, "reason": reason},
        after={"closed_periods": closed},
    )
    return {"client_code": client_code, "period": period, "closed": False}


# ---------- audit chain verification ----------


@app.get("/audit/verify")
def verify_audit(s: Session = Depends(db_session)) -> dict:
    """Re-walk the tamper-evident hash chain and report breaks.
    A real-product use is a nightly compliance check (publish `head` to a tamper-
    resistant store like a public ledger). For the demo, judges can hit this to
    confirm 0 errors."""
    from ..audit import verify_audit_chain

    return verify_audit_chain(s)


# ---------- raise-query thread (brief §4.7) ----------


class NewQuery(BaseModel):
    invoice_id: str | None = None
    subject: str
    body: str | None = None
    raised_by: str | None = None


@app.post("/clients/{code}/queries", status_code=201)
def raise_query(
    code: str,
    payload: NewQuery,
    s: Session = Depends(db_session),
) -> dict:
    import datetime as dt

    if not s.get(Client, code):
        raise HTTPException(404, "client not found")
    q = Query(
        client_code=code,
        invoice_id=payload.invoice_id,
        subject=payload.subject,
        body=payload.body,
        raised_by=payload.raised_by or "client",
        thread=[
            {
                "by": payload.raised_by or "client",
                "role": "client",
                "body": payload.body or "",
                "at": dt.datetime.now(dt.timezone.utc).isoformat(),
            }
        ],
    )
    s.add(q)
    s.flush()
    log_event(
        s,
        payload.raised_by or "client",
        "client",
        code,
        "query.raised",
        {"query_id": q.id, "subject": payload.subject, "invoice_id": payload.invoice_id},
    )
    return {"id": q.id, "status": "open", "client_code": code}


@app.get("/clients/{code}/queries")
def list_queries(code: str, s: Session = Depends(db_session)) -> list[dict]:
    rows = s.query(Query).filter(Query.client_code == code).order_by(Query.raised_at.desc()).all()
    return [
        {
            "id": q.id,
            "subject": q.subject,
            "body": q.body,
            "status": q.status,
            "invoice_id": q.invoice_id,
            "raised_by": q.raised_by,
            "raised_at": q.raised_at.isoformat() if q.raised_at else None,
            "thread": q.thread or [],
        }
        for q in rows
    ]


class QueryReply(BaseModel):
    body: str
    by_user: str = "finops"
    close: bool = False


@app.post("/queries/{query_id}/reply")
def reply_to_query(
    query_id: str,
    payload: QueryReply,
    s: Session = Depends(db_session),
) -> dict:
    import datetime as dt

    q = s.get(Query, query_id)
    if not q:
        raise HTTPException(404, "query not found")
    thread = list(q.thread or [])
    thread.append(
        {
            "by": payload.by_user,
            "role": "finops",
            "body": payload.body,
            "at": dt.datetime.now(dt.timezone.utc).isoformat(),
        }
    )
    q.thread = thread
    if payload.close:
        q.status = "closed"
        q.answered_at = dt.datetime.now(dt.timezone.utc)
    log_event(
        s,
        payload.by_user,
        "client",
        q.client_code,
        "query.replied",
        {"query_id": q.id, "closed": payload.close},
    )
    return {"id": q.id, "status": q.status, "thread": q.thread}


# ---------- brief's 3 success-measure KPIs (§ success measures slide) ----------


@app.get("/metrics/stp")
def metric_stp(s: Session = Depends(db_session)) -> dict:
    """Straight-through processing rate — the brief's '80%+ touchless' headline."""
    rows = s.query(Timesheet).all()
    total = len(rows)
    auto = sum(1 for t in rows if t.routing == "auto")
    hitl = sum(1 for t in rows if t.routing == "hitl")
    escalate = sum(1 for t in rows if t.routing == "escalate")
    rate = (auto / total) if total else 0.0
    return {
        "total": total,
        "auto": auto,
        "hitl": hitl,
        "escalate": escalate,
        "touchless_rate": round(rate, 4),
        "target": 0.80,
    }


@app.get("/metrics/time-to-invoice")
def metric_time_to_invoice(s: Session = Depends(db_session)) -> dict:
    """Mean minutes from doc ingestion to invoice generation."""
    import datetime as dt

    invoices = s.query(Invoice).filter(Invoice.created_at.is_not(None)).all()
    deltas: list[float] = []
    for inv in invoices:
        ts = s.get(Timesheet, inv.timesheet_id) if inv.timesheet_id else None
        if not ts or not ts.created_at or not inv.created_at:
            continue
        delta = (inv.created_at - ts.created_at).total_seconds() / 60.0
        if delta >= 0:
            deltas.append(delta)
    mean_min = sum(deltas) / len(deltas) if deltas else 0.0
    return {
        "invoices": len(invoices),
        "samples": len(deltas),
        "mean_minutes": round(mean_min, 3),
        "target_max_minutes": 5.0,
    }


@app.get("/metrics/accuracy")
def metric_accuracy() -> dict:
    """Extraction accuracy from the eval harness — the brief's '99%+' target."""
    last_run = DATA_DIR / "gold" / "_last_run.json"
    if not last_run.exists():
        return {"target": 0.99, "passed": None, "macro_f1": None, "note": "no eval yet"}
    import json

    data = json.loads(last_run.read_text())
    macro = data.get("macro_f1") or {}
    overall = sum(macro.values()) / len(macro) if macro else None
    return {
        "target": 0.99,
        "macro_f1": macro,
        "overall_macro_f1": round(overall, 4) if overall is not None else None,
        "passed": data.get("passed"),
        "runnable": data.get("runnable"),
        "ece": data.get("ece"),
    }


@app.get("/metrics/headcount")
def metric_headcount(s: Session = Depends(db_session)) -> dict:
    """TASC's HC reporting KPI — count of unique billed employees per period."""
    from .. import models as m

    rows = (
        s.query(m.Invoice)
        .filter(m.Invoice.status.in_(("dispatched", "generated", "finance_approved")))
        .all()
    )
    by_period: dict[str, set] = {}
    for inv in rows:
        for li in inv.line_items or []:
            if li.get("emp_id"):
                by_period.setdefault(inv.period or "—", set()).add(li["emp_id"])
    return {
        "by_period": {p: len(emps) for p, emps in sorted(by_period.items())},
        "total_unique_emps": len({eid for emps in by_period.values() for eid in emps}),
    }


@app.get("/metrics/sla")
def metric_sla(s: Session = Depends(db_session)) -> dict:
    """SLA aging — how long is each invoice spending in each status?

    Drives the brief §4.6 'track progress' requirement + the §4.8 'within
    minutes' KPI. We compute time-in-current-status from the most recent
    status-change event for each invoice.
    """
    import datetime as dt

    invoices = s.query(Invoice).all()
    now = dt.datetime.utcnow()
    by_status: dict[str, dict] = {}
    samples: list[dict] = []
    over_sla: list[dict] = []
    for inv in invoices:
        if not inv.created_at:
            continue
        # Use the most recent transition event for this invoice, else created_at
        last_event = (
            s.query(Event)
            .filter(
                Event.entity_id == inv.id,
                Event.action.in_(
                    (
                        "generated",
                        "finance_approved",
                        "client_approved",
                        "client_rejected",
                        "finance_rejected",
                        "dispatched",
                    )
                ),
            )
            .order_by(Event.at.desc())
            .first()
        )
        since = last_event.at if last_event else inv.created_at
        age_min = (now - since).total_seconds() / 60.0
        status = inv.status
        b = by_status.setdefault(status, {"count": 0, "total_min": 0.0, "max_min": 0.0})
        b["count"] += 1
        b["total_min"] += age_min
        b["max_min"] = max(b["max_min"], age_min)
        samples.append({"id": inv.id, "status": status, "age_min": round(age_min, 2)})
        # SLA breach: pending client approval > 5 days OR finance approval > 2 days
        if status in ("generated", "pending_client_review") and age_min > 5 * 24 * 60:
            over_sla.append(
                {
                    "id": inv.id,
                    "status": status,
                    "age_min": round(age_min, 2),
                    "limit_min": 5 * 24 * 60,
                }
            )
        elif status == "finance_approved" and age_min > 2 * 24 * 60:
            over_sla.append(
                {
                    "id": inv.id,
                    "status": status,
                    "age_min": round(age_min, 2),
                    "limit_min": 2 * 24 * 60,
                }
            )

    for v in by_status.values():
        v["mean_min"] = round(v["total_min"] / v["count"], 2) if v["count"] else 0
        v["max_min"] = round(v["max_min"], 2)
        del v["total_min"]
    return {
        "by_status": by_status,
        "over_sla_count": len(over_sla),
        "over_sla": over_sla[:20],
        "checked_at": now.isoformat() + "Z",
    }


# ---------- /status + dispatch tracking ----------


@app.get("/status")
def system_status(s: Session = Depends(db_session)) -> dict:
    """Green-dot system status: api / openai / modal-ocr / rust-dispatch / db / last-eval."""
    import os

    out: dict = {"api": "ok"}
    # db
    try:
        s.query(Client).count()
        out["db"] = "ok"
    except Exception:  # noqa: BLE001
        out["db"] = "down"
    # openai
    out["openai"] = "configured" if os.getenv("OPENAI_API_KEY") else "missing_key"
    # modal-ocr
    out["modal_ocr"] = "configured" if os.getenv("GLM_OCR_API_KEY") else "missing_key"
    # rust-dispatch (best-effort, swallows errors so /status is never down)
    rust_url = os.getenv("RUST_DISPATCH_URL", "").rstrip("/")
    if rust_url:
        try:
            import httpx

            r = httpx.get(f"{rust_url}/health", timeout=1.0)
            out["rust_dispatch"] = "ok" if r.status_code == 200 else f"http_{r.status_code}"
        except Exception:  # noqa: BLE001
            out["rust_dispatch"] = "unreachable"
    else:
        out["rust_dispatch"] = "in_process"
    # last eval
    last = DATA_DIR / "gold" / "_last_run.json"
    if last.exists():
        import json

        d = json.loads(last.read_text())
        out["last_eval"] = {
            "passed": d.get("passed"),
            "runnable": d.get("runnable"),
            "macro_f1": d.get("macro_f1"),
        }
    return out


@app.get("/dispatch/tracking")
def dispatch_tracking(s: Session = Depends(db_session)) -> list[dict]:
    """Brief diagram block 'TIA Dashboard: Dispatch Tracking, Analytics & Reporting'.

    Returns dispatch queue: invoices ready to send, recently sent, with status
    + idempotency-key + outbox path."""
    rows = (
        s.query(Invoice)
        .filter(Invoice.status.in_(("generated", "finance_approved", "dispatched")))
        .order_by(Invoice.created_at.desc())
        .limit(200)
        .all()
    )
    return [
        {
            "id": inv.id,
            "invoice_sequence_no": inv.invoice_sequence_no,
            "client_code": inv.client_code,
            "period": inv.period,
            "amount": inv.amount,
            "total_incl_vat": inv.total_incl_vat,
            "status": inv.status,
            "client_approval_status": inv.client_approval_status,
            "dispatch_idempotency_key": inv.dispatch_idempotency_key,
            "dispatch_attempted_at": (
                inv.dispatch_attempted_at.isoformat() if inv.dispatch_attempted_at else None
            ),
            "confidence": next(
                (r.get("confidence") for r in (inv.line_items or []) if r.get("confidence")),
                None,
            ),
            "rule_results_failed": [
                r
                for r in (inv.rule_results or [])
                if not r.get("passed") and r.get("severity") != "warning"
            ],
        }
        for inv in rows
    ]


@app.get("/dispatch/{client_code}/queue")
def client_dispatch_queue(client_code: str, s: Session = Depends(db_session)) -> dict:
    """Per-client dispatch queue honoring `Client.settings.dispatch_order_rule` +
    `dispatch_grouping_mode` (brief §4.6: 'ordering / grouping')."""
    c = s.get(Client, client_code)
    if not c:
        raise HTTPException(404, "client not found")
    settings = c.settings or {}
    order_rule = settings.get("dispatch_order_rule", "asc_by_amount")
    grouping = settings.get("dispatch_grouping_mode", "by_client_period")

    invoices = (
        s.query(Invoice)
        .filter(
            Invoice.client_code == client_code,
            Invoice.status.in_(("generated", "finance_approved")),
        )
        .all()
    )
    # apply ordering
    if order_rule == "asc_by_amount":
        invoices.sort(key=lambda i: i.amount or 0)
    elif order_rule == "desc_by_amount":
        invoices.sort(key=lambda i: -(i.amount or 0))
    elif order_rule == "by_emp_id":
        invoices.sort(key=lambda i: (i.line_items or [{}])[0].get("emp_id") or "")
    # grouping payload
    if grouping == "by_client_period":
        grouped: dict[str, list[dict]] = {}
        for inv in invoices:
            grouped.setdefault(inv.period or "—", []).append(
                {
                    "id": inv.id,
                    "amount": inv.amount,
                    "sequence_no": inv.invoice_sequence_no,
                }
            )
        return {
            "client_code": client_code,
            "order_rule": order_rule,
            "grouping_mode": grouping,
            "groups": grouped,
        }
    return {
        "client_code": client_code,
        "order_rule": order_rule,
        "grouping_mode": grouping,
        "queue": [
            {"id": inv.id, "amount": inv.amount, "sequence_no": inv.invoice_sequence_no}
            for inv in invoices
        ],
    }


# ---------------------------------------------------------------- events / SSE


@app.get("/events/stream")
async def events_stream(s: Session = Depends(db_session)) -> StreamingResponse:
    last_id = s.query(Event).order_by(Event.at.desc()).limit(1).first()
    cursor = last_id.id if last_id else None

    async def gen():
        nonlocal cursor
        # send a hello so clients know we're alive
        yield "event: hello\ndata: {}\n\n"
        while True:
            await asyncio.sleep(1.0)
            with SessionLocal() as ses:
                q = ses.query(Event).order_by(Event.at.asc())
                if cursor:
                    last = ses.get(Event, cursor)
                    if last:
                        q = q.filter(Event.at > last.at)
                rows = q.limit(20).all()
                for ev in rows:
                    cursor = ev.id
                    payload = {
                        "id": ev.id,
                        "at": ev.at.isoformat(),
                        "actor": ev.actor,
                        "kind": ev.entity_kind,
                        "entity_id": ev.entity_id,
                        "action": ev.action,
                        "payload": ev.payload,
                    }
                    yield f"event: event\ndata: {json.dumps(payload)}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


# ---------------------------------------------------------------- eval


@app.get("/eval")
def eval_summary() -> dict:
    from ..eval.run import run_eval

    return run_eval()


@app.post("/eval/run")
def eval_run() -> dict:
    from ..eval.run import run_eval

    return run_eval(persist=True)


# ---------- /admin/demo-reset (stage demo helper) ----------


@app.post("/admin/demo-reset")
def admin_demo_reset(s: Session = Depends(db_session)) -> dict:
    """Wipe transient state (docs, timesheets, invoices, events, queries) so the
    demo can run on a clean slate without losing master data (clients/employees/
    contracts/rate_cards/SOWs/payroll). Idempotent: safe to call multiple times.
    """
    from ..models import Hypothesis, Query as QueryModel

    counts = {
        "events": s.query(Event).delete(),
        "queries": s.query(QueryModel).delete(),
        "invoices": s.query(Invoice).delete(),
        "hypotheses": s.query(Hypothesis).delete(),
        "timesheets": s.query(Timesheet).delete(),
        "docs": s.query(DocAsset).delete(),
    }
    s.commit()
    log_event(s, "admin", "system", "reset", "admin.demo_reset", counts)
    return {"status": "ok", "wiped": counts}


@app.get("/contracts/{client_code}")
def get_contract_for_client(client_code: str, s: Session = Depends(db_session)) -> dict:
    """Return the active contract for a client, including its rate cards and SOWs."""
    from ..models import Contract, RateCard, SOW

    c = (
        s.query(Contract)
        .filter(Contract.client_code == client_code, Contract.active.is_(True))
        .first()
    )
    if not c:
        raise HTTPException(404, f"no active contract for {client_code}")
    cards = (
        s.query(RateCard)
        .filter(RateCard.contract_id == c.id)
        .order_by(RateCard.regular_rate.desc())
        .all()
    )
    sows = s.query(SOW).filter(SOW.contract_id == c.id).all()
    return {
        "id": c.id,
        "client_code": c.client_code,
        "name": c.name,
        "type": c.type,
        "jurisdiction": c.jurisdiction,
        "currency": c.currency,
        "vat_rate": c.vat_rate,
        "sac_code": c.sac_code,
        "markup_pct": c.markup_pct,
        "max_ot_pct": c.max_ot_pct,
        "payment_terms_days": c.payment_terms_days,
        "billing_cadence": c.billing_cadence,
        "start_date": c.start_date,
        "end_date": c.end_date,
        "authorized_emp_count": len(c.authorized_emp_ids or []),
        "rate_cards": [
            {
                "labor_category": rc.labor_category,
                "regular_rate": rc.regular_rate,
                "ot_rate": rc.ot_rate,
                "night_rate": rc.night_rate,
                "holiday_rate": rc.holiday_rate,
            }
            for rc in cards
        ],
        "sows": [
            {
                "deliverable": sw.deliverable,
                "hours_expected": sw.hours_expected,
                "hours_consumed": sw.hours_consumed,
                "status": sw.status,
                "completed_at": sw.completed_at,
            }
            for sw in sows
        ],
    }


@app.get("/events")
def list_events(
    entity_id: str | None = None,
    limit: int = 100,
    s: Session = Depends(db_session),
) -> list[dict]:
    """Append-only audit feed. Filter by entity_id (doc/timesheet/invoice/client) when set."""
    q = s.query(Event)
    if entity_id:
        # also include doc_id and timesheet_id chains for an invoice id
        related: list[str] = [entity_id]
        inv = s.get(Invoice, entity_id)
        if inv:
            related.append(inv.timesheet_id)
            ts = s.get(Timesheet, inv.timesheet_id)
            if ts and ts.doc_id:
                related.append(ts.doc_id)
        ts = s.get(Timesheet, entity_id)
        if ts and ts.doc_id:
            related.append(ts.doc_id)
        q = q.filter(Event.entity_id.in_(set(related)))
    rows = q.order_by(Event.at.asc()).limit(limit).all()
    return [
        {
            "id": e.id,
            "at": e.at.isoformat() if e.at else None,
            "actor": e.actor,
            "kind": e.entity_kind,
            "entity_id": e.entity_id,
            "action": e.action,
            "payload": e.payload or {},
            "idempotency_key": e.idempotency_key,
        }
        for e in rows
    ]


# ─────────────────────────────────────────────────────────────────────────────
#  Real-product polish — Statement / Audit bundle / Notifications / Multi-user
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/client/{client_code}/statement")
def client_statement(
    client_code: str,
    months: int = 12,
    s: Session = Depends(db_session),
) -> dict:
    """Month-by-month statement of account — what every B2B AR portal shows.

    Aggregates invoices + payments + outstanding balance by period for the
    last `months` months.
    """
    import datetime as dt

    from ..models import Payment

    c = s.get(Client, client_code)
    if not c:
        raise HTTPException(404, "client not found")
    invoices = s.query(Invoice).filter_by(client_code=client_code).all()
    payments = s.query(Payment).filter_by(client_code=client_code).all()

    by_period: dict[str, dict] = {}
    for inv in invoices:
        p = inv.period or "—"
        b = by_period.setdefault(
            p,
            {
                "period": p,
                "invoices": 0,
                "billed_excl_vat": 0.0,
                "vat": 0.0,
                "billed_incl_vat": 0.0,
                "paid": 0.0,
                "outstanding": 0.0,
            },
        )
        b["invoices"] += 1
        b["billed_excl_vat"] += float(inv.total_excl_vat or inv.amount or 0)
        b["vat"] += float(inv.vat_amount or 0)
        b["billed_incl_vat"] += float(inv.total_incl_vat or inv.amount or 0)
    for pay in payments:
        # Match payment to the invoice's period
        inv = next((i for i in invoices if i.id == pay.invoice_id), None)
        if not inv:
            continue
        p = inv.period or "—"
        if p in by_period:
            by_period[p]["paid"] += float(pay.amount or 0)
    for b in by_period.values():
        b["outstanding"] = round(b["billed_incl_vat"] - b["paid"], 2)
        for k in ("billed_excl_vat", "vat", "billed_incl_vat", "paid"):
            b[k] = round(b[k], 2)

    rows = sorted(by_period.values(), key=lambda r: r["period"], reverse=True)[:months]
    total_billed = sum(r["billed_incl_vat"] for r in rows)
    total_paid = sum(r["paid"] for r in rows)
    return {
        "client_code": client_code,
        "client_name": c.name,
        "currency": c.currency_default or "AED",
        "generated_at": dt.datetime.utcnow().isoformat() + "Z",
        "periods": rows,
        "summary": {
            "invoices": sum(r["invoices"] for r in rows),
            "total_billed_incl_vat": round(total_billed, 2),
            "total_paid": round(total_paid, 2),
            "outstanding": round(total_billed - total_paid, 2),
        },
    }


@app.get("/client/{client_code}/audit/{quarter}.zip")
def client_audit_bundle(
    client_code: str,
    quarter: str,
    s: Session = Depends(db_session),
):
    """Compliance-grade audit pack: ZIP with the client's invoices PDF + the
    consolidated Excel + WPS SIF + events.jsonl + manifest.json with hash chain
    head + recovery instructions.

    quarter format: 'Q1-2026' / 'Q2-2026' / 'June-2026' (we accept anything; we
    filter invoices by period string contains).
    """
    import io
    import json as _json
    import zipfile

    from ..audit import verify_audit_chain
    from ..models import Payment

    c = s.get(Client, client_code)
    if not c:
        raise HTTPException(404, "client not found")
    period_token = quarter.replace("-", " ").lower()
    invoices = [
        i
        for i in s.query(Invoice).filter_by(client_code=client_code).all()
        if (i.period or "").lower().find(period_token) >= 0
        or quarter.lower() in (i.period or "").lower()
        or quarter.replace("-", " ").lower() in (i.period or "").lower()
    ]
    # if filter caught nothing, fall back to all-period for that client
    if not invoices:
        invoices = s.query(Invoice).filter_by(client_code=client_code).all()
    payments = s.query(Payment).filter_by(client_code=client_code).all()
    pay_by_inv = {}
    for p in payments:
        pay_by_inv.setdefault(p.invoice_id, []).append(p)
    related_ids: set[str] = {client_code} | {i.id for i in invoices}
    for i in invoices:
        related_ids.add(i.timesheet_id)
        ts = s.get(Timesheet, i.timesheet_id)
        if ts and ts.doc_id:
            related_ids.add(ts.doc_id)
    events = s.query(Event).filter(Event.entity_id.in_(related_ids)).order_by(Event.at.asc()).all()
    chain = verify_audit_chain(s)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        manifest = {
            "client_code": client_code,
            "client_name": c.name,
            "quarter": quarter,
            "invoice_count": len(invoices),
            "payment_count": len(payments),
            "event_count": len(events),
            "chain_head": chain["head"],
            "chain_ok": chain["ok"],
            "generated_at_utc": __import__("datetime").datetime.utcnow().isoformat() + "Z",
            "retention_class": "5yr (UAE FTA tax records) / 7yr (commercial) / 10yr (capital assets)",
            "verify_command": "POST /audit/verify on the system to re-walk the hash chain",
        }
        z.writestr("manifest.json", _json.dumps(manifest, indent=2, default=str))
        # invoices ledger
        z.writestr(
            "invoices.jsonl",
            "\n".join(_json.dumps(_inv_dict(i), default=str) for i in invoices),
        )
        # payments ledger
        z.writestr(
            "payments.jsonl",
            "\n".join(
                _json.dumps(
                    {
                        "id": p.id,
                        "invoice_id": p.invoice_id,
                        "amount": p.amount,
                        "currency": p.currency,
                        "method": p.method,
                        "reference": p.reference,
                        "paid_at": p.paid_at.isoformat() if p.paid_at else None,
                        "receipt_number": p.receipt_number,
                        "status": p.status,
                    },
                    default=str,
                )
                for p in payments
            ),
        )
        # events ledger
        z.writestr(
            "events.jsonl",
            "\n".join(
                _json.dumps(
                    {
                        "id": e.id,
                        "at": e.at.isoformat() if e.at else None,
                        "actor": e.actor,
                        "kind": e.entity_kind,
                        "entity_id": e.entity_id,
                        "action": e.action,
                        "payload": e.payload,
                        "prev_hash": e.prev_hash,
                        "hash": e.hash,
                        "before": e.before,
                        "after": e.after,
                    },
                    default=str,
                )
                for e in events
            ),
        )
        # invoice PDFs
        for inv in invoices:
            if inv.pdf_path and Path(inv.pdf_path).exists():
                z.write(inv.pdf_path, arcname=f"pdf/{inv.invoice_sequence_no or inv.id[:8]}.pdf")
    buf.seek(0)
    from fastapi.responses import StreamingResponse

    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="audit_{client_code}_{quarter}.zip"'
        },
    )


# ---------- Notifications (driven by events table) ----------


@app.get("/notifications")
def list_notifications(
    persona: str = "client",
    client_code: str | None = None,
    limit: int = 30,
    s: Session = Depends(db_session),
) -> list[dict]:
    """In-app notification feed. Filters the audit stream to things the user
    actually cares about — generated, dispatched, approval requests, query
    replies. Frontend renders these in the bell dropdown."""
    actions = {
        "client": {
            "generated",
            "client_approved",
            "client_rejected",
            "payment_received",
            "query.raised",
            "query.replied",
        },
        "finops": {
            "rules_evaluated",
            "client_rejected",
            "query.raised",
            "query.replied",
            "ingested",
        },
        "finance": {
            "generated",
            "finance_approved",
            "finance_rejected",
            "dispatched",
            "payment_received",
        },
    }
    wanted = actions.get(persona, set())
    q = s.query(Event).order_by(Event.at.desc()).limit(limit * 4)  # over-fetch for filtering
    out: list[dict] = []
    for e in q.all():
        if e.action not in wanted:
            continue
        if client_code and e.entity_kind == "invoice":
            inv = s.get(Invoice, e.entity_id)
            if not inv or inv.client_code != client_code:
                continue
        elif client_code and e.entity_kind == "client" and e.entity_id != client_code:
            continue
        out.append(
            {
                "id": e.id,
                "at": e.at.isoformat() if e.at else None,
                "actor": e.actor,
                "kind": e.entity_kind,
                "entity_id": e.entity_id,
                "action": e.action,
                "summary": (e.payload or {}).get("summary") or _notif_summary(e),
                "read": False,
            }
        )
        if len(out) >= limit:
            break
    return out


def _notif_summary(e: Event) -> str:
    a = e.action
    p = e.payload or {}
    if a == "generated":
        return f"Invoice {p.get('sequence_no', e.entity_id[:8])} generated for {p.get('client', '?')} — AED {p.get('total_incl_vat', p.get('amount', 0))}"
    if a == "client_approved":
        return f"Invoice {p.get('invoice_sequence_no', e.entity_id[:8])} approved by client"
    if a == "client_rejected":
        return f"Invoice {p.get('invoice_sequence_no', e.entity_id[:8])} rejected — reason: {p.get('reason', 'n/a')}"
    if a == "finance_approved":
        return f"Invoice {p.get('invoice_sequence_no', e.entity_id[:8])} approved by Finance"
    if a == "dispatched":
        return f"Invoice {e.entity_id[:8]} dispatched (engine: {p.get('engine', 'rust')})"
    if a == "payment_received":
        return f"Payment {p.get('receipt_number', '')}: AED {p.get('amount', 0)} via {p.get('method', '')}"
    if a == "query.raised":
        return f"Query raised: {p.get('subject', '')}"
    if a == "query.replied":
        return f"Query reply on {p.get('query_id', '')[:8]}"
    if a == "rules_evaluated":
        bf = p.get("blocking_failures", 0)
        return f"{p.get('rules_run', '?')} rules evaluated, {bf} blocking failure{'s' if bf != 1 else ''}"
    return f"{a}"


# ---------- Multi-user roles per client ----------


class ClientUser(BaseModel):
    email: str
    name: str
    role: str = "viewer"  # viewer | approver | admin


@app.put("/clients/{code}/users")
def set_client_users(
    code: str,
    users: list[ClientUser],
    by_user: str = Header(default="finops", alias="X-User"),
    s: Session = Depends(db_session),
) -> dict:
    """Manage the user roster for a client. For demo: in-memory in
    `Client.settings.users[]`. Production swap = JWT / OAuth provider integration."""
    c = s.get(Client, code)
    if not c:
        raise HTTPException(404, "client not found")
    settings = dict(c.settings or {})
    before = list(settings.get("users") or [])
    new_users = [u.model_dump() for u in users]
    settings["users"] = new_users
    c.settings = settings
    log_event(
        s,
        by_user,
        "client",
        code,
        "users.updated",
        {"count": len(new_users)},
        before={"users": before},
        after={"users": new_users},
    )
    return {"code": code, "users": new_users}


@app.get("/clients/{code}/users")
def get_client_users(code: str, s: Session = Depends(db_session)) -> list[dict]:
    c = s.get(Client, code)
    if not c:
        raise HTTPException(404, "client not found")
    return (c.settings or {}).get("users") or []

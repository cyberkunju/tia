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

from ..config import STAGING_DIR
from ..db import SessionLocal, init_db
from ..models import Client, DocAsset, Event, Invoice, Timesheet
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


@app.post("/intake/upload")
async def intake_upload(
    file: UploadFile,
    uploaded_by: str = Form("client"),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    s: Session = Depends(db_session),
) -> dict:
    raw = await file.read()
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
    client_hint: str | None = None
    uploaded_by: str = "client"


@app.post("/intake/email")
def intake_email(
    payload: EmailIntake,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    s: Session = Depends(db_session),
) -> dict:
    tmp = Path(STAGING_DIR) / f"_inbox_{uuid.uuid4().hex}.eml"
    parts = []
    if payload.subject:
        parts.append(f"Subject: {payload.subject}")
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
    ts = process_doc(s, doc)
    return {
        "doc_id": doc.id,
        "timesheet_id": ts.id,
        "status": ts.status,
        "routing": ts.routing,
        "confidence": ts.confidence_calibrated,
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
        ts = s.query(Timesheet).filter_by(doc_id=d.id).first()
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
    ts = s.query(Timesheet).filter_by(doc_id=doc_id).first()
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


class ClientSettings(BaseModel):
    dispatch_rule: str | None = None
    threshold_aed: float | None = None
    markup_pct: float | None = None


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

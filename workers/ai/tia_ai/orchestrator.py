"""Pipeline orchestrator — drives a document through the state machine.

Deterministic, idempotent, in-process. NATS JetStream is the target subject pub/sub
(see CONTRACTS §3); for the demo the orchestrator calls phases directly and the
events table is the durable log.
"""

from __future__ import annotations

import hashlib
import shutil
import uuid
from pathlib import Path

from sqlalchemy.orm import Session

from .config import STAGING_DIR
from .erp.mock import build_invoice
from .extract import extract
from .invoice.render import render_invoice
from .match.resolver import resolve
from .models import DocAsset, Event, Invoice, Timesheet


def _hash_file(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def log_event(
    session: Session,
    actor: str | None,
    kind: str,
    entity_id: str,
    action: str,
    payload: dict | None = None,
    idempotency_key: str | None = None,
) -> Event:
    """Append an audit event. Idempotent on `idempotency_key` — replays return the
    original row without raising, so the same retried HTTP request observes the
    same outcome (the prod-correct semantic for Idempotency-Key)."""
    if idempotency_key:
        existing = session.query(Event).filter_by(idempotency_key=idempotency_key).first()
        if existing:
            return existing
    ev = Event(
        actor=actor,
        entity_kind=kind,
        entity_id=entity_id,
        action=action,
        payload=payload or {},
        idempotency_key=idempotency_key,
    )
    session.add(ev)
    session.flush()
    return ev


def ingest_file(
    session: Session,
    src_path: Path,
    channel: str,
    mime: str | None = None,
    uploaded_by: str | None = None,
    idempotency_key: str | None = None,
) -> DocAsset:
    """Stage the file (NVMe staging dir) + content-hash dedupe + audit-log."""
    src_path = Path(src_path)
    content_hash = _hash_file(src_path)
    existing = session.query(DocAsset).filter_by(content_hash=content_hash).first()
    if existing:
        log_event(
            session,
            uploaded_by,
            "doc",
            existing.id,
            "ingest.dedup",
            {"channel": channel},
            idempotency_key=idempotency_key,
        )
        return existing

    doc_id = str(uuid.uuid4())
    staged = Path(STAGING_DIR) / f"{doc_id}_{src_path.name}"
    shutil.copy2(src_path, staged)
    doc = DocAsset(
        id=doc_id,
        content_hash=content_hash,
        source_channel=channel,
        mime=mime,
        staging_path=str(staged),
        uploaded_by=uploaded_by,
    )
    session.add(doc)
    session.flush()
    log_event(
        session,
        uploaded_by,
        "doc",
        doc_id,
        "ingested",
        {"channel": channel, "mime": mime, "filename": src_path.name},
        idempotency_key=idempotency_key,
    )
    return doc


def process_doc(session: Session, doc: DocAsset) -> Timesheet:
    """Run extract → resolve → validate → invoice → dispatch decision."""
    if not doc.staging_path:
        raise ValueError("doc has no staged file")
    p = Path(doc.staging_path)

    extraction = extract(p, mime=doc.mime, channel=doc.source_channel)
    log_event(
        session,
        "system",
        "doc",
        doc.id,
        "extracted",
        {
            "rows": len(extraction.rows),
            "client_hint": extraction.client_hint,
            "period": extraction.period,
        },
    )

    match = resolve(extraction, session)
    log_event(
        session,
        "system",
        "doc",
        doc.id,
        "resolved",
        {
            "matched": sum(1 for m in match.matches if m.chosen_emp_id and not m.ambiguous),
            "ambiguous": sum(1 for m in match.matches if m.ambiguous),
        },
    )

    inv = build_invoice(extraction, match, session)
    client_code = inv.get("client_code")

    ts_id = str(uuid.uuid4())
    ts = Timesheet(
        id=ts_id,
        doc_id=doc.id,
        client_code=client_code,
        period=extraction.period,
        status="validated",
        extraction=extraction.model_dump(mode="json"),
        match_result=match.model_dump(mode="json"),
        validations=inv["validations"],
        resolved_rows=inv["line_items"],
    )
    session.add(ts)
    session.flush()

    # routing decision
    ambiguous = any(m.ambiguous for m in match.matches)
    has_failed_validation = any(
        (not v["passed"]) and v.get("severity") != "warning" for v in inv["validations"]
    )
    if ambiguous:
        ts.routing = "hitl"
        ts.status = "awaiting_review"
        ts.hitl_reason = "ambiguous entity resolution"
        ts.confidence_calibrated = round(
            min((m.confidence for m in match.matches if m.ambiguous), default=0.0), 4
        )
    elif has_failed_validation:
        ts.routing = "hitl"
        ts.status = "awaiting_review"
        ts.hitl_reason = "validation failed"
        ts.confidence_calibrated = 0.5
    else:
        ts.routing = "auto"
        ts.status = "approved"
        confs = [m.confidence for m in match.matches if m.chosen_emp_id] or [0.9]
        ts.confidence_calibrated = round(sum(confs) / len(confs), 4)

    log_event(
        session,
        "system",
        "timesheet",
        ts_id,
        "routed",
        {"routing": ts.routing, "reason": ts.hitl_reason, "confidence": ts.confidence_calibrated},
    )

    # generate invoice immediately for auto-routed; HITL waits for approval
    if ts.routing == "auto":
        _generate_invoice(session, ts, inv)

    return ts


def _generate_invoice(session: Session, ts: Timesheet, inv: dict) -> Invoice:
    inv_id = str(uuid.uuid4())
    pdf = render_invoice(inv, inv_id[:8])
    invoice = Invoice(
        id=inv_id,
        timesheet_id=ts.id,
        client_code=inv["client_code"] or "UNKNOWN",
        period=inv["period"],
        amount=inv["amount"],
        currency=inv["currency"],
        line_items=inv["line_items"],
        pdf_path=pdf,
        status="generated",
    )
    session.add(invoice)
    ts.status = "invoice_generated"
    session.flush()
    log_event(
        session,
        "system",
        "invoice",
        inv_id,
        "generated",
        {"timesheet_id": ts.id, "amount": inv["amount"], "client": inv["client_code"], "pdf": pdf},
    )
    return invoice


def approve_timesheet(
    session: Session,
    ts: Timesheet,
    by_user: str,
    corrections: list[dict] | None = None,
    idempotency_key: str | None = None,
) -> Invoice:
    """HITL approve: apply corrections, regenerate invoice, mark approved."""
    if ts.status not in {"awaiting_review", "validated"}:
        raise ValueError(f"cannot approve a timesheet in status {ts.status}")

    # apply corrections to the chosen emp_ids if user resolved ambiguity
    if corrections:
        mr = ts.match_result or {}
        matches = list(mr.get("matches", []))
        for c in corrections:
            idx = int(c.get("row_idx", -1))
            chosen = c.get("chosen_emp_id")
            if 0 <= idx < len(matches) and chosen:
                matches[idx]["chosen_emp_id"] = chosen
                matches[idx]["ambiguous"] = False
                matches[idx]["confidence"] = 0.95
                matches[idx]["reason"] = f"HITL pick by {by_user}"
        mr["matches"] = matches
        ts.match_result = mr

    # rebuild invoice payload from corrected match + extraction
    from .schema import MatchResult, TimesheetExtraction

    ex = TimesheetExtraction.model_validate(ts.extraction or {})
    match = MatchResult.model_validate(ts.match_result or {})
    inv_payload = build_invoice(ex, match, session)
    invoice = _generate_invoice(session, ts, inv_payload)
    ts.status = "approved"
    ts.routing = "auto"
    log_event(
        session,
        by_user,
        "timesheet",
        ts.id,
        "approved",
        {"corrections": len(corrections or []), "invoice_id": invoice.id},
        idempotency_key=idempotency_key,
    )
    return invoice


def reject_timesheet(
    session: Session, ts: Timesheet, by_user: str, reason: str, idempotency_key: str | None = None
) -> None:
    ts.status = "rejected"
    log_event(
        session,
        by_user,
        "timesheet",
        ts.id,
        "rejected",
        {"reason": reason},
        idempotency_key=idempotency_key,
    )


def dispatch_invoice(
    session: Session, invoice: Invoice, by_user: str, idempotency_key: str
) -> dict:
    """Idempotent dispatch — keyed by client+invoice; refuses to re-fire."""
    if invoice.dispatch_idempotency_key:
        return {"status": "already_dispatched", "idempotency_key": invoice.dispatch_idempotency_key}
    invoice.dispatch_idempotency_key = idempotency_key
    invoice.status = "dispatched"
    import datetime as dt

    invoice.dispatch_attempted_at = dt.datetime.now(dt.timezone.utc)
    log_event(
        session,
        by_user,
        "invoice",
        invoice.id,
        "dispatched",
        {"channel": "mock_webhook"},
        idempotency_key=idempotency_key,
    )
    return {"status": "dispatched", "idempotency_key": idempotency_key}

"""Pipeline orchestrator - drives a document through the state machine.

Deterministic, idempotent, in-process. NATS JetStream is the target subject pub/sub
(see CONTRACTS §3); for the demo the orchestrator calls phases directly and the
events table is the durable log.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import uuid
from pathlib import Path

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .config import STAGING_DIR
from .config import TIA_AUTO_APPROVE
from .erp.mock import build_invoice
from .erp.smart_bot_sap import (
    build_consolidated_excel,
    build_wps_sif,
    process_payroll_event_payload,
)
from .extract import extract
from .invoice.render import render_invoice
from .match.resolver import resolve
from .models import DocAsset, Event, Invoice, Timesheet
from .validate.rules_v2 import (
    find_active_contract,
    has_blocking_failure,
    run_rule_engine,
)


def _hash_file(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def _event_hash(
    prev_hash: str | None,
    actor: str | None,
    kind: str,
    entity_id: str,
    action: str,
    payload: dict,
    before: dict | None,
    after: dict | None,
) -> str:
    """sha256(prev_hash || canonical_json(event_body)). Tamper-evident chain."""
    body = json.dumps(
        {
            "prev": prev_hash or "",
            "actor": actor or "",
            "kind": kind,
            "entity_id": entity_id,
            "action": action,
            "payload": payload or {},
            "before": before or None,
            "after": after or None,
        },
        sort_keys=True,
        default=str,
    ).encode()
    return hashlib.sha256(body).hexdigest()


def log_event(
    session: Session,
    actor: str | None,
    kind: str,
    entity_id: str,
    action: str,
    payload: dict | None = None,
    idempotency_key: str | None = None,
    before: dict | None = None,
    after: dict | None = None,
) -> Event:
    """Append a tamper-evident audit event.

    Each event records:
      - payload  (the action's parameters)
      - before / after  (state diff for mutations - optional but recommended)
      - prev_hash + hash  (chain - a break in the chain is detectable
        by re-walking `verify_audit_chain()` in tia_ai/audit.py)

    Idempotent on `idempotency_key`: replays return the original row.
    """
    if idempotency_key:
        existing = session.query(Event).filter_by(idempotency_key=idempotency_key).first()
        if existing:
            return existing

    # find chain tip: last event in the table (cheap on indexed PK + ordered insert)
    tip = session.query(Event).order_by(Event.at.desc()).first()
    prev_hash = tip.hash if tip else None
    payload = payload or {}
    h = _event_hash(prev_hash, actor, kind, entity_id, action, payload, before, after)

    ev = Event(
        actor=actor,
        entity_kind=kind,
        entity_id=entity_id,
        action=action,
        payload=payload,
        idempotency_key=idempotency_key,
        prev_hash=prev_hash,
        hash=h,
        before=before,
        after=after,
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
    parent_doc_id: str | None = None,
    meta: dict | None = None,
) -> DocAsset:
    """Stage the file (NVMe staging dir) + content-hash dedupe + audit-log.

    `parent_doc_id` links an attachment back to its parent email DocAsset
    (used by the E3 .eml attachment extractor). `meta` is opaque per-channel
    metadata (for email: from_addr, message_id, subject, etc.) stored on the
    DocAsset so the email reply path can thread back without re-parsing."""
    src_path = Path(src_path)
    content_hash = _hash_file(src_path)

    def _dedup_hit(existing: DocAsset) -> DocAsset:
        # Same content already ingested. Merge fresh per-channel meta (e.g. same
        # .eml re-delivered via IMAP) so the latest from_addr / message_id wins,
        # then audit-log the dedup so the chain still records the re-delivery.
        if meta:
            merged = dict(existing.meta or {})
            merged.update(meta)
            existing.meta = merged
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

    existing = (
        session.query(DocAsset)
        .filter_by(content_hash=content_hash, source_channel=channel, uploaded_by=uploaded_by)
        .first()
    )
    if existing:
        return _dedup_hit(existing)

    doc_id = str(uuid.uuid4())
    staged = Path(STAGING_DIR) / f"{doc_id}_{src_path.name}"
    shutil.copy2(src_path, staged)
    doc = DocAsset(
        id=doc_id,
        content_hash=content_hash,
        source_channel=channel,
        mime=mime,
        staging_path=str(staged),
        filename=src_path.name,
        uploaded_by=uploaded_by,
        parent_doc_id=parent_doc_id,
        meta=meta or {},
    )
    # SAVEPOINT around the insert: we run 2 uvicorn workers and the Zoho poller
    # retries UIDs, so two requests can both pass the dedup SELECT above and then
    # race to INSERT the same content_hash. The unique index lets exactly one win;
    # the loser's IntegrityError rolls back only to this savepoint (the outer
    # request transaction stays usable) and we treat it as a dedup hit. This makes
    # ingest idempotent under concurrency instead of 500-ing / silently dropping
    # the background WhatsApp task.
    try:
        with session.begin_nested():
            session.add(doc)
            session.flush()
    except IntegrityError:
        staged.unlink(missing_ok=True)  # orphan copy from the lost race
        winner = (
            session.query(DocAsset)
            .filter_by(content_hash=content_hash, source_channel=channel, uploaded_by=uploaded_by)
            .one()
        )
        return _dedup_hit(winner)

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


def process_doc(session: Session, doc: DocAsset, client_hint: str | None = None) -> Timesheet:
    """Run extract → resolve → validate → invoice → dispatch decision.

    `client_hint` (a client_code) binds the document to a known client when the
    source channel identifies the sender — e.g. a WhatsApp submission from a phone
    registered to a client. It only fills in a client the document itself didn't
    specify, and it scopes entity resolution to that client (disambiguating
    cross-client names like "Aisha Al Zaabi").
    """
    if not doc.staging_path:
        raise ValueError("doc has no staged file")
    p = Path(doc.staging_path)

    extraction = extract(p, mime=doc.mime, channel=doc.source_channel, filename=doc.filename)
    if client_hint and not extraction.client_code:
        extraction.client_code = client_hint
        log_event(
            session,
            "system",
            "doc",
            doc.id,
            "client_bound",
            {"client_code": client_hint, "via": doc.source_channel},
        )

    # When this attachment came from an email and the OCR/vision extractor
    # didn't pull period / client_hint, fall back to the email body text
    # (forwarded by the Zoho poller in `DocAsset.meta["email_body"]`). OCR
    # always wins — we only fill nulls.
    body_ctx = (doc.meta or {}).get("email_body")
    if body_ctx and (not extraction.client_hint or not extraction.period):
        try:
            from .extract.email import extract_email

            body_extract = extract_email(body_ctx)
            if not extraction.client_hint and body_extract.client_hint:
                extraction.client_hint = body_extract.client_hint
            if not extraction.period and body_extract.period:
                extraction.period = body_extract.period
        except Exception:  # noqa: BLE001
            # Body parsing is best-effort context — never block the main pipeline.
            pass

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

    # OCR engines misread the client code's digits (e.g. Mistral reads the printed
    # "CL001" as "CLO01"). Snap it back onto a real client code BEFORE resolution and
    # the contract lookup, so a clean sheet isn't forced to review by a phantom
    # "unknown client / rule R0" failure. No-op when the code is already valid.
    if extraction.client_code:
        from .match.resolver import canonical_client_code

        corrected = canonical_client_code(extraction.client_code, session)
        if corrected != extraction.client_code:
            log_event(
                session,
                "system",
                "doc",
                doc.id,
                "client_code_normalized",
                {"from": extraction.client_code, "to": corrected},
            )
            extraction.client_code = corrected

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

    # ---- BTP-style contract-bound rule engine (brief §4.5) ----
    contract = find_active_contract(session, client_code)
    # Enrich invoice payload with VAT fields BEFORE rule evaluation so R7 (vat_calc)
    # sees the same numbers the PDF will print.
    if contract is not None:
        excl = float(inv.get("amount") or 0)
        vat_rate = float(contract.vat_rate or 0.05)
        vat_amount = round(excl * vat_rate, 2)
        inv["vat_rate"] = vat_rate
        inv["vat_amount"] = vat_amount
        inv["total_excl_vat"] = excl
        inv["total_incl_vat"] = round(excl + vat_amount, 2)
    rule_results = run_rule_engine(
        inv,
        contract,
        session,
        ctx={"signed_by": extraction.signed_by, "period": extraction.period},
    )
    rule_blocked = has_blocking_failure(rule_results)
    log_event(
        session,
        "system",
        "doc",
        doc.id,
        "rules_evaluated",
        {
            "contract_id": contract.id if contract else None,
            "rules_run": len({r["rule_id"] for r in rule_results}),
            "blocking_failures": sum(
                1 for r in rule_results if not r["passed"] and r.get("severity") != "warning"
            ),
            "warnings": sum(1 for r in rule_results if r.get("severity") == "warning"),
        },
    )

    ts_id = str(uuid.uuid4())
    ts = Timesheet(
        id=ts_id,
        doc_id=doc.id,
        client_code=client_code,
        period=extraction.period,
        status="validated",
        extraction=extraction.model_dump(mode="json"),
        match_result=match.model_dump(mode="json"),
        validations=inv["validations"]
        + [
            {
                "rule_id": r["rule_id"],
                "rule_name": r["rule_name"],
                "passed": r["passed"],
                "severity": r["severity"],
                "message": r.get("message", ""),
                "emp_id": r.get("emp_id"),
                "line_idx": r.get("line_idx"),
            }
            for r in rule_results
        ],
        resolved_rows=inv["line_items"],
    )
    session.add(ts)
    session.flush()

    # routing decision
    ambiguous = any(m.ambiguous for m in match.matches)
    has_failed_validation = any(
        (not v["passed"]) and v.get("severity") != "warning" for v in inv["validations"]
    )
    no_rows = len(extraction.rows) == 0
    if no_rows:
        ts.routing = "escalate"
        ts.status = "awaiting_review"
        ts.hitl_reason = "no rows extracted from document"
        ts.confidence_calibrated = 0.0
    elif ambiguous:
        ts.routing = "hitl"
        ts.status = "awaiting_review"
        # surface the specific reason(s) — e.g. an Emp ID↔name identity mismatch —
        # so FinOps and the chat agent see exactly why, not a generic label.
        amb_reasons = [m.reason for m in match.matches if m.ambiguous and m.reason]
        ts.hitl_reason = "; ".join(dict.fromkeys(amb_reasons)) or "ambiguous entity resolution"
        ts.confidence_calibrated = round(
            min((m.confidence for m in match.matches if m.ambiguous), default=0.0), 4
        )
    elif rule_blocked:
        # BTP-style rule failure → HITL with rule_id surfaced for the chat agent
        failed_ids = sorted(
            {
                r["rule_id"]
                for r in rule_results
                if not r["passed"] and r.get("severity") != "warning"
            }
        )
        ts.routing = "hitl"
        ts.status = "awaiting_review"
        ts.hitl_reason = f"contract rule(s) failed: {', '.join(failed_ids)}"
        ts.confidence_calibrated = 0.6
    elif has_failed_validation:
        ts.routing = "hitl"
        ts.status = "awaiting_review"
        ts.hitl_reason = "validation failed"
        ts.confidence_calibrated = 0.5
    else:
        confs = [m.confidence for m in match.matches if m.chosen_emp_id] or [0.9]
        conf = round(sum(confs) / len(confs), 4)
        if TIA_AUTO_APPROVE:
            ts.routing = "auto"
            ts.status = "approved"
            ts.confidence_calibrated = conf
        else:
            # Auto-approval disabled (demo/operational policy): a clean timesheet
            # still requires an explicit human approve/reject in the web console
            # before an invoice is generated and dispatched.
            ts.routing = "hitl"
            ts.status = "awaiting_review"
            ts.hitl_reason = "manual approval required (auto-approval disabled)"
            ts.confidence_calibrated = conf

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
        _generate_invoice(session, ts, inv, rule_results=rule_results, contract=contract)

    return ts


def _generate_invoice(
    session: Session,
    ts: Timesheet,
    inv: dict,
    rule_results: list | None = None,
    contract=None,
) -> Invoice:
    inv_id = str(uuid.uuid4())
    # populate brief-required UAE tax invoice fields
    from .models import Client

    client = session.get(Client, inv["client_code"]) if inv.get("client_code") else None
    customer_trn = (client.settings or {}).get("customer_trn") if client else None
    vat_rate = float(contract.vat_rate) if contract else 0.05
    excl = float(inv["amount"] or 0)
    vat_amount = round(excl * vat_rate, 2)
    incl = round(excl + vat_amount, 2)
    sac_code = contract.sac_code if contract else None
    place_of_supply = ((contract.extra or {}).get("place_of_supply") if contract else None) or "UAE"
    # sequential invoice number per period
    seq_count = (
        session.query(Invoice).filter(Invoice.client_code == inv["client_code"]).count()
    ) + 1
    period_for_seq = (inv.get("period") or "0000-00").replace(" ", "").upper()
    sequence_no = f"TIA-{inv['client_code'] or 'NA'}-{period_for_seq}-{seq_count:04d}"

    # Smart Bot + SAP step ① - consolidated SAP-ready Excel
    # Smart Bot + SAP step ② - process payroll (visible event)
    # (step ③ "generate invoices" is what this very function does)
    smart_bot_artifacts: dict = {}
    if inv.get("client_code") and inv.get("period"):
        try:
            consolidated = build_consolidated_excel(session, inv["client_code"], inv["period"])
            sif = build_wps_sif(session, inv["client_code"], inv["period"])
            payload = process_payroll_event_payload(
                consolidated, sif, len(inv.get("line_items") or [])
            )
            log_event(
                session, "smart_bot_sap", "invoice", inv_id, "payroll_processed_by_sap", payload
            )
            smart_bot_artifacts = {
                "consolidated_excel": str(consolidated),
                "wps_sif": str(sif),
            }
        except Exception as e:  # noqa: BLE001
            # never block invoice gen on artifact gen
            log_event(
                session,
                "smart_bot_sap",
                "invoice",
                inv_id,
                "smart_bot_sap.skipped",
                {"reason": str(e)[:200]},
            )

    # inv payload for Typst - extend with tax fields
    inv_for_pdf = {
        **inv,
        "supplier_trn": "100123456700003",
        "customer_trn": customer_trn,
        "vat_rate": vat_rate,
        "vat_amount": vat_amount,
        "total_excl_vat": excl,
        "total_incl_vat": incl,
        "sac_code": sac_code,
        "place_of_supply": place_of_supply,
        "invoice_sequence_no": sequence_no,
    }
    pdf = render_invoice(inv_for_pdf, inv_id[:8])

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
        invoice_sequence_no=sequence_no,
        supplier_trn="100123456700003",
        customer_trn=customer_trn,
        vat_rate=vat_rate,
        vat_amount=vat_amount,
        total_excl_vat=excl,
        total_incl_vat=incl,
        sac_code=sac_code,
        place_of_supply=place_of_supply,
        contract_id=contract.id if contract else None,
        client_approval_status="pending" if (inv.get("client_code") or "") else None,
        rule_results=[dict(r) for r in (rule_results or [])],
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
        {
            "timesheet_id": ts.id,
            "amount": inv["amount"],
            "vat_amount": vat_amount,
            "total_incl_vat": incl,
            "client": inv["client_code"],
            "sequence_no": sequence_no,
            "pdf": pdf,
            **smart_bot_artifacts,
        },
    )

    # ── Auto-dispatch (Option B: re-use validation_threshold_aed) ─────────
    # Decision: amount ≤ threshold AND all blocking rules passed AND R14 didn't
    # fire (period not closed). Skip if Finance approval is intentionally
    # required (over-threshold case routes there instead).
    _maybe_auto_dispatch(session, invoice, client, rule_results or [])
    return invoice


def _maybe_auto_dispatch(session, invoice, client, rule_results: list) -> None:
    """Tolerance-based touchless dispatch.

    Lives here (not in the dispatch endpoint) because every channel funnels
    through `_generate_invoice` - upload, email, mailbox-webhook, online form,
    Zoho IMAP poller. One hook → universal touchless behaviour.
    """
    if invoice.status != "generated":
        return
    threshold = 50000.0
    if client and (client.settings or {}).get("validation_threshold_aed") is not None:
        try:
            threshold = float(client.settings["validation_threshold_aed"])
        except (TypeError, ValueError):
            threshold = 50000.0

    if (invoice.amount or 0) > threshold:
        return  # Finance approval queue takes it from here

    passed_ids: list[str] = []
    blocking_failures: list[str] = []
    warned_ids: list[str] = []
    for r in rule_results:
        rid = r.get("rule_id") or r.get("rule")
        if not rid:
            continue
        if r.get("passed"):
            passed_ids.append(rid)
        elif r.get("severity") == "warning":
            warned_ids.append(rid)
        else:
            blocking_failures.append(rid)

    if blocking_failures:
        return  # any blocking failure → HITL

    # all clear → auto-dispatch
    import datetime as dt
    import os

    from .invoice.fsm import set_status

    try:
        set_status(session, invoice, "client_approved")
    except Exception:  # noqa: BLE001
        return  # FSM blocked it → defer to manual queue

    dispatch_key = f"auto:{invoice.id}"
    rust_url = os.getenv("RUST_DISPATCH_URL", "").rstrip("/")
    engine = "in_process"

    if rust_url:
        try:
            import httpx

            session.commit()  # release sqlite lock so the Rust process can write
            r = httpx.post(
                f"{rust_url}/dispatch/{invoice.id}",
                json={"by_user": "system"},
                headers={"Idempotency-Key": dispatch_key},
                timeout=10.0,
            )
            r.raise_for_status()
            engine = "rust"
        except Exception as e:  # noqa: BLE001
            log_event(
                session,
                "system",
                "invoice",
                invoice.id,
                "auto_dispatch_skipped",
                {
                    "reason": f"rust unreachable: {e}",
                    "threshold": threshold,
                    "amount": invoice.amount,
                },
            )
            return
    else:
        # in-process fallback: same as the manual dispatch endpoint's fallback path
        invoice.dispatch_idempotency_key = dispatch_key
        invoice.dispatch_attempted_at = dt.datetime.now(dt.timezone.utc)
        try:
            set_status(session, invoice, "dispatched")
        except Exception:  # noqa: BLE001
            return

    log_event(
        session,
        "system",
        "invoice",
        invoice.id,
        "auto_dispatched_within_tolerance",
        {
            "amount": invoice.amount,
            "threshold": threshold,
            "currency": invoice.currency,
            "rules_passed_count": len(passed_ids),
            "rules_warned_count": len(warned_ids),
            "rules_passed": sorted(passed_ids),
            "decision": (
                f"amount {invoice.amount:.2f} ≤ threshold {threshold:.2f}; "
                f"{len(passed_ids)} blocking rules passed"
            ),
            "engine": engine,
            "idempotency_key": dispatch_key,
        },
        before={"status": "generated"},
        after={
            "status": invoice.status,
            "dispatch_attempted_at": (
                invoice.dispatch_attempted_at.isoformat() if invoice.dispatch_attempted_at else None
            ),
        },
    )

    # Close the email loop: if the source timesheet came via email, ship the
    # rendered invoice PDF back to the original sender. send_invoice_email is
    # a no-op (with audit reason) for non-email sources / missing from_addr /
    # SMTP not configured — so this is safe on every channel.
    try:
        from .mailbox.sender import send_invoice_email

        send_invoice_email(session, invoice, by_user="system")
    except Exception as e:  # noqa: BLE001
        log_event(
            session,
            "system",
            "invoice",
            invoice.id,
            "email.invoice_send_failed",
            {"reason": str(e)[:200]},
        )


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
    """Idempotent dispatch - keyed by client+invoice; refuses to re-fire."""
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
    # Close the email loop on the in-process dispatch fallback too.
    try:
        from .mailbox.sender import send_invoice_email

        send_invoice_email(session, invoice, by_user=by_user)
    except Exception as e:  # noqa: BLE001
        log_event(
            session,
            by_user,
            "invoice",
            invoice.id,
            "email.invoice_send_failed",
            {"reason": str(e)[:200]},
        )
    return {"status": "dispatched", "idempotency_key": idempotency_key}

"""SQLAlchemy ORM models. Portable across SQLite (dev) and PostgreSQL 18 (prod).

Append-only `events` is the audit spine; `idempotency_key` is unique so external
side-effects can be replay-guarded.
"""

from __future__ import annotations

import datetime as dt
import uuid

from sqlalchemy import (
    JSON,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


class Base(DeclarativeBase):
    pass


# --------------------------- master data ---------------------------------


class Client(Base):
    __tablename__ = "clients"
    code: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    city: Mapped[str | None] = mapped_column(String, nullable=True)
    industry: Mapped[str | None] = mapped_column(String, nullable=True)
    contact_email: Mapped[str | None] = mapped_column(String, nullable=True)
    status: Mapped[str] = mapped_column(String, default="Active")
    currency_default: Mapped[str] = mapped_column(String, default="AED")
    # per-client config (module 4.1): dispatch_rule, threshold_aed, approval_matrix
    settings: Mapped[dict] = mapped_column(JSON, default=dict)


class Employee(Base):
    __tablename__ = "employees"
    emp_id: Mapped[str] = mapped_column(String, primary_key=True)
    full_name: Mapped[str] = mapped_column(String, index=True)
    first_name: Mapped[str | None] = mapped_column(String, nullable=True)
    last_name: Mapped[str | None] = mapped_column(String, nullable=True)
    email: Mapped[str | None] = mapped_column(String, index=True, nullable=True)
    client_code: Mapped[str] = mapped_column(ForeignKey("clients.code"), index=True)
    client_name: Mapped[str | None] = mapped_column(String, nullable=True)
    job_title: Mapped[str | None] = mapped_column(String, nullable=True)
    department: Mapped[str | None] = mapped_column(String, nullable=True)
    nationality: Mapped[str | None] = mapped_column(String, nullable=True)
    date_of_joining: Mapped[str | None] = mapped_column(String, nullable=True)
    status: Mapped[str] = mapped_column(String, default="Active")
    iban: Mapped[str | None] = mapped_column(String, nullable=True)
    basic: Mapped[float] = mapped_column(Float, default=0)
    housing: Mapped[float] = mapped_column(Float, default=0)
    transport: Mapped[float] = mapped_column(Float, default=0)
    food: Mapped[float] = mapped_column(Float, default=0)
    phone: Mapped[float] = mapped_column(Float, default=0)
    total_ctc: Mapped[float] = mapped_column(Float, default=0)


class Payroll(Base):
    __tablename__ = "payroll"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    emp_id: Mapped[str] = mapped_column(ForeignKey("employees.emp_id"), index=True)
    employee_name: Mapped[str | None] = mapped_column(String, nullable=True)
    client_code: Mapped[str] = mapped_column(String, index=True)
    period: Mapped[str] = mapped_column(String, index=True)  # e.g. "June 2026"
    basic: Mapped[float] = mapped_column(Float, default=0)
    housing: Mapped[float] = mapped_column(Float, default=0)
    transport: Mapped[float] = mapped_column(Float, default=0)
    food: Mapped[float] = mapped_column(Float, default=0)
    phone: Mapped[float] = mapped_column(Float, default=0)
    gross: Mapped[float] = mapped_column(Float, default=0)
    ot_hours: Mapped[float] = mapped_column(Float, default=0)
    ot_amount: Mapped[float] = mapped_column(Float, default=0)
    deductions: Mapped[float] = mapped_column(Float, default=0)
    net_pay: Mapped[float] = mapped_column(Float, default=0)
    currency: Mapped[str] = mapped_column(String, default="AED")
    working_days: Mapped[int] = mapped_column(Integer, default=0)


# --------------------------- operational ---------------------------------


class DocAsset(Base):
    __tablename__ = "doc_assets"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    content_hash: Mapped[str] = mapped_column(String, unique=True, index=True)
    phash: Mapped[str | None] = mapped_column(String, nullable=True)
    source_channel: Mapped[str] = mapped_column(String)  # upload|email|whatsapp
    mime: Mapped[str | None] = mapped_column(String, nullable=True)
    staging_path: Mapped[str | None] = mapped_column(String, nullable=True)
    uploaded_by: Mapped[str | None] = mapped_column(String, nullable=True)
    uploaded_at: Mapped[dt.datetime] = mapped_column(default=_now)
    doc_class: Mapped[str | None] = mapped_column(String, nullable=True)
    quality_score: Mapped[float | None] = mapped_column(Float, nullable=True)


class Timesheet(Base):
    __tablename__ = "timesheets"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    doc_id: Mapped[str | None] = mapped_column(ForeignKey("doc_assets.id"), nullable=True)
    client_code: Mapped[str | None] = mapped_column(String, nullable=True)
    period: Mapped[str | None] = mapped_column(String, nullable=True)
    status: Mapped[str] = mapped_column(String, default="ingested", index=True)
    routing: Mapped[str | None] = mapped_column(String, nullable=True)
    confidence_calibrated: Mapped[float | None] = mapped_column(Float, nullable=True)
    hitl_reason: Mapped[str | None] = mapped_column(String, nullable=True)
    extraction: Mapped[dict] = mapped_column(JSON, default=dict)  # TimesheetExtraction
    resolved_rows: Mapped[list] = mapped_column(JSON, default=list)
    validations: Mapped[list] = mapped_column(JSON, default=list)
    match_result: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[dt.datetime] = mapped_column(default=_now)

    hypotheses: Mapped[list[Hypothesis]] = relationship(back_populates="timesheet")


class Hypothesis(Base):
    __tablename__ = "hypotheses"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    timesheet_id: Mapped[str] = mapped_column(ForeignKey("timesheets.id"), index=True)
    field_name: Mapped[str] = mapped_column(String)
    value: Mapped[str | None] = mapped_column(Text, nullable=True)
    bbox: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    source_block_id: Mapped[str | None] = mapped_column(String, nullable=True)
    raw_confidence: Mapped[float] = mapped_column(Float, default=1.0)
    signals: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String, default="extracted")

    timesheet: Mapped[Timesheet] = relationship(back_populates="hypotheses")


class Invoice(Base):
    __tablename__ = "invoices"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    timesheet_id: Mapped[str] = mapped_column(ForeignKey("timesheets.id"), index=True)
    client_code: Mapped[str] = mapped_column(String, index=True)
    period: Mapped[str | None] = mapped_column(String, nullable=True)
    amount: Mapped[float] = mapped_column(Float, default=0)
    currency: Mapped[str] = mapped_column(String, default="AED")
    line_items: Mapped[list] = mapped_column(JSON, default=list)
    pdf_path: Mapped[str | None] = mapped_column(String, nullable=True)
    status: Mapped[str] = mapped_column(String, default="generated", index=True)
    dispatch_idempotency_key: Mapped[str | None] = mapped_column(String, unique=True, nullable=True)
    dispatch_attempted_at: Mapped[dt.datetime | None] = mapped_column(nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(default=_now)
    # UAE Federal Tax Authority requirements
    invoice_sequence_no: Mapped[str | None] = mapped_column(String, index=True, nullable=True)
    supplier_trn: Mapped[str | None] = mapped_column(String, nullable=True)
    customer_trn: Mapped[str | None] = mapped_column(String, nullable=True)
    vat_rate: Mapped[float] = mapped_column(Float, default=0.05)
    vat_amount: Mapped[float] = mapped_column(Float, default=0)
    total_excl_vat: Mapped[float] = mapped_column(Float, default=0)
    total_incl_vat: Mapped[float] = mapped_column(Float, default=0)
    sac_code: Mapped[str | None] = mapped_column(String, nullable=True)  # India only
    place_of_supply: Mapped[str | None] = mapped_column(String, nullable=True)
    due_date: Mapped[str | None] = mapped_column(String, nullable=True)
    contract_id: Mapped[str | None] = mapped_column(
        ForeignKey("contracts.id"), index=True, nullable=True
    )
    # client-approval flow (brief §4.7)
    client_approval_status: Mapped[str | None] = mapped_column(
        String, nullable=True
    )  # pending|approved|rejected
    client_approved_at: Mapped[dt.datetime | None] = mapped_column(nullable=True)
    client_approval_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    # validation provenance — list of {rule_id, passed, expected, actual, severity}
    rule_results: Mapped[list] = mapped_column(JSON, default=list)


# --------------------------- contracts (BTP-style validation profile) -------


class Contract(Base):
    """Per-client × period contract — the source of truth for billing rules.

    Mentor's key insight (brief §4.5 calls it a "BTP-style configurable rule set"):
    the invoice must reconcile against the *contract*, not just the timesheet.
    """

    __tablename__ = "contracts"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    client_code: Mapped[str] = mapped_column(ForeignKey("clients.code"), index=True)
    name: Mapped[str] = mapped_column(String)  # human label
    type: Mapped[str] = mapped_column(String, default="TIME_AND_MATERIALS")
    # TIME_AND_MATERIALS | FIXED_SCOPE | RETAINER
    start_date: Mapped[str] = mapped_column(String)  # YYYY-MM-DD
    end_date: Mapped[str | None] = mapped_column(String, nullable=True)
    jurisdiction: Mapped[str] = mapped_column(String, default="UAE")  # UAE|KSA|IN
    currency: Mapped[str] = mapped_column(String, default="AED")
    vat_rate: Mapped[float] = mapped_column(Float, default=0.05)  # 5% UAE, 15% KSA, 18% IN
    sac_code: Mapped[str | None] = mapped_column(String, nullable=True)  # 998513 for IN
    markup_pct: Mapped[float] = mapped_column(Float, default=0.20)  # 20% over employee cost
    max_ot_pct: Mapped[float] = mapped_column(Float, default=0.20)  # OT cap
    payment_terms_days: Mapped[int] = mapped_column(Integer, default=30)
    billing_cadence: Mapped[str] = mapped_column(String, default="MONTHLY")
    approver_name: Mapped[str | None] = mapped_column(String, nullable=True)
    approver_email: Mapped[str | None] = mapped_column(String, nullable=True)
    # roster of authorized emp_ids (subset of Employees.emp_id under this client)
    authorized_emp_ids: Mapped[list] = mapped_column(JSON, default=list)
    # free-form extra params used by BTP-style rules
    extra: Mapped[dict] = mapped_column(JSON, default=dict)
    active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[dt.datetime] = mapped_column(default=_now)


class RateCard(Base):
    """Billing rate per labor category for a given contract.

    Drives rule R2 (rate_compliance_per_category).
    """

    __tablename__ = "rate_cards"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    contract_id: Mapped[str] = mapped_column(ForeignKey("contracts.id"), index=True)
    labor_category: Mapped[str] = mapped_column(String)
    # e.g. "Software Engineer", "HR Manager", "Operations Manager"
    regular_rate: Mapped[float] = mapped_column(Float, default=0)  # AED/hr
    ot_rate: Mapped[float] = mapped_column(Float, default=0)  # 1.25x basic
    night_rate: Mapped[float] = mapped_column(Float, default=0)  # 1.5x basic
    weekend_rate: Mapped[float] = mapped_column(Float, default=0)
    holiday_rate: Mapped[float] = mapped_column(Float, default=0)


class SOW(Base):
    """Statement of Work — drives rule R5 (sow_hours_not_exceeded).

    For FIXED_SCOPE contracts the SOW caps total hours per deliverable. If a worker
    completes the deliverable early but a timesheet keeps charging hours, R5 fires.
    """

    __tablename__ = "sows"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    contract_id: Mapped[str] = mapped_column(ForeignKey("contracts.id"), index=True)
    deliverable: Mapped[str] = mapped_column(String)
    hours_expected: Mapped[float] = mapped_column(Float, default=0)
    hours_consumed: Mapped[float] = mapped_column(Float, default=0)
    status: Mapped[str] = mapped_column(String, default="OPEN")  # OPEN|COMPLETED|CANCELLED
    completed_at: Mapped[str | None] = mapped_column(String, nullable=True)


# --------------------------- queries / threads ---------------------------


class Query(Base):
    """Client-raised query (brief §4.7 'raise queries for FinOps to answer')."""

    __tablename__ = "queries"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    client_code: Mapped[str] = mapped_column(ForeignKey("clients.code"), index=True)
    invoice_id: Mapped[str | None] = mapped_column(String, nullable=True)
    subject: Mapped[str] = mapped_column(String)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String, default="open")  # open|answered|closed
    raised_by: Mapped[str | None] = mapped_column(String, nullable=True)
    raised_at: Mapped[dt.datetime] = mapped_column(default=_now)
    answered_at: Mapped[dt.datetime | None] = mapped_column(nullable=True)
    # message thread: list of {at, by, role, body}
    thread: Mapped[list] = mapped_column(JSON, default=list)


# --------------------------- payments (brief §4.7 client pays the invoice) -----


class Payment(Base):
    """Client payment against an invoice.

    Mock for the demo (no real Stripe/Tap/bank gateway in scope); the schema
    matches what a real production setup would carry — method, reference,
    amount, currency, reconciliation status — so the path to real payment
    is a one-adapter swap (lettre/stripe/tap-payments)."""

    __tablename__ = "payments"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    invoice_id: Mapped[str] = mapped_column(ForeignKey("invoices.id"), index=True)
    client_code: Mapped[str] = mapped_column(ForeignKey("clients.code"), index=True)
    amount: Mapped[float] = mapped_column(Float, default=0)
    currency: Mapped[str] = mapped_column(String, default="AED")
    method: Mapped[str] = mapped_column(
        String, default="bank_transfer"
    )  # bank_transfer|wire|card|cheque|ach
    reference: Mapped[str | None] = mapped_column(String, nullable=True)  # bank ref, last-4, etc
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    paid_by: Mapped[str | None] = mapped_column(String, nullable=True)
    paid_at: Mapped[dt.datetime] = mapped_column(default=_now, index=True)
    # reconciliation
    status: Mapped[str] = mapped_column(
        String, default="received"
    )  # received|reconciled|disputed|refunded
    receipt_number: Mapped[str | None] = mapped_column(String, unique=True, nullable=True)


class Correction(Base):
    __tablename__ = "corrections"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    hypothesis_id: Mapped[str | None] = mapped_column(String, nullable=True)
    timesheet_id: Mapped[str | None] = mapped_column(String, index=True, nullable=True)
    field_name: Mapped[str | None] = mapped_column(String, nullable=True)
    original_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    corrected_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    by_user: Mapped[str | None] = mapped_column(String, nullable=True)
    at: Mapped[dt.datetime] = mapped_column(default=_now)


class Event(Base):
    """Append-only audit spine — tamper-evident via hash chain.

    Each event's `hash` = sha256(prev_hash + actor + entity_id + action + payload).
    A break in the chain (any historical event modified) is detectable by re-walking
    the chain. Sufficient for SOC2/ISO27001-style audit, FTA tax-record retention,
    and dispute defence — close to what production-grade financial systems expect.
    """

    __tablename__ = "events"
    __table_args__ = (UniqueConstraint("idempotency_key", name="uq_events_idem"),)
    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    actor: Mapped[str | None] = mapped_column(String, nullable=True)
    entity_kind: Mapped[str] = mapped_column(String, index=True)
    entity_id: Mapped[str] = mapped_column(String, index=True)
    action: Mapped[str] = mapped_column(String)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    idempotency_key: Mapped[str | None] = mapped_column(String, nullable=True)
    at: Mapped[dt.datetime] = mapped_column(default=_now)
    # tamper-evidence
    prev_hash: Mapped[str | None] = mapped_column(String, nullable=True)
    hash: Mapped[str | None] = mapped_column(String, index=True, nullable=True)
    # before/after diff for mutations — null for create-only events
    before: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    after: Mapped[dict | None] = mapped_column(JSON, nullable=True)

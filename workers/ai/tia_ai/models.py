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
    """Append-only audit spine."""

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

"""Canonical Pydantic schemas - the shared source of truth (see CONTRACTS.md §4).

The model never produces final confidence; it produces *signals*. Final calibrated
confidence is computed by the matcher + validators downstream.
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Leave codes - canonical enum. The canonicalizer maps raw variants to these.
# ---------------------------------------------------------------------------


class LeaveCode(str, Enum):
    AL = "AL"  # annual leave
    SICK = "SICK"
    UNPAID = "UNPAID"
    PUBLIC_HOLIDAY = "PUBLIC_HOLIDAY"
    ABSENT = "ABSENT"
    PRESENT = "PRESENT"


# ---------------------------------------------------------------------------
# Extraction output (matches CONTRACTS.md §4 TimesheetExtraction)
# ---------------------------------------------------------------------------


class Reimbursement(BaseModel):
    reason: str
    amount_aed: float


class TimesheetRow(BaseModel):
    employee_name: str
    emp_id: str | None = None
    days_worked: float | None = None
    hours: float | None = None
    ot_hours: float | None = None
    leave_codes: list[LeaveCode] = Field(default_factory=list)
    reimbursements: list[Reimbursement] = Field(default_factory=list)
    notes: str | None = None


class TimesheetExtraction(BaseModel):
    client_code: str | None = None
    client_hint: str | None = None
    period: str | None = None  # YYYY-MM
    signed_by: str | None = None
    rows: list[TimesheetRow] = Field(default_factory=list)
    confidence_per_field: dict[str, float] = Field(default_factory=dict)
    # Per-row provenance anchored to the source document (vision path only).
    # Each entry: {row_idx, bbox: [x1,y1,x2,y2], coord_space: "pixel"|"norm",
    #             image_w, image_h, source_text, source_block_id}
    row_provenance: list[dict] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Provenance / evidence graph
# ---------------------------------------------------------------------------


class BBox(BaseModel):
    page: int = 0
    # normalized [x1, y1, x2, y2] in 0..1
    norm: list[float] = Field(default_factory=lambda: [0.0, 0.0, 0.0, 0.0])


class Hypothesis(BaseModel):
    field_name: str
    value: str | None
    bbox: BBox | None = None
    source_block_id: str | None = None
    raw_confidence: float = 1.0
    signals: dict[str, float] = Field(default_factory=dict)

    @property
    def anchored(self) -> bool:
        return self.bbox is not None


# ---------------------------------------------------------------------------
# Entity resolution / matching
# ---------------------------------------------------------------------------


class Candidate(BaseModel):
    emp_id: str
    full_name: str
    client_code: str
    score: float  # composite similarity 0..1
    signals: dict[str, float] = Field(default_factory=dict)


class RowMatch(BaseModel):
    row_idx: int
    chosen_emp_id: str | None
    candidates: list[Candidate] = Field(default_factory=list)
    ambiguous: bool = False
    confidence: float = 0.0
    reason: str = ""


class MatchResult(BaseModel):
    matches: list[RowMatch] = Field(default_factory=list)
    # cost matrix exposed for the "Why?" drawer: rows x candidate labels
    cost_matrix: list[list[float]] = Field(default_factory=list)
    candidate_labels: list[str] = Field(default_factory=list)
    row_labels: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


class ValidationResult(BaseModel):
    rule: str
    passed: bool
    message: str = ""
    severity: str = "error"  # error | warning


class Routing(str, Enum):
    AUTO = "auto"
    HITL = "hitl"
    ESCALATE = "escalate"

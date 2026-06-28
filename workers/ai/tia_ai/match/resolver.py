"""Entity resolution: extracted timesheet rows -> master employees.

Tiered candidate retrieval, then a global Hungarian assignment for consistency.
Confidence is computed here from signals; it is never taken from the model.

Tiers:
  1. Emp ID exact            -> definitive, never ambiguous
  2. exact name within client
  3. fuzzy name (rapidfuzz)  within client scope
  4. phonetic (metaphone)    within client scope / global fallback
"""

from __future__ import annotations

import re

import jellyfish
from rapidfuzz import fuzz
from sqlalchemy.orm import Session

from ..models import Client, Employee
from ..schema import Candidate, MatchResult, RowMatch, TimesheetExtraction
from .hungarian import assign

NAME_THRESHOLD = 0.82  # candidate must score at least this on name
AMBIGUITY_MARGIN = 0.06  # if top-2 within this, it's ambiguous
ID_NAME_MISMATCH = 0.55  # an Emp ID whose name disagrees this much with the doc → review
TOP_K = 4


def _name_sim(a: str, b: str) -> float:
    return fuzz.WRatio(a, b) / 100.0


def _phonetic_eq(a: str, b: str) -> bool:
    try:
        return jellyfish.metaphone(a) == jellyfish.metaphone(b)
    except Exception:  # noqa: BLE001
        return False


def resolve_client(hint: str | None, session: Session) -> str | None:
    if not hint:
        return None
    hint = hint.strip()
    if re.fullmatch(r"CL\d+", hint, re.IGNORECASE):
        return hint.upper()
    best, best_score = None, 0.0
    for c in session.query(Client).all():
        s = _name_sim(hint, c.name)
        if s > best_score:
            best, best_score = c.code, s
    return best if best_score >= 0.6 else None


# Glyph pairs OCR routinely confuses in an alphanumeric code's digits. Keyed on the
# UPPER-cased form (we upper() before translating).
_OCR_DIGIT_FIX = str.maketrans({"O": "0", "I": "1", "|": "1", "L": "1", "S": "5", "B": "8", "Z": "2", "G": "6", "Q": "0", "D": "0"})


def canonical_client_code(code: str | None, session: Session) -> str | None:
    """Snap an OCR'd client code onto a real one.

    Client codes are a tiny known set (CL001…) and OCR commonly misreads 0↔O, 1↔I/L,
    5↔S etc. — e.g. Mistral Document AI reads the printed "CL001" as "CLO01". That made
    `find_active_contract` miss, rule R0 fail, and an otherwise-clean sheet get forced
    to review. We accept a correction ONLY when the glyph-normalised code lands EXACTLY
    on a real client code, so we can never silently bill a different client; an
    unrecognised code is returned unchanged and still routes to human review. Employee
    resolution within the chosen client is a second safety net against a bad snap."""
    if not code:
        return code
    code = code.strip().upper()
    known = {c.code.upper() for c in session.query(Client).all()}
    if code in known:
        return code
    # Real codes are 'CL' + digits. Normalise glyph confusions only in the TAIL so the
    # literal 'L' in the 'CL' prefix is never turned into a '1'.
    if code.startswith("CL") and len(code) > 2:
        fixed = "CL" + code[2:].translate(_OCR_DIGIT_FIX)
        if fixed in known:
            return fixed
    return code


def _candidates_for(name: str, emp_id: str | None, pool: list[Employee]) -> list[Candidate]:
    cands: list[Candidate] = []
    for e in pool:
        nsim = _name_sim(name, e.full_name)
        phon = 1.0 if _phonetic_eq(name, e.full_name) else 0.0
        score = round(0.85 * nsim + 0.15 * phon, 4)
        if score >= NAME_THRESHOLD or (emp_id and e.emp_id == emp_id):
            cands.append(
                Candidate(
                    emp_id=e.emp_id,
                    full_name=e.full_name,
                    client_code=e.client_code,
                    score=score,
                    signals={"name_sim": round(nsim, 4), "phonetic": phon},
                )
            )
    cands.sort(key=lambda c: c.score, reverse=True)
    return cands[:TOP_K]


def resolve(extraction: TimesheetExtraction, session: Session) -> MatchResult:
    client_code = extraction.client_code or resolve_client(extraction.client_hint, session)
    result = MatchResult()

    # employee pool: scoped to client if known, else all
    if client_code:
        pool = session.query(Employee).filter(Employee.client_code == client_code).all()
    else:
        pool = session.query(Employee).all()
    by_id = {e.emp_id: e for e in session.query(Employee).all()}

    row_candidates: list[list[Candidate]] = []
    for row in extraction.rows:
        # Tier 1: emp id exact
        if row.emp_id and row.emp_id in by_id:
            e = by_id[row.emp_id]
            sig: dict = {"tier": 1}
            # Cross-verify: when the document carries a real person-name, it MUST
            # agree with the employee the Emp ID points to. A misread/wrong/forged
            # Emp ID otherwise silently bills the wrong person. We only check when the
            # name looks like a real "First Last" (not blank, not the Emp ID itself).
            nm = (row.employee_name or "").strip()
            if " " in nm and not re.fullmatch(r"EMP\d+", nm, re.IGNORECASE):
                sig["name_sim"] = round(_name_sim(nm, e.full_name), 4)
            row_candidates.append(
                [
                    Candidate(
                        emp_id=e.emp_id,
                        full_name=e.full_name,
                        client_code=e.client_code,
                        score=1.0,
                        signals=sig,
                    )
                ]
            )
            continue
        row_candidates.append(_candidates_for(row.employee_name, row.emp_id, pool))

    # union of candidate employees -> columns for the cost matrix (the "Why?" view)
    col_ids: list[str] = []
    for cands in row_candidates:
        for c in cands:
            if c.emp_id not in col_ids:
                col_ids.append(c.emp_id)
    col_label = {cid: (by_id[cid].full_name if cid in by_id else cid) for cid in col_ids}

    # cost matrix: cost = 1 - score (missing candidate => high cost)
    cost: list[list[float]] = []
    for cands in row_candidates:
        score_by = {c.emp_id: c.score for c in cands}
        cost.append([round(1.0 - score_by.get(cid, 0.0), 4) for cid in col_ids])
    assignment, _ = assign(cost) if col_ids else ([], 0.0)

    for idx, (row, cands) in enumerate(zip(extraction.rows, row_candidates, strict=True)):
        tier1 = bool(cands and cands[0].signals.get("tier") == 1)
        ambiguous = False
        chosen: str | None = None
        confidence = 0.0
        reason = ""

        if tier1:
            sim = cands[0].signals.get("name_sim")
            if sim is not None and sim < ID_NAME_MISMATCH:
                # The Emp ID resolves to someone whose name the document contradicts —
                # an identity mismatch. Never auto-bill this; force human review.
                chosen = cands[0].emp_id
                ambiguous = True
                confidence = round(0.3 * (sim or 0.0), 4)
                reason = (
                    f"identity mismatch: Emp ID {cands[0].emp_id} is registered to "
                    f"{cands[0].full_name}, but the timesheet names '{row.employee_name}'"
                )
            else:
                chosen = cands[0].emp_id
                confidence = 0.99
                reason = "Emp ID + name match" if sim is not None else "Emp ID exact match"
        elif not cands:
            confidence = 0.0
            reason = "no candidate above threshold"
        else:
            top = cands[0]
            second = cands[1].score if len(cands) > 1 else 0.0
            margin = top.score - second
            # genuine ambiguity: 2+ strong candidates within margin (e.g. duplicate names)
            if len(cands) > 1 and margin <= AMBIGUITY_MARGIN and second >= NAME_THRESHOLD:
                ambiguous = True
                confidence = round(0.45 * top.score, 4)
                reason = f"{sum(1 for c in cands if c.score >= NAME_THRESHOLD)} strong candidates (Δ={margin:.2f}) - needs review"
            else:
                # use Hungarian assignment for the consistent pick
                assigned_col = assignment[idx] if idx < len(assignment) else -1
                chosen = col_ids[assigned_col] if 0 <= assigned_col < len(col_ids) else top.emp_id
                confidence = round(0.9 * top.score, 4)
                reason = (
                    "unique name match (Hungarian-assigned)"
                    if margin > AMBIGUITY_MARGIN
                    else "assigned"
                )

        result.matches.append(
            RowMatch(
                row_idx=idx,
                chosen_emp_id=chosen,
                candidates=cands,
                ambiguous=ambiguous,
                confidence=confidence,
                reason=reason,
            )
        )

    result.cost_matrix = cost
    result.candidate_labels = [f"{cid} {col_label[cid]}" for cid in col_ids]
    result.row_labels = [r.employee_name for r in extraction.rows]
    return result

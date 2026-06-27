"""Seed Contract / RateCard / SOW from existing clients & employees.

Idempotent: wipes contracts/rate_cards/sows and reseeds. Distinguishes 7 UAE +
2 KSA + 1 India contracts so the demo shows VAT / SAC variation by jurisdiction.

Run: `uv run python -m tia_ai.seed_contracts`
"""

from __future__ import annotations

import datetime as dt

from .db import get_session, init_db
from .models import Client, Contract, Employee, RateCard, SOW

# TASC's own TRN (sample; a real one is 15 digits ending in 0003 for a free-zone branch)
TASC_TRN = "100123456700003"

# Jurisdiction routing — 7 UAE + 2 KSA + 1 India
JURISDICTION_OVERRIDE = {
    "CL008": "KSA",
    "CL009": "KSA",
    "CL010": "IN",
}
VAT_BY_JURISDICTION = {"UAE": 0.05, "KSA": 0.15, "IN": 0.18}
SAC_BY_JURISDICTION = {"IN": "998513"}  # Contract Staffing Services per GST

# Per-jurisdiction city/PoS for invoice header
PLACE_OF_SUPPLY = {"UAE": "Dubai, UAE", "KSA": "Riyadh, KSA", "IN": "Bangalore, IN"}

# Realistic AED/hr rate cards by job-title bucket (TASC-style markup applied later)
RATE_CARD_TEMPLATES = {
    "Software Engineer": {"regular": 225, "ot_mult": 1.25, "night_mult": 1.5},
    "Senior Engineer": {"regular": 280, "ot_mult": 1.25, "night_mult": 1.5},
    "HR Manager": {"regular": 180, "ot_mult": 1.25, "night_mult": 1.5},
    "Operations Manager": {"regular": 200, "ot_mult": 1.25, "night_mult": 1.5},
    "Site Manager": {"regular": 195, "ot_mult": 1.25, "night_mult": 1.5},
    "Project Manager": {"regular": 230, "ot_mult": 1.25, "night_mult": 1.5},
    "Accountant": {"regular": 140, "ot_mult": 1.25, "night_mult": 1.5},
    "Finance Analyst": {"regular": 160, "ot_mult": 1.25, "night_mult": 1.5},
    "Compliance Officer": {"regular": 175, "ot_mult": 1.25, "night_mult": 1.5},
    "Customer Service": {"regular": 95, "ot_mult": 1.25, "night_mult": 1.5},
    "Driver": {"regular": 80, "ot_mult": 1.25, "night_mult": 1.5},
    "Helper": {"regular": 65, "ot_mult": 1.25, "night_mult": 1.5},
    "Cleaner": {"regular": 60, "ot_mult": 1.25, "night_mult": 1.5},
    "Security Guard": {"regular": 75, "ot_mult": 1.25, "night_mult": 1.5},
    "Receptionist": {"regular": 90, "ot_mult": 1.25, "night_mult": 1.5},
    "Sales Executive": {"regular": 130, "ot_mult": 1.25, "night_mult": 1.5},
    "Marketing Coordinator": {"regular": 120, "ot_mult": 1.25, "night_mult": 1.5},
    "IT Support": {"regular": 115, "ot_mult": 1.25, "night_mult": 1.5},
    "Data Analyst": {"regular": 170, "ot_mult": 1.25, "night_mult": 1.5},
    "Admin Assistant": {"regular": 85, "ot_mult": 1.25, "night_mult": 1.5},
}
DEFAULT_RATE = {"regular": 110, "ot_mult": 1.25, "night_mult": 1.5}

# Contract type rotation so demo shows all 3
CONTRACT_TYPE_BY_CLIENT = {
    "CL001": "TIME_AND_MATERIALS",
    "CL002": "FIXED_SCOPE",
    "CL003": "TIME_AND_MATERIALS",
    "CL004": "RETAINER",
    "CL005": "FIXED_SCOPE",
    "CL006": "TIME_AND_MATERIALS",
    "CL007": "TIME_AND_MATERIALS",
    "CL008": "TIME_AND_MATERIALS",
    "CL009": "RETAINER",
    "CL010": "TIME_AND_MATERIALS",
}


def _customer_trn(client_code: str, jurisdiction: str) -> str:
    """Synthesize a 15-digit TRN-style identifier. Demo only."""
    base = "".join(filter(str.isdigit, client_code)) or "000"
    suffix = {"UAE": "0003", "KSA": "0007", "IN": "0009"}.get(jurisdiction, "0001")
    return f"{int(base):03d}".rjust(11, "1") + suffix


def seed_contracts() -> dict[str, int]:
    init_db()
    counts = {"contracts": 0, "rate_cards": 0, "sows": 0}
    start = "2026-01-01"
    end = "2026-12-31"

    with get_session() as s:
        # wipe for idempotent reseed
        s.query(SOW).delete()
        s.query(RateCard).delete()
        s.query(Contract).delete()

        clients = s.query(Client).all()
        for c in clients:
            jurisdiction = JURISDICTION_OVERRIDE.get(c.code, "UAE")
            vat = VAT_BY_JURISDICTION[jurisdiction]
            sac = SAC_BY_JURISDICTION.get(jurisdiction)
            ctype = CONTRACT_TYPE_BY_CLIENT.get(c.code, "TIME_AND_MATERIALS")

            # update client.settings with TRN/jurisdiction/dispatch rules (BTP-style)
            c.settings = {
                **(c.settings or {}),
                "customer_trn": _customer_trn(c.code, jurisdiction),
                "jurisdiction": jurisdiction,
                "billing_entity": c.name,
                "validation_threshold_aed": 50000,
                "dispatch_order_rule": "asc_by_amount",
                "dispatch_grouping_mode": "by_client_period",
                "sla_days_to_invoice": 5,
                "payment_terms_days": 30,
                "watched_mailboxes": [f"timesheets-{c.code.lower()}@tia-watch.test"],
            }
            c.currency_default = (
                "AED" if jurisdiction == "UAE" else ("SAR" if jurisdiction == "KSA" else "INR")
            )

            emps = s.query(Employee).filter_by(client_code=c.code).all()
            authorized = [e.emp_id for e in emps]
            contract = Contract(
                client_code=c.code,
                name=f"{c.name} — Manpower Supply {dt.date(2026, 1, 1).year}",
                type=ctype,
                start_date=start,
                end_date=end,
                jurisdiction=jurisdiction,
                currency=c.currency_default,
                vat_rate=vat,
                sac_code=sac,
                markup_pct=0.20 if jurisdiction == "UAE" else 0.25,
                max_ot_pct=0.20,  # 20% OT cap — R4
                payment_terms_days=30,
                billing_cadence="MONTHLY",
                approver_name="Site Manager",
                approver_email=c.contact_email,
                authorized_emp_ids=authorized,
                extra={"place_of_supply": PLACE_OF_SUPPLY[jurisdiction]},
                active=True,
            )
            s.add(contract)
            s.flush()  # need contract.id for rate cards
            counts["contracts"] += 1

            # rate cards — one per distinct job title under this client
            titles = {(e.job_title or "Admin Assistant") for e in emps}
            for title in sorted(titles):
                tmpl = RATE_CARD_TEMPLATES.get(title, DEFAULT_RATE)
                reg = tmpl["regular"]
                rc = RateCard(
                    contract_id=contract.id,
                    labor_category=title,
                    regular_rate=float(reg),
                    ot_rate=float(round(reg * tmpl["ot_mult"], 2)),
                    night_rate=float(round(reg * tmpl["night_mult"], 2)),
                    weekend_rate=float(round(reg * 1.5, 2)),
                    holiday_rate=float(round(reg * 1.5, 2)),
                )
                s.add(rc)
                counts["rate_cards"] += 1

            # SOW — only meaningful for FIXED_SCOPE; seed a couple of deliverables
            if ctype == "FIXED_SCOPE":
                # Make at least one SOW "completed early" so the eval case fires R5
                s.add(
                    SOW(
                        contract_id=contract.id,
                        deliverable="Design phase",
                        hours_expected=160,
                        hours_consumed=160,
                        status="COMPLETED",
                        completed_at="2026-05-31",
                    )
                )
                s.add(
                    SOW(
                        contract_id=contract.id,
                        deliverable="Build phase",
                        hours_expected=320,
                        hours_consumed=0,
                        status="OPEN",
                    )
                )
                counts["sows"] += 2

    return counts


if __name__ == "__main__":
    print(seed_contracts())

"""Finance domain: leakage detection + catch-up recovery invoices.

Leakage = payroll lines that were paid out by TASC but never re-billed to the
client (the silent cost-of-non-billing). `compute_revenue_leakage` walks the
five-reason taxonomy in `leakage.py`; `build_recovery_invoice` in `recovery.py`
issues the catch-up invoice with a `-R001` sequence suffix so the recovery
sequence is auditable separately from regular billing.
"""

from .leakage import (
    FRIENDLY_LEAKAGE_MESSAGES,
    LeakageEntry,
    LeakageReason,
    LeakageReport,
    compute_revenue_leakage,
)
from .recovery import build_recovery_invoice

__all__ = [
    "FRIENDLY_LEAKAGE_MESSAGES",
    "LeakageEntry",
    "LeakageReason",
    "LeakageReport",
    "build_recovery_invoice",
    "compute_revenue_leakage",
]

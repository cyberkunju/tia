"""Cover the stretch/regression synthgen case generators (case 8–14) that
generate_all() no longer fires. Each writes a synthetic input + gold file; we
assert the artifacts land so a regression in the generators is caught."""

from __future__ import annotations

from tia_ai import synthgen as G
from tia_ai.config import DATA_DIR


def test_case08_aisha_3way():
    G.case08_aisha_3way()
    assert (DATA_DIR / "synthetic" / "case_08_aisha_3way.eml").exists()
    assert (DATA_DIR / "gold" / "case_08.json").exists()


def test_case09_messy_excel():
    G.case09_messy_excel()
    assert (DATA_DIR / "synthetic" / "case_09_messy.xlsx").exists()


def test_case10_email_quoted_reply():
    G.case10_email_quoted_reply()
    assert (DATA_DIR / "synthetic" / "case_10_email_quoted_reply.eml").exists()


def test_case11_clean_pdf():
    G.case11_clean_pdf()
    assert (DATA_DIR / "synthetic" / "case_11_clean_pdf.pdf").exists()


def test_case12_rate_mismatch():
    G.case12_rate_mismatch()
    assert (DATA_DIR / "synthetic" / "case_12_rate_mismatch.eml").exists()


def test_case13_out_of_scope_sow():
    G.case13_out_of_scope_sow()
    assert (DATA_DIR / "synthetic" / "case_13_out_of_scope_sow.eml").exists()


def test_case14_ot_over_cap():
    G.case14_ot_over_cap()
    assert (DATA_DIR / "synthetic" / "case_14_ot_over_cap.xlsx").exists()


def test_generate_all_returns_seven():
    files = G.generate_all()
    assert len([f for f in files if f.startswith("case_0")]) >= 7

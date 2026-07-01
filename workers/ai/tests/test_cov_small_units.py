"""Targeted coverage for small pure-function gaps that the existing suite missed.

Every test asserts concrete behaviour (specific values / branch outcomes) so it
fails on a real regression, not just on a coverage delta. No network.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import create_engine, inspect, text

import tia_ai.config as config
import tia_ai.db as db
from tia_ai import canonicalize as C
from tia_ai.ai import guard
from tia_ai.extract import email as email_ex
from tia_ai.extract import email_attachments as EA
from tia_ai.extract import excel as excel_ex
from tia_ai.extract import vision as vision_ex
from tia_ai.extract import word as word_ex
from tia_ai.finance import recovery as recov
from tia_ai.finance.leakage import LeakageReason
from tia_ai.models import Base


# ── guard.assess_safety empty-message branch (line 79) ─────────────────────────


def test_assess_safety_blank_is_safe_empty():
    v = guard.assess_safety("   \n\t ")
    assert v.category == "safe"
    assert v.reason == "empty message"


# ── canonicalize.canon_period unrecognized month (line 108) ────────────────────


def test_canon_period_unrecognized_month_returned_untouched():
    # "Foo 2026" matches the Month-YYYY shape but no month resolves → mo stays None
    assert C.canon_period("Foo 2026") == "Foo 2026"


# ── config.config_warnings OCR-missing branch (line 146) ───────────────────────


def test_config_warnings_no_ocr_backend(monkeypatch):
    monkeypatch.setattr(config, "GLM_OCR_API_KEY", "")
    monkeypatch.setattr(config, "MISTRAL_OCR_ENDPOINT", "")
    monkeypatch.setattr(config, "MISTRAL_OCR_API_KEY", "")
    w = config.config_warnings()
    assert any("no OCR backend" in x for x in w)


# ── db._ensure_columns skips a table missing from the DB (line 44) ─────────────


def test_ensure_columns_skips_absent_table(monkeypatch, tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path / 'partial.db'}")
    Base.metadata.create_all(eng)
    # drop an entire table so has_table() returns False for it
    tables = [t.name for t in Base.metadata.sorted_tables]
    dropped = tables[0]
    with eng.begin() as c:
        c.execute(text(f'DROP TABLE "{dropped}"'))
    assert not inspect(eng).has_table(dropped)
    monkeypatch.setattr(db, "engine", eng)
    db._ensure_columns()  # must not raise; the missing table is simply skipped
    # the still-present tables were introspected without error
    assert inspect(eng).has_table(tables[1])


# ── db._ensure_doc_dedup_constraint postgres branch swallows errors (81-82) ────


def test_ensure_dedup_constraint_swallows_statement_errors(monkeypatch):
    class FakeBegin:
        def __enter__(self):
            raise RuntimeError("constraint already exists")

        def __exit__(self, *a):
            return False

    class FakeEngine:
        url = "postgresql://tia:tia@localhost/tia"

        def begin(self):
            return FakeBegin()

    monkeypatch.setattr(db, "engine", FakeEngine())
    # each of the 3 statements raises inside begin(); all are swallowed → no raise
    db._ensure_doc_dedup_constraint()


# ── extract.__init__ OSError on stat → empty extraction (97-98) ────────────────


def test_extract_oserror_returns_empty(tmp_path):
    from tia_ai.extract import extract

    missing = tmp_path / "does_not_exist_at_all.xlsx"
    ex = extract(missing)  # stat() raises OSError → empty extraction, no crash
    assert ex.rows == []


# ── extract.email._clean_num + labelled continuation rows (95, 98-99, 165-169, 184)


def test_email_clean_num_branches():
    assert email_ex._clean_num(None) is None      # line 95
    assert email_ex._clean_num("not-a-number") is None  # 98-99
    assert email_ex._clean_num("1,234.5") == 1234.5


def test_email_labelled_continuation_rows():
    body = (
        "Timesheet for June 2026\n"
        "EMP10001 Carlos Smith\n"
        "Days worked: 22\n"
        "3 OT\n"
        "Leave taken: AL\n"
        "claim AED 250 for taxi\n"
    )
    ex = email_ex.extract_email(body)
    assert len(ex.rows) == 1
    row = ex.rows[0]
    assert row.emp_id == "EMP10001"
    assert row.days_worked == 22.0
    assert row.ot_hours == 3.0
    assert any(r.amount_aed == 250.0 for r in row.reimbursements)


def test_email_row_without_attribution_is_skipped():
    # a line with a days signal but no emp id and no leading name → skipped (184)
    body = "worked 20 days\n"
    ex = email_ex.extract_email(body)
    assert ex.rows == []


# ── extract.email_attachments filename-without-disposition (line 25) ───────────


def test_attachment_detected_by_filename_only():
    from email.mime.multipart import MIMEMultipart
    from email.mime.base import MIMEBase

    m = MIMEMultipart()
    m["Subject"] = "s"
    part = MIMEBase("application", "octet-stream")
    part.set_payload(b"raw bytes here")
    # a filename but NO Content-Disposition: attachment header → hits the filename branch
    part.add_header("Content-Type", 'application/octet-stream; name="data.bin"')
    part.set_payload(b"payload")
    part.add_header("Content-Transfer-Encoding", "base64")
    import email.encoders as enc

    enc.encode_base64(part)
    del part["Content-Disposition"]
    part.add_header("Content-Disposition", 'inline; filename="data.bin"')
    m.attach(part)
    files = list(EA.extract_attachments(m.as_bytes()))
    assert any(name == "data.bin" for name, _mime, _payload in files)


# ── extract.excel edge branches (38, 41-42, 67-69, 78, 94, 137) ────────────────


def test_excel_num_branches():
    assert excel_ex._num(None) is None            # 38
    assert excel_ex._num("not a number") is None  # 41-42
    assert excel_ex._num("12.5") == 12.5


def test_excel_extract_csv_empty_returns_empty(tmp_path):
    p = tmp_path / "empty.csv"
    p.write_text("   \n")
    assert excel_ex.extract_csv(p).rows == []  # line 78


def test_excel_parse_grid_all_none_rows_empty():
    # every row is None → filtered to empty → early return (line 94)
    assert excel_ex.parse_grid([None, None]).rows == []


def test_excel_parse_grid_no_data_rows():
    # header only → no data rows → empty extraction returned at the end
    assert excel_ex.parse_grid([("Emp ID", "Name")]).rows == []


def test_excel_parse_grid_punch_skips_blank_rows():
    # a punch layout (2 in + 2 out cols) with a fully-blank data row (137 continue)
    headers = ("Name", "Time In", "Time Out", "Punch In", "Punch Out")
    blank = (None, None, None, None, None)
    data = ("Carlos", "09:00", "17:00", "09:00", "13:00")
    ex = excel_ex.parse_grid([headers, blank, data])
    assert len(ex.rows) == 1
    assert ex.rows[0].employee_name == "Carlos"


def test_excel_extract_xls_via_xlrd(monkeypatch, tmp_path):
    """Cover the .xls glue (67-69) by mocking xlrd's workbook — no real .xls fixture
    or xlwt needed. parse_grid runs for real over the mocked rows."""
    import xlrd

    grid = [
        ["Emp ID", "Full Name", "Working Days", "OT Hours"],
        ["EMP10001", "Carlos Smith", 22, 5],
    ]

    class FakeSheet:
        nrows = len(grid)

        def row_values(self, r):
            return grid[r]

    class FakeBook:
        def sheet_by_index(self, i):
            assert i == 0
            return FakeSheet()

    monkeypatch.setattr(xlrd, "open_workbook", lambda **k: FakeBook())
    p = tmp_path / "legacy.xls"
    p.write_bytes(b"\xd0\xcf\x11\xe0 fake ole header")
    ex = excel_ex.extract_xls(p)  # lines 67-69
    assert ex.rows and ex.rows[0].emp_id == "EMP10001"
    assert ex.rows[0].days_worked == 22.0


# ── extract.vision internal branches (58, 61, 73, 134) ─────────────────────────


def test_vision_attach_provenance_skips_bad_bboxes():
    from tia_ai.schema import TimesheetExtraction, TimesheetRow

    ex = TimesheetExtraction(rows=[TimesheetRow(employee_name="Carlos Smith")])
    blocks = [
        {"bbox": [0, 0, 100], "text": "Carlos Smith"},           # len != 4 → 58
        {"bbox": [-5, 0, 50, 50], "text": "Carlos Smith"},        # negative → 61
        {"bbox": [10, 10, 300, 120], "text": "Carlos Smith 22"},  # valid, in-range area
    ]
    vision_ex._attach_provenance(ex, blocks, img_w=1000, img_h=1400)
    # the one valid block anchored the row
    assert len(ex.row_provenance) == 1


def test_vision_attach_provenance_skips_empty_name():
    from tia_ai.schema import TimesheetExtraction, TimesheetRow

    ex = TimesheetExtraction(rows=[TimesheetRow(employee_name="   ")])  # blank name → 73
    blocks = [{"bbox": [10, 10, 300, 120], "text": "something"}]
    vision_ex._attach_provenance(ex, blocks, img_w=1000, img_h=1400)
    assert ex.row_provenance == []


def test_vision_overtime_table_short_row_continue():
    # a markdown table row with fewer than 4 cells → the (3,8) index continue (134)
    md = "| Date | Hours |\n| :--- | :--- |\n| 1 | 8 |\n"
    assert vision_ex._sum_overtime_from_markdown_table(md) is None


def test_vision_overtime_table_sums_cells():
    md = (
        "| Date | In | Out | OT | a | b | c | d | OT2 |\n"
        "| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n"
        "| 1 | 09 | 17 | 2 | x | x | x | x | 1 |\n"
    )
    assert vision_ex._sum_overtime_from_markdown_table(md) == 3.0


# ── extract.word exception branches (63-64, 70-71) ─────────────────────────────


def test_word_doc_readable_text_not_ole(tmp_path):
    p = tmp_path / "notole.doc"
    p.write_bytes(b"this is plainly not an OLE file")
    assert word_ex._doc_readable_text(p) == ""


def test_word_doc_readable_text_open_failure(monkeypatch, tmp_path):
    import olefile

    p = tmp_path / "x.doc"
    p.write_bytes(b"whatever")
    monkeypatch.setattr(olefile, "isOleFile", lambda *_a: True)

    def _boom(*_a, **_k):
        raise RuntimeError("cannot open ole")

    monkeypatch.setattr(olefile, "OleFileIO", _boom)
    assert word_ex._doc_readable_text(p) == ""  # 63-64


def test_word_doc_utf16_decode_guarded(monkeypatch, tmp_path):
    """Force the utf-16 decode step to raise so the except branch (70-71) runs.

    We return a bytes subclass whose .decode('utf-16-le', ...) raises, while the
    latin-1 path (which operates on a plain-bytes re.sub result) still works — so
    no global module (re) is patched and pytest internals stay intact.
    """
    import olefile

    class _Utf16Boom(bytes):
        def decode(self, *a, **k):
            if a and "utf-16" in str(a[0]).lower():
                raise ValueError("utf16 boom")
            return bytes(self).decode(*a, **k)

    p = tmp_path / "y.doc"
    p.write_bytes(b"whatever")

    class FakeStream:
        def read(self):
            return _Utf16Boom(b"Carlos Smith worked 22 days")

    class FakeOle:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def exists(self, name):
            return True

        def openstream(self, name):
            return FakeStream()

    monkeypatch.setattr(olefile, "isOleFile", lambda *_a: True)
    monkeypatch.setattr(olefile, "OleFileIO", lambda *_a, **_k: FakeOle())

    out = word_ex._doc_readable_text(p)
    # utf16 = "" after the guarded except; latin extraction still returns text
    assert "Carlos" in out


# ── finance.recovery partial/undercharge amount branch (70-71) ─────────────────


class _FakePayroll:
    def __init__(self):
        self.working_days = 22
        self.gross = 10000.0
        self.ot_amount = 500.0
        self.ot_hours = 10.0


def test_recovery_compute_expected_partial_bills_full_month():
    amount, extra = recov._compute_expected(_FakePayroll(), LeakageReason.PARTIAL_TIMESHEET, 0.20)
    assert amount == 12000.0  # 10000 * 1.20
    assert extra["days_worked"] == 22
    assert extra["prorated"] == 10000.0


def test_recovery_compute_expected_undercharge_bills_full_month():
    amount, extra = recov._compute_expected(_FakePayroll(), LeakageReason.RATE_UNDERCHARGE, 0.20)
    assert amount == 12000.0

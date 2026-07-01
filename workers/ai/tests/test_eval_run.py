"""Eval harness (eval/run.py) — runs the offline gold cases end-to-end and
exercises the metric helpers directly (no network; vision cases auto-skip)."""

from __future__ import annotations

import json

from PIL import Image

import tia_ai.eval.run as R
from tia_ai.schema import LeaveCode, RowMatch, TimesheetRow


def test_run_eval_end_to_end():
    summary = R.run_eval(persist=False)
    assert summary["total_cases"] >= 1
    assert "macro_f1" in summary and "ece" in summary
    # at least one runnable (non-vision) case executed with a real invoice amount
    runnable = [r for r in summary["results"] if not r.get("skipped")]
    assert runnable
    assert any("invoice_amount" in r for r in runnable)


def test_run_case_missing_input(monkeypatch, tmp_path):
    gold = tmp_path / "gold"
    syn = tmp_path / "syn"
    gold.mkdir()
    syn.mkdir()
    (gold / "case_zz.json").write_text(json.dumps({"input": "nope.xlsx", "expect": {"rows": []}}))
    monkeypatch.setattr(R, "GOLD", gold)
    monkeypatch.setattr(R, "SYN", syn)
    res = R.run_case("zz")
    assert res["skipped"] is True and "not found" in res["reason"]


def test_run_case_vision_skipped_without_key(monkeypatch, tmp_path):
    gold = tmp_path / "gold"
    syn = tmp_path / "syn"
    gold.mkdir()
    syn.mkdir()
    Image.new("RGB", (10, 10), "white").save(syn / "x.png")
    (gold / "case_vv.json").write_text(json.dumps({"input": "x.png", "expect": {"rows": []}}))
    monkeypatch.setattr(R, "GOLD", gold)
    monkeypatch.setattr(R, "SYN", syn)
    monkeypatch.setattr(R, "GLM_OCR_API_KEY", "", raising=False)
    res = R.run_case("vv")
    assert res["skipped"] is True and "vision" in res["reason"]


def test_f1_and_ece_helpers():
    assert R._f1(0, 0, 0) == 0.0
    assert R._f1(2, 0, 0) == 1.0
    assert 0.0 < R._f1(1, 1, 1) < 1.0
    assert R._ece([]) == 0.0
    ece = R._ece([(0.9, True), (0.9, False), (0.2, False)])
    assert 0.0 <= ece <= 1.0


def test_row_metrics_unmatched_and_leave_branches():
    expected = [
        {"employee_name": "Carlos", "emp_id": "E1", "days_worked": 22, "leave_codes": ["SICK"]},
        {"employee_name": "Ghost", "days_worked": 5},  # no match → fn
    ]
    got_rows = [
        TimesheetRow(employee_name="Carlos", emp_id="E1", days_worked=22, leave_codes=[LeaveCode.SICK])
    ]
    got_matches = [
        RowMatch(row_idx=0, chosen_emp_id="E1", candidates=[], ambiguous=False, confidence=0.9, reason="ok")
    ]
    m = R._row_metrics(expected, got_rows, got_matches)
    # Carlos matched: days_worked tp, leave_codes match → leave tp
    assert m["tp"]["days_worked"] >= 1
    assert m["tp"]["leave_codes"] >= 1
    # Ghost unmatched → fn recorded and a not-matched row entry
    assert any(rr["matched"] is False for rr in m["rows"])
    assert m["fn"]["days_worked"] >= 1


def test_row_metrics_leave_mismatch():
    expected = [{"employee_name": "Carlos", "emp_id": "E1", "leave_codes": ["AL"]}]
    got_rows = [TimesheetRow(employee_name="Carlos", emp_id="E1", leave_codes=[LeaveCode.SICK])]
    got_matches = [
        RowMatch(row_idx=0, chosen_emp_id="E1", candidates=[], ambiguous=False, confidence=0.5, reason="")
    ]
    m = R._row_metrics(expected, got_rows, got_matches)
    # AL expected vs SICK actual → both fn and fp on leave_codes, row not ok
    assert m["fn"]["leave_codes"] >= 1 and m["fp"]["leave_codes"] >= 1
    assert m["rows"][0]["row_ok"] is False

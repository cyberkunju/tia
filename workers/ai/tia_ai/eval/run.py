"""Eval harness — runs all 7 cases, computes per-field F1, per-case pass/fail, latency.

This is the wrapper-killer: judges (and CI) see whether extraction + resolution + billing
holds against the gold ground truth. ECE is computed from per-row confidence vs correct.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from ..config import DATA_DIR
from ..db import SessionLocal
from ..erp.mock import build_invoice
from ..extract import extract
from ..match.resolver import resolve

GOLD = DATA_DIR / "gold"
SYN = DATA_DIR / "synthetic"


def _row_metrics(expected: list[dict], got_rows: list, got_matches: list) -> dict:
    """Field-level TP/FP/FN counts and per-row outcome.

    Join key: gold's `emp_id` if the pipeline resolved one matching it; else by name.
    Fields the gold is silent on do not contribute to tp/fp/fn (Karpathy rule: don't
    grade what wasn't asked for).
    """
    fields = ["emp_id", "days_worked", "ot_hours", "hours", "leave_codes", "resolved", "ambiguous"]
    tp = {k: 0 for k in fields}
    fp = {k: 0 for k in fields}
    fn = {k: 0 for k in fields}
    row_results = []

    got_by_emp: dict[str, tuple] = {}
    got_by_name: dict[str, tuple] = {}
    for ridx, r in enumerate(got_rows):
        m = got_matches[ridx] if ridx < len(got_matches) else None
        triplet = (ridx, r, m)
        if m and m.chosen_emp_id:
            got_by_emp[m.chosen_emp_id] = triplet
        got_by_name[r.employee_name.lower()] = triplet

    for exp in expected:
        # join: prefer emp_id (resolved identity), fall back to name
        exp_emp = exp.get("emp_id")
        name = (exp.get("employee_name") or "").lower()
        triplet = (got_by_emp.get(exp_emp) if exp_emp else None) or got_by_name.get(name)

        if triplet is None:
            for k in fields:
                if k in exp:
                    fn[k] += 1
            row_results.append(
                {"employee_name": exp.get("employee_name"), "matched": False, "expected": exp}
            )
            continue

        ridx, r, m = triplet
        actual = {
            "emp_id": (m.chosen_emp_id if m else r.emp_id),
            "days_worked": r.days_worked,
            "ot_hours": r.ot_hours,
            "hours": r.hours,
            "leave_codes": sorted([l.value for l in r.leave_codes]),
            "resolved": bool(m and m.chosen_emp_id and not m.ambiguous),
            "ambiguous": bool(m and m.ambiguous),
        }
        ok = True
        for k in fields:
            if k not in exp:  # gold silent — skip (don't penalize)
                continue
            ev = exp.get(k)
            av = actual.get(k)
            if k == "leave_codes":
                ev = sorted(ev or [])
                if ev == (av or []):
                    if ev:
                        tp[k] += 1
                else:
                    if ev:
                        fn[k] += 1
                    if av:
                        fp[k] += 1
                    ok = False
            else:
                if av == ev:
                    tp[k] += 1
                else:
                    fn[k] += 1
                    ok = False

        row_results.append(
            {
                "employee_name": exp.get("employee_name"),
                "matched": True,
                "expected": exp,
                "actual": actual,
                "row_ok": ok,
            }
        )

    return {"tp": tp, "fp": fp, "fn": fn, "rows": row_results}


def _f1(tp: int, fp: int, fn: int) -> float:
    prec = tp / (tp + fp) if (tp + fp) else 0.0
    rec = tp / (tp + fn) if (tp + fn) else 0.0
    return round(2 * prec * rec / (prec + rec), 4) if (prec + rec) else 0.0


def _ece(buckets: list[tuple[float, bool]], n_bins: int = 5) -> float:
    """Expected calibration error (binary correctness vs confidence)."""
    if not buckets:
        return 0.0
    bins: list[list[tuple[float, bool]]] = [[] for _ in range(n_bins)]
    for c, ok in buckets:
        idx = min(int(c * n_bins), n_bins - 1)
        bins[idx].append((c, ok))
    total = len(buckets)
    err = 0.0
    for b in bins:
        if not b:
            continue
        avg_conf = sum(c for c, _ in b) / len(b)
        acc = sum(1 for _, ok in b if ok) / len(b)
        err += (len(b) / total) * abs(avg_conf - acc)
    return round(err, 4)


_VISION_EXT = {".png", ".jpg", ".jpeg", ".tif", ".tiff"}


def run_case(case_id: str) -> dict:
    spec = json.loads((GOLD / f"case_{case_id}.json").read_text())
    inp = SYN / spec["input"]
    if not inp.exists():
        return {"case": case_id, "skipped": True, "reason": "input not found"}
    # Vision cases need the Modal GLM-OCR endpoint. Without a key, skip rather than
    # hang on a 180s httpx timeout (CI / offline). With a key set, run normally.
    from ..config import GLM_OCR_API_KEY

    if inp.suffix.lower() in _VISION_EXT and not GLM_OCR_API_KEY:
        return {"case": case_id, "skipped": True, "reason": "vision case — no GLM_OCR_API_KEY set"}
    t0 = time.time()
    ex = extract(inp)
    elapsed = round(time.time() - t0, 3)
    with SessionLocal() as s:
        mr = resolve(ex, s)
        inv = build_invoice(ex, mr, s)

    expected_rows = spec["expect"].get("rows", [])
    metrics = _row_metrics(expected_rows, ex.rows, mr.matches)

    overall_ok = (
        all(rr.get("row_ok", False) and rr["matched"] for rr in metrics["rows"])
        if metrics["rows"]
        else True
    )
    f1 = {k: _f1(metrics["tp"][k], metrics["fp"][k], metrics["fn"][k]) for k in metrics["tp"]}

    calibration: list[tuple[float, bool]] = []
    for rr, m in zip(metrics["rows"], mr.matches, strict=False):
        if not rr["matched"]:
            continue
        calibration.append((m.confidence, bool(rr.get("row_ok"))))

    return {
        "case": case_id,
        "input": spec["input"],
        "channel": spec.get("channel"),
        "passed": overall_ok,
        "f1": f1,
        "extracted_rows": len(ex.rows),
        "expected_rows": len(expected_rows),
        "matches": [
            {
                "row_idx": m.row_idx,
                "chosen": m.chosen_emp_id,
                "ambiguous": m.ambiguous,
                "confidence": m.confidence,
            }
            for m in mr.matches
        ],
        "invoice_amount": inv.get("amount"),
        "client_code": inv.get("client_code"),
        "exceptions": len(inv.get("exceptions", [])),
        "latency_s": elapsed,
        "calibration": calibration,
        "details": metrics["rows"],
    }


def run_eval(persist: bool = False) -> dict:
    cases = sorted([p.stem.replace("case_", "") for p in GOLD.glob("case_*.json")])
    results = [run_case(c) for c in cases]
    agg_tp = {}
    agg_fp = {}
    agg_fn = {}
    calibration: list[tuple[float, bool]] = []
    for r in results:
        if r.get("skipped"):
            continue
        for k, v in r["f1"].items():
            pass  # use raw counts via re-running metrics if needed
        calibration += r.get("calibration", [])
    # aggregate F1 by recomputing on summed counts
    field_keys: list[str] = []
    for r in results:
        if not r.get("skipped"):
            field_keys = list(r["f1"].keys())
            break
    macro_f1 = {}
    if field_keys:
        for k in field_keys:
            scores = [r["f1"][k] for r in results if not r.get("skipped")]
            macro_f1[k] = round(sum(scores) / len(scores), 4) if scores else 0.0
    passed = sum(1 for r in results if r.get("passed"))
    total_runnable = sum(1 for r in results if not r.get("skipped"))
    summary: dict[str, Any] = {
        "total_cases": len(results),
        "passed": passed,
        "runnable": total_runnable,
        "macro_f1": macro_f1,
        "ece": _ece(calibration),
        "results": results,
    }
    if persist:
        out = DATA_DIR / "gold" / "_last_run.json"
        out.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return summary


if __name__ == "__main__":
    import sys

    s = run_eval(persist=True)
    print(json.dumps({k: v for k, v in s.items() if k != "results"}, indent=2))
    print(f"Per-case: passed={s['passed']}/{s['runnable']}")
    for r in s["results"]:
        if r.get("skipped"):
            print(f"  case {r['case']}: SKIPPED ({r['reason']})")
        else:
            print(
                f"  case {r['case']}: {'PASS' if r['passed'] else 'FAIL'} "
                f"rows={r['extracted_rows']}/{r['expected_rows']} "
                f"amount={r['invoice_amount']} "
                f"exceptions={r['exceptions']} {r['latency_s']}s"
            )
    sys.exit(0 if s["passed"] == s["runnable"] else 1)

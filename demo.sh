#!/usr/bin/env bash
# TIA live demo driver — runs the persona-arc walkthrough end-to-end against
# the running API on http://127.0.0.1:8000.
#
# Usage:
#   bash demo.sh
#
# Pre-reqs:
#   - make seed && make synth   (one-time)
#   - make api                  (FastAPI on :8000)
#   - make dispatch             (optional — Rust on :8001)
#   - export RUST_DISPATCH_URL=http://127.0.0.1:8001    (Python proxies if set)

set -euo pipefail

API=${API:-http://127.0.0.1:8000}
RUST=${RUST:-http://127.0.0.1:8001}
DATA=${DATA:-data/synthetic}

cyan()   { printf '\033[36m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
hdr()    { printf '\n\033[1;35m━━━━ %s ━━━━\033[0m\n' "$*"; }
say()    { printf '   \033[2m%s\033[0m\n' "$*"; }
pause()  { read -r -t 0.6 -n 1 || true; }

# --- 0. Sanity --------------------------------------------------------------

hdr "0. Services up?"
green "API: $(curl -fsS --max-time 2 $API/health)"
green "Rust dispatch: $(curl -fsS --max-time 2 $RUST/health 2>/dev/null || echo '(in-process fallback)')"

hdr "0b. /status — green-dot board"
curl -fsS $API/status | python3 -m json.tool

# --- 1. CLIENT submits — case 04 handwritten -------------------------------

hdr "1. Client submits a HANDWRITTEN timesheet (case 04)"
say "Real photo of a paper timesheet. GLM-OCR (Modal vLLM) reads it."
KEY="demo-04-$RANDOM"
R1=$(curl -fsS --max-time 240 -X POST \
  -F "file=@$DATA/case_04_handwritten.png" \
  -H "Idempotency-Key: $KEY" \
  $API/intake/upload)
echo "$R1" | python3 -m json.tool
DOC1=$(echo "$R1" | python3 -c "import sys,json;print(json.load(sys.stdin)['doc_id'])")
TS1=$(echo "$R1" | python3 -c "import sys,json;print(json.load(sys.stdin)['timesheet_id'])")
INV1=$(curl -fsS $API/invoices?timesheet_id=$TS1 | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['id'] if d else '')")
green "→ doc=$DOC1  timesheet=$TS1  invoice=$INV1"

# --- 2. The hard case — case 13 SOW completed ------------------------------

hdr "2. Client (CL002) tries to bill a COMPLETED Statement of Work (case 13)"
say "FIXED_SCOPE contract: 'Design phase' already marked COMPLETED. Rule R5 should fire."
KEY="demo-13-$RANDOM"
R2=$(curl -fsS --max-time 30 -X POST \
  -F "file=@$DATA/case_13_out_of_scope_sow.eml" \
  -H "Idempotency-Key: $KEY" \
  $API/intake/upload)
echo "$R2" | python3 -m json.tool
TS2=$(echo "$R2" | python3 -c "import sys,json;print(json.load(sys.stdin)['timesheet_id'])")
yellow "→ routing should be 'hitl' with rule R5 in hitl_reason"

# --- 3. OT over contract cap — case 14 -------------------------------------

hdr "3. Excel with 50 OT hours over 22 days (case 14) — contract cap is 20%"
KEY="demo-14-$RANDOM"
R3=$(curl -fsS --max-time 30 -X POST \
  -F "file=@$DATA/case_14_ot_over_cap.xlsx" \
  -H "Idempotency-Key: $KEY" \
  $API/intake/upload)
echo "$R3" | python3 -m json.tool
yellow "→ routing 'hitl', rule R4 (OT 28% > cap 20%)"

# --- 4. Email modes --------------------------------------------------------

hdr "4. EMAIL MODE: cc_silent — TIA only in Cc, must process silently"
EMAIL_RESP=$(curl -fsS --max-time 20 -X POST $API/intake/email \
  -H "Content-Type: application/json" \
  -d '{
    "subject": "June timesheet — please process",
    "from_addr": "manager@steel.test",
    "to_addrs": ["finance@steel.test"],
    "cc_addrs": ["tia@cyberkunju.com"],
    "body": "Carlos Smith - 22 days, 2 OT hours\n"
  }')
echo "$EMAIL_RESP" | python3 -m json.tool
green "→ intake_mode should be 'cc_silent'"

hdr "4b. EMAIL MODE: watched mailbox webhook (Postmark/SES shape)"
curl -fsS --max-time 20 -X POST $API/intake/mailbox-webhook \
  -H "Content-Type: application/json" \
  -d '{
    "From": "site-manager@steel.test",
    "To": "timesheets-cl001@tia-watch.test",
    "Subject": "Monthly timesheet",
    "TextBody": "EMP10001 Carlos Smith - 22 days, 2 OT"
  }' | python3 -m json.tool

# --- 5. Online form (4th channel) ------------------------------------------

hdr "5. CHANNEL: Online Timesheet App (form submit, pre-bound to CL001)"
curl -fsS --max-time 20 -X POST $API/submit/CL001 \
  -H "Content-Type: application/json" \
  -d '{
    "period": "June 2026",
    "rows": [
      {"emp_id":"EMP10001","employee_name":"Carlos Smith","days_worked":22,"ot_hours":2},
      {"emp_id":"EMP10002","employee_name":"Ahmed Khan","days_worked":20,"leave_codes":["AL"]}
    ],
    "submitted_by": "site-manager@steel.test"
  }' | python3 -m json.tool

# --- 6. The compliance artifacts -------------------------------------------

hdr "6. SMART BOT + SAP artifacts for CL001 June 2026"
say "Ramco SRP-shaped consolidated Excel:"
curl -fsS -o /tmp/tia_demo_consolidated.xlsx "$API/consolidate/CL001/June%202026.xlsx"
ls -la /tmp/tia_demo_consolidated.xlsx
say "WPS SIF for the bank:"
curl -fsS -o /tmp/tia_demo.sif "$API/payroll/sif/CL001/June%202026.sif"
echo "--- SIF head ---"
head -1 /tmp/tia_demo.sif
echo "--- record count ---"
wc -l /tmp/tia_demo.sif

# --- 7. Tax Invoice PDF ----------------------------------------------------

hdr "7. UAE Tax Invoice PDF (Typst, Rust-backed)"
if [ -n "$INV1" ]; then
  curl -fsS -o /tmp/tia_demo_invoice.pdf "$API/invoices/$INV1/pdf"
  file /tmp/tia_demo_invoice.pdf
  ls -la /tmp/tia_demo_invoice.pdf
  say "Contains: 'Tax Invoice' header · supplier+customer TRN · sequential no. · VAT line"
else
  say "(no invoice generated for case 04 in this run — fallback case 07)"
  KEY="demo-07-$RANDOM"
  R07=$(curl -fsS --max-time 20 -X POST -F "file=@$DATA/case_07_clean.xlsx" -H "Idempotency-Key: $KEY" $API/intake/upload)
  TS07=$(echo "$R07" | python3 -c "import sys,json;print(json.load(sys.stdin)['timesheet_id'])")
  INV1=$(curl -fsS $API/invoices?timesheet_id=$TS07 | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['id'] if d else '')")
  curl -fsS -o /tmp/tia_demo_invoice.pdf "$API/invoices/$INV1/pdf"
  file /tmp/tia_demo_invoice.pdf
fi

# --- 8. Dispatch (Rust microservice) ---------------------------------------

hdr "8. DISPATCH — Rust microservice, idempotency-keyed"
if [ -n "$INV1" ]; then
  DKEY="demo-dispatch-$RANDOM"
  curl -fsS --max-time 20 -X POST -H "Content-Type: application/json" \
    -H "Idempotency-Key: $DKEY" -d '{"by_user":"finops"}' \
    $API/invoices/$INV1/dispatch | python3 -m json.tool
  say "REPLAY same key → idempotent, no double-send:"
  curl -fsS --max-time 20 -X POST -H "Content-Type: application/json" \
    -H "Idempotency-Key: $DKEY" -d '{"by_user":"finops"}' \
    $API/invoices/$INV1/dispatch | python3 -m json.tool
fi

# --- 9. The chat — grounded answers with citations -------------------------

hdr "9. CONTEXT-AWARE CHAT — strict citations forced"
say "Q: 'Why was case 13's invoice held back?'"
if [ -n "$TS2" ]; then
  # find the invoice for TS2 if it exists; otherwise just ask about CL002
  curl -fsS --max-time 60 -X POST $API/qa \
    -H "Content-Type: application/json" \
    -d "{\"question\":\"Why is the CL002 timesheet $TS2 in HITL? Tell me which rule fired and why.\"}" \
    | python3 -m json.tool
fi

# --- 10. KPIs --------------------------------------------------------------

hdr "10. KPIs — brief's 3 success measures, live"
echo "--- /metrics/stp (touchless rate target 80%+) ---"
curl -fsS $API/metrics/stp | python3 -m json.tool
echo "--- /metrics/time-to-invoice (target <5 min) ---"
curl -fsS $API/metrics/time-to-invoice | python3 -m json.tool
echo "--- /metrics/accuracy (target 99%+) ---"
curl -fsS $API/metrics/accuracy | python3 -m json.tool
echo "--- /metrics/headcount (TASC HC reporting) ---"
curl -fsS $API/metrics/headcount | python3 -m json.tool

# --- 11. Finance + dispatch queues -----------------------------------------

hdr "11. Finance queue (over-threshold) + dispatch tracking"
echo "--- /finance/queue ---"
curl -fsS $API/finance/queue | python3 -c "import sys,json;d=json.load(sys.stdin);print(f'{len(d)} invoices awaiting finance approval')"
echo "--- /dispatch/tracking ---"
curl -fsS $API/dispatch/tracking | python3 -c "import sys,json;d=json.load(sys.stdin);print(f'{len(d)} dispatch records');[print(' ',i['invoice_sequence_no'],i['status'],i['client_code']) for i in d[:5]]"

# --- 12. Audit trail for case 13 -------------------------------------------

hdr "12. EVENTS — append-only audit spine for case 13"
if [ -n "$TS2" ]; then
  sqlite3 -separator " | " /home/edneam/tia/tia.db \
    "SELECT at, actor, action FROM events WHERE entity_id='$TS2' OR entity_id IN (SELECT id FROM doc_assets WHERE id IN (SELECT doc_id FROM timesheets WHERE id='$TS2')) ORDER BY at;" \
    | head -20
fi

echo
green "✅ Demo complete. Browser UI at http://127.0.0.1:5173"

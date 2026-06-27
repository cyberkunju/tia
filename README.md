# TIA — Touchless Invoice Agent

[![ci](https://github.com/cyberkunju/tia/actions/workflows/ci.yml/badge.svg)](https://github.com/cyberkunju/tia/actions/workflows/ci.yml)

> Built for **TASC Outsourcing** — UAE manpower-supply, 10,500+ associates, 750+ clients.
> Submitted to **HackArena 2.0** by team Cyberkunju.

TIA takes a client's timesheet — in **any format from any channel** (clean Excel,
handwritten photo, scanned PDF, plain email, online form) — and carries it all the
way to a **validated UAE Tax Invoice**, dispatched in the client's preferred order.
Humans only step in when a contract rule or a confidence threshold fires.

The trick: **TIA reconciles the invoice against the contract**, not just the
timesheet. That's the gap most AP automation misses — and the gap TASC's mentors
called out as the one that matters.

## What's inside

- **4 ingestion channels** — portal upload, email (3 modes: direct / cc-silent / watched-mailbox), online form, image/PDF OCR
- **10 BTP-style contract-bound rules** — rate compliance, OT cap, SOW completion (mentor's "completed early" case), VAT, duplicates, sequential numbering, etc
- **Smart Bot + SAP** mock matching the brief's reference architecture, with Ramco SRP-shaped consolidated Excel **+ a real WPS SIF** for the bank gateway
- **Typst-rendered UAE Tax Invoice** (Rust compiler) — "Tax Invoice" header, supplier+customer TRN, sequential invoice number, VAT line breakdown, SAC code for India, audit hash footer
- **Hungarian matching** (`scipy.linear_sum_assignment`) with the cost matrix surfaced in the "Why?" drawer — no black-box LLM resolution
- **Rust dispatch service** (axum + sqlx, port :8001) — idempotency-keyed, writes outbox, separate process from the Python core
- **Context-aware AI chat** — OpenAI tool-calling with 5 read-only DB tools, strict citation contract, swap to a local model with one env var
- **3 brief success-measure KPIs** — touchless rate, time-to-invoice, extraction F1 — all live endpoints
- **13/13 eval PASS** with F1 + ECE on every push (CI gate)
- **67/67 pytest** across the stack

## Architecture

The brief's reference architecture maps 1:1 to our modules. The diagram lives in
the brief PDF (`TIA Hackathon Brief.pdf`, p.3). Module map:

| Brief block | Module |
|---|---|
| Mailbox / Email + TIA Portal Upload + Online Timesheet App + Image/PDF | `tia_ai/api/app.py` channel endpoints |
| Channel Listener / OCR / Normalize to SAP-ready Excel | `tia_ai/extract/` + `tia_ai/orchestrator.py` + `tia_ai/erp/smart_bot_sap.py` |
| TASC Smart Bot + SAP | `tia_ai/erp/smart_bot_sap.py` (Ramco SRP-shaped Excel + WPS SIF) |
| Invoice Validation (BTP & other parameters) | `tia_ai/validate/rules_v2.py` (10 rules) |
| Apply Dispatch Rules + Track Progress | `services/dispatch/` (Rust) + `tia_ai/api/app.py` `/dispatch/*` |
| Client Master Data + Dispatch Rules | `tia_ai/seed_contracts.py` + `Client.settings` JSONB |
| Client Portal (Submit / Review / Approve / Raise Queries) | `apps/web/` + `/intake/upload` + `/invoices/{id}/client-approve` + `/clients/{c}/queries` |
| TIA Dashboard | `/metrics/stp` + `/metrics/time-to-invoice` + `/metrics/accuracy` + `/dispatch/tracking` |
| Context-Aware AI Chat | `tia_ai/qa/agent.py` (`POST /qa`) |

## Quickstart

```bash
# install
make install                    # uv + bun + cargo (Rust dispatch optional)

# seed master data + 10 contracts (7 UAE + 2 KSA + 1 India) + 14 gold cases
make seed
make synth

# verify
make eval                       # 13/13 PASS (case 4 vision skipped without GLM_OCR_API_KEY)
make test                       # pytest 67/67

# run (three terminals)
make api                        # FastAPI on :8000
make web                        # Vite UI on :5173
make dispatch                   # Rust dispatch service on :8001 (optional)

# open
open http://127.0.0.1:5173/finops
```

## Environment

```bash
# .env at repo root
OPENAI_API_KEY=sk-...           # chat agent — required for /qa
OPENAI_BASE_URL=https://api.openai.com/v1   # override for a local vLLM/Ollama
OPENAI_MODEL=gpt-4o-mini

GLM_OCR_BASE_URL=https://your-modal-endpoint.run
GLM_OCR_API_KEY=...             # handwriting/scanned-PDF route

RUST_DISPATCH_URL=http://127.0.0.1:8001   # optional; Python falls back to in-process
```

## Key endpoints

| Method | Path | What |
|---|---|---|
| `GET` | `/health` | liveness |
| `GET` | `/status` | green-dot board (api / db / openai / modal / rust / last eval) |
| `POST` | `/intake/upload` | portal upload (multipart) |
| `POST` | `/intake/email` | email intake; auto-detects `direct_forward` / `cc_silent` / `watched_mailbox` |
| `POST` | `/intake/mailbox-webhook` | Postmark/SES-shaped watched mailbox |
| `POST` | `/submit/{client_code}` | online timesheet form |
| `POST` | `/qa` | grounded chat (5 DB tools, citations forced) |
| `GET` | `/consolidate/{client}/{period}.xlsx` | Ramco SRP-shaped consolidated workbook |
| `GET` | `/payroll/sif/{client}/{period}.sif` | WPS SIF for the bank (SCR + EDR records) |
| `GET` | `/invoices/{id}/pdf` | UAE Tax Invoice PDF (Typst) |
| `POST` | `/invoices/{id}/dispatch` | idempotent dispatch (proxies to Rust service if `RUST_DISPATCH_URL` set) |
| `POST` | `/invoices/{id}/client-approve` | client review flow |
| `POST` | `/invoices/{id}/finance-approve` | finance sign-off (threshold queue) |
| `POST` | `/clients` / `PUT /clients/{c}/settings` | onboarding + config |
| `POST` | `/clients/{c}/queries` | client raises a query (FinOps replies on `/queries/{id}/reply`) |
| `GET` | `/dispatch/tracking` | dispatch dashboard |
| `GET` | `/dispatch/{c}/queue` | per-client queue honouring `dispatch_order_rule` + `grouping_mode` |
| `GET` | `/metrics/stp` | touchless rate (target 80%+) |
| `GET` | `/metrics/time-to-invoice` | mean cycle minutes |
| `GET` | `/metrics/accuracy` | last-eval F1 + ECE |
| `GET` | `/eval` | run the eval harness on demand |

## The 10 BTP-style rules

1. **R1** `employee_in_contract_scope` — emp_id on contract roster
2. **R2** `rate_compliance_per_category` — billed rate matches rate card
3. **R3** `period_boundary_check` — timesheet date inside contract validity
4. **R4** `ot_within_contract_cap` — OT % ≤ `max_ot_pct`
5. **R5** `sow_hours_not_exceeded` — fixed-scope SOW completion / hours-remaining check (the mentor's "completed early" case)
6. **R6** `markup_correctly_applied` — line amount reconciles to (prorated + OT) × (1 + markup) + reimb
7. **R7** `vat_calculation_correct` — VAT = excl × rate (5% UAE / 15% KSA / 18% IN)
8. **R8** `duplicate_invoice_extended` — same (emp_id, period) not already invoiced
9. **R9** `approver_signature_present` — source doc has an approver (warning)
10. **R10** `holiday_weekend_multiplier_check` — OT amount reconciles to statutory multipliers (UAE Federal Decree-Law 33/2021: 1.25× standard, 1.5× night/rest/holiday)

Per-contract parameters drive the rules — judges can configure new validation
profiles via `PUT /clients/{c}/settings` without touching code.

## Deliverables

- **Prototype**: full stack live, all 4 channels, 13/13 eval, 67/67 pytest
- **Repo**: this (cyberkunju/tia), 17 commits, every push green on CI
- **Deck**: `docs/deck/TIA-deck.md` (Marp source) + `docs/deck/TIA-deck.pdf`
- **Demo script**: `docs/DEMO_SCRIPT.md` (90s pitch + 3min walkthrough)
- **Sample inputs**: 14 gold cases under `data/synthetic/` — Excel (5, 7, 9, 14), handwritten image (4), typed PDF (11), structured email (1, 2, 3, 6, 10, 12, 13), 3-way ambiguous (8)
- **Video**: recorded on demo day at the venue (see `docs/DEMO_SCRIPT.md` for the takes)

## Team

- **edneam** (cyberkunju) — backend, agentic core, eval harness, deck
- **Navaneeth** — frontend, WhatsApp bridge

## Stack lock

Python 3.12 + FastAPI + Pydantic v2 + uv · SQLAlchemy 2.0 (SQLite → Postgres 18 ready)
· GLM-OCR on Modal vLLM (open weight) · scipy + rapidfuzz + jellyfish (Hungarian +
phonetic) · Decimal money math · Typst (Rust-backed PDF) · Rust + axum + sqlx + tokio
(dispatch) · OpenAI tool-calling (swap-ready) · React 19 + Vite 8 + Tailwind +
TanStack Query · `bun` for JS/TS, `uv` for Python, `cargo` for Rust. No npm/yarn/pip.

## License

MIT.

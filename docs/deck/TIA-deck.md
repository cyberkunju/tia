---
marp: true
theme: default
size: 16:9
paginate: true
header: 'TIA — Touchless Invoice Agent · TASC × HackArena 2.0'
style: |
  section { font-family: 'Inter', 'Helvetica Neue', sans-serif; padding: 50px 60px; }
  h1 { color: #d9531e; font-size: 50px; }
  h2 { color: #d9531e; font-size: 36px; border-bottom: 3px solid #d9531e; padding-bottom: 6px; }
  h3 { color: #333; }
  strong { color: #d9531e; }
  table { font-size: 22px; }
  th { background: #d9531e; color: white; }
  code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 20px; }
  blockquote { border-left: 4px solid #d9531e; padding-left: 12px; color: #555; }
---

# **TIA**
## Touchless Invoice Agent

**For TASC Outsourcing — UAE manpower supply, scaled.**

> Any client's timesheet, in any format, all the way to a validated tax invoice in their inbox — with people stepping in only by exception.

_Team Cyberkunju · HackArena 2.0 · 2026-06-28_

---

## The problem we're solving

**Mariam, FinOps Lead at TASC** invoices **750+ clients** every month for **10,500+ associates** placed across UAE/GCC.

| Today | Why it hurts |
|---|---|
| Timesheets arrive in **7 different shapes** — clean Excel, scanned PDFs, photos of handwritten registers, plain emails | Every channel a new exception |
| FinOps **re-keys each row** into a consolidated Excel | 200+ rows × 10+ clients × 30 days |
| Bills hand-checked against per-client contract rules, then emailed | Days of cycle, no visibility for the client |
| MOHRE WPS file, VAT, TRN, sequential numbering all manual | Compliance risk on every cycle |

> Existing AP tools read invoices. **Nobody reads handwriting in three formats AND validates the contract behind it.**

---

## Our approach — 4 agents, deterministic core

1. **Data Capture Agent** — Ingests from **4 channels**: portal · email (direct / cc-silent / watched-mailbox) · online form · image/PDF OCR
2. **Verification Agent** — Hungarian assignment (scipy `linear_sum_assignment`) maps named rows → employee IDs; the **cost matrix is visible** in the Why drawer
3. **Statutory Compliance Agent** — **10 BTP-style contract-bound rules**, deterministic decimal math, UAE Federal Decree-Law 33/2021 OT multipliers, WPS SIF generator
4. **Commercial Billing Agent** — UAE Tax Invoice (TRN, VAT, sequential no., SAC code), Ramco SRP-shaped consolidated Excel, idempotent dispatch

The LLM only touches **handwriting OCR** and **grounded chat**. Money, validation, rendering — all deterministic, auditable, replayable.

---

## Reference architecture (matches the brief's diagram)

![bg right:38% w:90%](../../../tmp/tia-arch-0.png)

**4 channels → ingestion+OCR → Smart Bot + SAP → BTP validation → dispatch**

- `events` table: append-only audit spine, unique idempotency keys
- 14 gold cases, eval gate 13/13 PASS (F1 + ECE)
- Smart Bot + SAP block emits **consolidated Excel** (Ramco-shaped) **+ WPS SIF** (real MOHRE format)
- Per-client config: jurisdiction (UAE/KSA/IN), VAT rate, rate card, max OT %, dispatch order + grouping, watched mailboxes

---

## Stack & no-wrapper credentials

| Layer | What we picked | Why it's not a wrapper |
|---|---|---|
| **Extraction** | GLM-OCR (open-weight, self-hosted via Modal vLLM) + openpyxl + pdfplumber | We control inference; swap to any OpenAI-compatible endpoint |
| **Resolution** | rapidfuzz + jellyfish phonetic + scipy Hungarian | Globally optimal assignment, audit-visible cost matrix |
| **Validation** | 10 pure-function rules, Decimal money math | Per-contract config; rule_id surfaced on every failure |
| **Invoice** | Typst (Rust compiler, deterministic PDF) | FTA-compliant tax invoice template, audit hash footer |
| **Dispatch** | Rust + axum + sqlx (port 8001), idempotency-keyed | Real microservice, not a Python stub |
| **Chat** | OpenAI tool-calling, strict citations, swap-ready via `OPENAI_BASE_URL` | Answers refuse without DB evidence |

---

## The hard cases — judged by what we route, not what we autofill

| Case | Format | What TIA does |
|---|---|---|
| 1, 8 | Email — name only / ambiguous name | Hungarian sees **3 candidate IDs for "Aisha Al Zaabi"**, routes to HITL with cost matrix |
| 4 | **Handwritten image** | GLM-OCR (markdown + KIE fallback) → 3 rows extracted, confidence per field |
| 11 | Typed **PDF** | pdfplumber text-layer → 3 rows in 80ms |
| 13 | Email against a **FIXED_SCOPE contract** whose SOW is already COMPLETED | Rule **R5 sow_hours_not_exceeded** fires — exactly the mentor's "completed early" case |
| 14 | Excel with 50 OT hours on 22 working days | Rule **R4 ot_within_contract_cap** — 28% > contract's 20% — routes to HITL |

**Eval: 13/13 PASS. Macro F1 ≈ 0.68 across 7 fields. ECE 0.07 (well-calibrated).**

---

## Results — every brief success measure addressed

| Brief target | TIA today |
|---|---|
| **80%+ touchless** (auto routing) | `GET /metrics/stp` — live counter on Finance dashboard |
| **Within minutes** start to finish | `GET /metrics/time-to-invoice` — sub-second on Excel, ~2s on handwriting |
| **99%+ accuracy**, low-conf routed to a person | `GET /metrics/accuracy` — eval F1 published; HITL drawer for the rest |
| Mock SAP / Ramco | `/consolidate/{client}/{period}.xlsx` (30 SAP-shaped columns) + `payroll_processed_by_sap` event |
| WPS bank file | `/payroll/sif/{client}/{period}.sif` — SCR + EDR records, MOHRE filename pattern |
| UAE tax invoice | Typst PDF with "Tax Invoice" header, supplier+customer TRN, sequential no., VAT line, SAC for India |

> **17 commits, 67/67 pytest, CI 4 jobs green, eval 13/13 on every push.**

---

## Roadmap — what swaps in on day 2

1. **Real Ramco SRP connector** — `/consolidate` already emits Ramco-shaped columns; needs only the API mapping
2. **Peppol PINT AE XML emit** — Invoice schema is already Peppol-shaped (TRN, VAT, sequential, place of supply); add the XML transform when UAE mandate goes live (June 2026)
3. **AIDA WhatsApp bridge** — Plug TIA's `/qa` into TASC's existing AIDA bot; Navaneeth's bridge is already running in the repo (`workers/whatsapp/`)
4. **Local-model swap for chat** — Same `/qa` endpoint, point `OPENAI_BASE_URL` at a Modal-served vLLM. Zero code change.
5. **Postgres 18 + pg_trgm** — SQLite today; one env var flip away

**Thank you. Demo screen → next.**

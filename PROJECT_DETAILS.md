# TIA — Touchless Invoice Agent: Complete Project Documentation

## Overview

TIA is a self-hosted, open-weight AI agent that ingests staffing timesheets in 7+ input shapes (clean Excel, punch-clock Excel, handwritten photos, structured/unstructured emails, PDFs, quoted-reply threads, messy spreadsheets), resolves them against a payroll master, generates client-billable invoices through a mock ERP, validates them deterministically, dispatches per client rule, and exposes the entire flow to three personas (Client / FinOps / Finance) with bbox-anchored provenance, calibrated confidence, human-in-the-loop on exceptions, full audit trail, and a live eval dashboard with a CI gate.

**Built for:** HackArena 2.0 / IgniteRoom × TASC Outsourcing (UAE)

**Key constraint:** No-AI-wrapper rule — every model in the inference path is open-weight and self-hosted (GLM-OCR on Modal GPU). The model is one node; the engineering (evidence graph, Hungarian matcher, deterministic validators, eval+CI gate, audit log) is the other twelve.

**Headline differentiator:** Reverse-billing AR generated from a timesheet against a *deliberately ambiguous* master (e.g. two `Fatima Khan` at the same client), where a Hungarian assignment — not a fuzzy name lookup — does the entity resolution.

---

## Architecture

| Layer | Tech |
|---|---|
| Frontend | React 19 + Vite 8 + TypeScript 6, Tailwind CSS 3, TanStack Query 5, React Router 7, Zustand 5, Framer Motion, Lucide icons |
| Backend API | Python 3.12 · FastAPI · Uvicorn · SQLAlchemy 2.0 |
| Database | SQLite (dev) / PostgreSQL 18 (prod target) · JSONB · append-only events |
| AI/Doc Workers | Python 3.12 · uv · Pydantic v2 · openpyxl · pdfplumber · rapidfuzz · scipy · jellyfish · Pillow · imagehash |
| OCR Serving | vLLM · GLM-OCR on Modal (OpenAI-compatible endpoint) · markdown + KIE prompt modes |
| Matching | rapidfuzz similarity · jellyfish phonetic (Metaphone) · scipy Hungarian assignment (visible cost matrix) |
| Validation | Deterministic rules · Decimal money math · threshold approval routing |
| Invoice Rendering | Typst (Rust-backed Python wheel) · PDF generation with audit hash |
| Package Managers | **Bun only** (JS/TS), **uv only** (Python) — no npm/yarn/pip/poetry |

**Target architecture** (additive layering): NATS JetStream events, Rust Axum backend, SeaweedFS object storage, Qdrant vector retrieval, OpenTelemetry/Prometheus/Grafana observability. Current demo runs on Postgres + local staging + direct calls.

---

## Monorepo Layout

```
tia/
├── apps/
│   ├── web/              React + Vite frontend (bun)
│   └── api/              Placeholder for Rust Axum (future)
├── workers/
│   └── ai/              Python 3.12 (uv): all AI/doc workers + API
│       ├── tia_ai/
│       │   ├── api/         FastAPI app (app.py)
│       │   ├── extract/     Extraction dispatch + per-format extractors
│       │   ├── match/       Entity resolver + Hungarian assignment
│       │   ├── validate/    Deterministic validation rules
│       │   ├── erp/         Mock ERP invoice builder
│       │   ├── invoice/     Typst PDF renderer
│       │   ├── ocr/         GLM-OCR client (Modal endpoint)
│       │   ├── eval/        Eval harness (F1, ECE, pass/fail)
│       │   ├── schema.py    Canonical Pydantic schemas
│       │   ├── models.py    SQLAlchemy ORM (8 tables)
│       │   ├── db.py        Engine + session factory
│       │   ├── config.py    Runtime configuration + .env loader
│       │   ├── seed.py      Master data seeder from TASC xlsx
│       │   ├── synthgen.py  Synthetic test case generator (10 cases)
│       │   ├── orchestrator.py  Pipeline state machine
│       │   └── canonicalize.py  Leave codes, periods, punch summaries
│       └── tests/           pytest suite (7 test files)
├── data/
│   ├── seed/            TASC_Sample_Database_vF.xlsx (master data)
│   ├── synthetic/       Generated test inputs (10 cases, 7 formats)
│   └── gold/            Eval ground truth JSON per case
├── db/                  PostgreSQL schema placeholder
├── services/            Rust services placeholder (orchestrator, dispatch, invoice, validation)
├── infra/               Observability configs placeholder
├── docs/                Problem statement PDFs + brief
├── staging/             Runtime file staging (NVMe target, gitignored)
├── .github/workflows/   CI pipeline (ci.yml)
├── Makefile             Build/run commands
├── CONTRACTS.md         Stable interface contracts
├── .env.example         Environment template
└── tia.db               SQLite dev database (gitignored)
```

---

## Database Schema (SQLAlchemy ORM — `workers/ai/tia_ai/models.py`)

Portable across SQLite (dev) and PostgreSQL 18 (prod). Append-only `events` table is the audit spine.

### Master Data Tables

#### `clients`
| Column | Type | Notes |
|--------|------|-------|
| `code` | String (PK) | e.g. "CL001" |
| `name` | String | "Emirates Steel Industries LLC" |
| `city` | String (nullable) | |
| `industry` | String (nullable) | |
| `contact_email` | String (nullable) | |
| `status` | String | default "Active" |
| `currency_default` | String | default "AED" |
| `settings` | JSON | dispatch_rule, threshold_aed, markup_pct, approval_matrix |

#### `employees`
| Column | Type | Notes |
|--------|------|-------|
| `emp_id` | String (PK) | e.g. "EMP10001" |
| `full_name` | String (indexed) | |
| `first_name`, `last_name` | String (nullable) | |
| `email` | String (indexed, nullable) | |
| `client_code` | FK → clients.code (indexed) | |
| `client_name` | String (nullable) | |
| `job_title`, `department`, `nationality` | String (nullable) | |
| `date_of_joining` | String (nullable) | |
| `status` | String | default "Active" |
| `iban` | String (nullable) | |
| `basic`, `housing`, `transport`, `food`, `phone`, `total_ctc` | Float | salary components |

#### `payroll`
| Column | Type | Notes |
|--------|------|-------|
| `id` | String (PK, UUID) | |
| `emp_id` | FK → employees.emp_id (indexed) | |
| `employee_name` | String (nullable) | |
| `client_code` | String (indexed) | |
| `period` | String (indexed) | e.g. "June 2026" |
| `basic`, `housing`, `transport`, `food`, `phone` | Float | component breakdown |
| `gross`, `ot_hours`, `ot_amount`, `deductions`, `net_pay` | Float | computed pay |
| `currency` | String | default "AED" |
| `working_days` | Integer | standard days in period (20-26) |

### Operational Tables

#### `doc_assets`
| Column | Type | Notes |
|--------|------|-------|
| `id` | String (PK, UUID) | |
| `content_hash` | String (unique, indexed) | SHA-256 for dedup |
| `phash` | String (nullable) | perceptual hash for images |
| `source_channel` | String | "upload" / "email" / "whatsapp" |
| `mime` | String (nullable) | |
| `staging_path` | String (nullable) | local NVMe path |
| `uploaded_by` | String (nullable) | |
| `uploaded_at` | DateTime | |
| `doc_class` | String (nullable) | document classification |
| `quality_score` | Float (nullable) | |

#### `timesheets`
| Column | Type | Notes |
|--------|------|-------|
| `id` | String (PK, UUID) | |
| `doc_id` | FK → doc_assets.id (nullable) | |
| `client_code` | String (nullable) | resolved client |
| `period` | String (nullable) | "June 2026" |
| `status` | String (indexed) | ingested → validated → approved → invoice_generated → dispatched |
| `routing` | String (nullable) | "auto" / "hitl" / "escalate" |
| `confidence_calibrated` | Float (nullable) | final confidence (never from model) |
| `hitl_reason` | String (nullable) | why human review needed |
| `extraction` | JSON | full TimesheetExtraction |
| `resolved_rows` | JSON | invoice line items |
| `validations` | JSON | validation results array |
| `match_result` | JSON | full MatchResult with cost matrix |
| `created_at` | DateTime | |

#### `hypotheses`
| Column | Type | Notes |
|--------|------|-------|
| `id` | String (PK, UUID) | |
| `timesheet_id` | FK → timesheets.id (indexed) | |
| `field_name` | String | extracted field name |
| `value` | Text (nullable) | extracted value |
| `bbox` | JSON (nullable) | bounding box {page, norm:[x1,y1,x2,y2]} |
| `source_block_id` | String (nullable) | OCR block reference |
| `raw_confidence` | Float | model raw signal (default 1.0) |
| `signals` | JSON | multi-signal evidence |
| `status` | String | "extracted" |

#### `invoices`
| Column | Type | Notes |
|--------|------|-------|
| `id` | String (PK, UUID) | |
| `timesheet_id` | FK → timesheets.id (indexed) | |
| `client_code` | String (indexed) | |
| `period` | String (nullable) | |
| `amount` | Float | total billable AED |
| `currency` | String | default "AED" |
| `line_items` | JSON | per-employee billing breakdown |
| `pdf_path` | String (nullable) | rendered PDF path |
| `status` | String (indexed) | "generated" → "dispatched" |
| `dispatch_idempotency_key` | String (unique, nullable) | replay guard |
| `dispatch_attempted_at` | DateTime (nullable) | |
| `created_at` | DateTime | |

#### `corrections`
| Column | Type | Notes |
|--------|------|-------|
| `id` | String (PK, UUID) | |
| `hypothesis_id` | String (nullable) | |
| `timesheet_id` | String (indexed, nullable) | |
| `field_name` | String (nullable) | |
| `original_value`, `corrected_value` | Text (nullable) | |
| `by_user` | String (nullable) | |
| `at` | DateTime | |

#### `events` (Append-Only Audit Spine)
| Column | Type | Notes |
|--------|------|-------|
| `id` | String (PK, UUID) | |
| `actor` | String (nullable) | "system" / "finops" / "client" |
| `entity_kind` | String (indexed) | "doc" / "timesheet" / "invoice" / "client" |
| `entity_id` | String (indexed) | |
| `action` | String | "ingested", "extracted", "resolved", "routed", "approved", etc. |
| `payload` | JSON | action-specific data |
| `idempotency_key` | String (unique constraint, nullable) | dedup retries |
| `at` | DateTime | |

---

## Canonical Schemas (`workers/ai/tia_ai/schema.py`)

Source of truth shared between all pipeline stages (mirrors CONTRACTS.md §4).

### `TimesheetExtraction`
```json
{
  "client_code": "string|null",
  "client_hint": "string|null",
  "period": "YYYY-MM or 'Month Year'",
  "signed_by": "string|null",
  "rows": [TimesheetRow],
  "confidence_per_field": {"field_path": float}
}
```

### `TimesheetRow`
```json
{
  "employee_name": "string",
  "emp_id": "string|null",
  "days_worked": "float|null",
  "hours": "float|null",
  "ot_hours": "float|null",
  "leave_codes": ["AL", "SICK", "UNPAID", "PUBLIC_HOLIDAY", "ABSENT", "PRESENT"],
  "reimbursements": [{"reason": "string", "amount_aed": float}],
  "notes": "string|null"
}
```

### Leave Code Enum
| Code | Meaning | Raw variants mapped |
|------|---------|-------------------|
| `AL` | Annual Leave | A/L, A-L, annual, annual leave, vacation |
| `SICK` | Sick Leave | S, SL, S/L, sick, sick leave |
| `UNPAID` | Unpaid Leave | LWP, unpaid, unpaid leave |
| `PUBLIC_HOLIDAY` | Public Holiday | PH, holiday, public holiday |
| `ABSENT` | Absent | A, abs, absent |
| `PRESENT` | Present | P, present |

### `MatchResult`
```json
{
  "matches": [RowMatch],
  "cost_matrix": [[float]],       // rows × candidates, for "Why?" drawer
  "candidate_labels": ["EMP10001 Carlos Smith"],
  "row_labels": ["Carlos Smith"]
}
```

### `RowMatch`
```json
{
  "row_idx": int,
  "chosen_emp_id": "string|null",
  "candidates": [Candidate],
  "ambiguous": bool,
  "confidence": float,            // computed here, never from model
  "reason": "string"
}
```

### `ValidationResult`
```json
{
  "rule": "math_gross|math_net|working_days_bounds|currency_aed|attendance_bounds|threshold_approval",
  "passed": bool,
  "message": "string",
  "severity": "error|warning"
}
```

### Routing Enum
- `auto` — fully resolved, all validations pass → invoice generated immediately
- `hitl` — ambiguous match or validation failure → awaiting human review
- `escalate` — no rows extracted (empty/corrupt document) → needs manual intervention

---

## Pipeline Flow (Orchestrator — `workers/ai/tia_ai/orchestrator.py`)

The orchestrator drives a document through a deterministic state machine:

```
Ingest → Extract → Resolve → Validate → Route → [Invoice] → [Dispatch]
```

### 1. Ingest (`ingest_file`)
- Stage file to NVMe staging dir
- SHA-256 content-hash dedup (same bytes → same doc_id)
- Create `DocAsset` record + audit event

### 2. Extract (`extract/`)
- Route by mime/suffix to the appropriate extractor:
  - `.xlsx/.xls` → `extract_excel()` — openpyxl, detects clean vs. punch layout
  - `.eml/.txt` → `extract_email()` — regex/heuristic parser (no LLM)
  - `.png/.jpg/.tiff` → `extract_image()` → GLM-OCR markdown → text parser → fallback KIE JSON
  - `.pdf` → `extract_pdf()` — pdfplumber text layer → email parser; scanned → rasterize → vision
- Empty/corrupt files return empty `TimesheetExtraction` (never crash)

### 3. Resolve (`match/resolver.py`)
- Resolve client: exact code match → fuzzy name match against `clients` table
- Per-row candidate retrieval (tiered):
  1. **Tier 1:** Emp ID exact match → definitive (confidence 0.99)
  2. **Tier 2:** Exact name within client scope
  3. **Tier 3:** Fuzzy name (rapidfuzz WRatio, threshold 0.82)
  4. **Tier 4:** Phonetic (jellyfish Metaphone)
- Build cost matrix (1 - score per row×candidate)
- **Hungarian assignment** (scipy `linear_sum_assignment`) for globally consistent picks
- Ambiguity detection: top-2 within 0.06 margin + both above threshold → `ambiguous=True`

### 4. Validate + Invoice (`erp/mock.py`)
- Per-employee: prorate monthly cost by attendance, add OT + reimbursements, apply client markup
- Deterministic validation rules (decimal math):
  - `math_gross`: Gross == Basic + Housing + Transport + Food + Phone
  - `math_net`: Net == Gross + OT_Amount - Deductions
  - `working_days_bounds`: Working days ∈ [20, 26]
  - `currency_aed`: Currency must be AED
  - `attendance_bounds`: Days worked ≤ working days + 1
  - `threshold_approval`: Amount < client threshold (else Finance approval needed)

### 5. Routing Decision
| Condition | Routing | Status |
|-----------|---------|--------|
| No rows extracted | `escalate` | awaiting_review |
| Any match ambiguous | `hitl` | awaiting_review |
| Any validation error (non-warning) | `hitl` | awaiting_review |
| All clear | `auto` | approved → invoice_generated |

### 6. Invoice Generation (`invoice/render.py`)
- Typst source templating → PDF compilation (Rust-backed, deterministic)
- TASC-branded A4 layout with line items table, totals, warnings, exception list
- SHA-256 audit hash in footer for tamper-evidence
- PDF stored in staging dir

### 7. Dispatch (`dispatch_invoice`)
- Idempotent: keyed by `dispatch_idempotency_key` (refuses to re-fire)
- Mock webhook adapter (extensible to SMTP/webhook)
- Audit event logged

### HITL Approval Flow (`approve_timesheet`)
- Apply corrections (user resolves ambiguous matches by picking emp_id)
- Rebuild invoice from corrected match + extraction
- Generate new invoice PDF
- Mark timesheet approved, create audit trail

---

## API Endpoints (`workers/ai/tia_ai/api/app.py`)

FastAPI app running on port 8000. Full CORS enabled. Idempotency-Key honored on all mutations.

### Intake
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/intake/upload` | File upload (multipart) → full pipeline → returns routing |
| POST | `/intake/email` | JSON email body → pipeline |
| POST | `/intake/whatsapp` | WhatsApp bridge payload (attachment_url or text) → pipeline |

### Documents & Timesheets
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/documents` | List all docs (limit 100), with timesheet status |
| GET | `/documents/{doc_id}` | Full doc + timesheet + invoices |
| GET | `/documents/{doc_id}/source` | Download original staged file |
| POST | `/timesheets/{ts_id}/approve` | HITL approve with corrections |
| POST | `/timesheets/{ts_id}/reject` | Reject with reason |

### Invoices
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/invoices` | List (optional ?client_code= &status= filters) |
| GET | `/invoices/{inv_id}` | Single invoice detail |
| GET | `/invoices/{inv_id}/pdf` | Download rendered PDF |
| GET | `/invoices/{inv_id}/audit` | Full audit trail (events across doc→ts→invoice) |
| GET | `/invoices/{inv_id}/why` | Structured "Why this invoice?" payload |
| POST | `/invoices/{inv_id}/dispatch` | Idempotent dispatch (requires Idempotency-Key) |

### Clients
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/clients` | List all clients with settings |
| PUT | `/clients/{code}/settings` | Update dispatch_rule, threshold_aed, markup_pct |

### Events & Eval
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/events/stream` | SSE stream of audit events (real-time) |
| GET | `/eval` | Run eval harness, return summary |
| POST | `/eval/run` | Run eval + persist results to gold/_last_run.json |
| GET | `/health` | Health check |

---

## OCR System (`workers/ai/tia_ai/ocr/__init__.py`)

GLM-OCR on Modal (teammate-owned, scale-to-zero). OpenAI-compatible vLLM endpoint.

### Two Prompt Modes

**1. Markdown (primary):** Image → faithful markdown transcription. Parsed by the email extractor.
```
POST {base}/v1/chat/completions
model: "glm-ocr"
prompt: "Convert this document to Markdown. Transcribe handwriting faithfully..."
```

**2. KIE (fallback):** Image + JSON schema → filled TimesheetExtraction JSON.
```
POST {base}/v1/chat/completions
model: "glm-ocr"
prompt: "You are extracting a staffing timesheet. Return ONLY a JSON object..."
```

**3. Layout:** Image → `[{bbox, category, text}]` for provenance anchoring.

**Fallback chain:** GLM-OCR markdown → parse → if no rows → GLM-OCR KIE JSON.

### Configuration
- `GLM_OCR_BASE_URL`: `https://versifine--glm-ocr-serve.modal.run`
- `GLM_OCR_API_KEY`: Required for vision cases (case 4)
- Timeout: 180s (Modal cold start ~15-30s)

---

## Extraction Details

### Excel Extractor (`extract/excel.py`)
Auto-detects two layouts from header row:
- **Clean layout** (case 7, 9): Emp ID / Name / Working Days / OT / Leave columns
- **Punch layout** (case 5): Per-day In/Out time columns → summarized to days+hours via `summarize_punches()`

Handles: blank rows, extra columns, missing cells, mixed leave code spellings.

### Email Extractor (`extract/email.py`)
Pure regex/heuristic — handles 6 email shapes with no LLM:
- Case 1: Payout request (name + client + period + total, no Emp ID)
- Case 2: From employee (Emp ID + days in prose)
- Case 3: From client (client + roster of names + days, no Emp IDs)
- Case 6: Structured (Emp ID + leave + reimbursements + amounts)
- Case 8: 3-way ambiguity (single name, no context)
- Case 10: Quoted-reply email (must ignore `>` quoted history)

**Key regex patterns:**
- `EMP\d{4,}` — employee IDs
- Period: `Mon YYYY`, `YYYY-MM`, `MM/YYYY`
- `\d+ days`, `\d+ OT`, leave codes, reimbursement amounts
- Leading name extraction with noise filtering (Dear, Hi, Subject, etc.)

### Vision Extractor (`extract/vision.py`)
1. Read image bytes
2. Call `glm_markdown()` → parse result with email extractor
3. If no rows: call `glm_kie()` → direct JSON parse
4. On any exception: return empty TimesheetExtraction (graceful degradation)

### PDF Extractor (`extract/pdf.py`)
1. Try pdfplumber text extraction
2. If text layer ≥ 20 chars: parse like email body
3. Else (scanned): rasterize page 1 → route to vision extractor

---

## Canonicalization (`workers/ai/tia_ai/canonicalize.py`)

Deterministic pure functions mapping messy real-world variants:

- **Leave codes:** 20+ raw variants → 6 canonical enum values
- **Periods:** "Jun 2026", "2026-06", "06/2026", "June-2026" → "June 2026"
- **Punch summaries:** List of (in, out) time pairs → (total_days, total_hours)
  - Valid pair (out > in): 1 day, hours = out - in
  - Missing/invalid: 0 day, 0 hours

---

## Frontend (`apps/web/`)

React 19 + Vite 8 + TypeScript 6 SPA with persona-based navigation.

### Tech Stack
- **React Router 7** — file-based routing with nested layout
- **TanStack Query 5** — data fetching with 2s stale time
- **Zustand 5** — persona state (persisted to localStorage)
- **Tailwind CSS 3** — utility-first styling with TASC brand colors
- **Framer Motion** — animations
- **Lucide React** — icons
- **oxlint** — linting (not ESLint)

### Pages (8 total)

| Route | Component | Persona | Description |
|-------|-----------|---------|-------------|
| `/client/submit` | ClientSubmit | Client | Upload timesheets (file or email body) |
| `/client/invoices` | ClientInvoices | Client | View generated invoices |
| `/finops` | FinOpsInbox | FinOps | Document inbox with status/routing badges |
| `/finops/review/:docId` | FinOpsReview | FinOps | Full review: extraction, match matrix, validations, approve/reject |
| `/finops/triage` | FinOpsTriage | FinOps | Triage queue (HITL items) |
| `/finops/dispatch` | FinOpsDispatch | FinOps | Invoice dispatch with PDF preview |
| `/finops/eval` | FinOpsEval | FinOps | Live eval dashboard (F1, ECE, per-case results) |
| `/finance` | FinanceDashboard | Finance | Close dashboard overview |

### Persona Switching
Three personas with different nav items:
- **Client:** Submit timesheet, My invoices
- **FinOps:** Inbox, Triage, Dispatch, Eval
- **Finance:** Close dashboard

Persona stored in Zustand with `persist` middleware (survives page refresh).

### API Client (`src/api.ts`)
- Centralized fetch wrapper with error handling
- Auto-generates `Idempotency-Key` (crypto.randomUUID) for all mutations
- Configurable `VITE_API_BASE` (defaults to `http://127.0.0.1:8000`)

### TypeScript Types (`src/types.ts`)
Full mirror of Python schemas: TimesheetExtraction, MatchResult, ValidationResult, Invoice, DocSummary, InvoiceWhy, EvalRunResult, etc.

---

## Data Pipeline

### Seed (`workers/ai/tia_ai/seed.py`)
Loads master data from `data/seed/TASC_Sample_Database_vF.xlsx`:
- **Customers sheet** → `clients` table (10 clients)
- **Employees sheet** → `employees` table (~200 employees)
- **Payroll sheet** → `payroll` table (~200 rows)

Idempotent: wipes and reseeds on every run.

### Synthetic Data Generation (`workers/ai/tia_ai/synthgen.py`)
Generates 10 test cases covering all 7+ input shapes:

| Case | File | Format | Tests |
|------|------|--------|-------|
| 01 | case_01_email_no_empid.eml | Email | Ambiguous name (2 Fatima Khans at same client) → HITL |
| 02 | case_02_email_employee.txt | Email | Employee writes prose with EMP ID + days |
| 03 | case_03_email_client_full.eml | Email | Client submits roster (names + days, no IDs) |
| 04 | case_04_handwritten.png | Image | PIL-generated handwritten-style timesheet → GLM-OCR |
| 05 | case_05_punch.xlsx | Excel | Punch in/out per day → summarized hours |
| 06 | case_06_email_structured.txt | Email | Structured: EMP IDs + leave + reimbursements |
| 07 | case_07_clean.xlsx | Excel | Clean spreadsheet with all fields |
| 08 | case_08_aisha_3way.eml | Email | 3-way ambiguity (cross-client) → HITL |
| 09 | case_09_messy.xlsx | Excel | Blank rows, extra columns |
| 10 | case_10_email_quoted_reply.eml | Email | Quoted reply thread (must ignore `>` lines) |

### Gold Ground Truth (`data/gold/`)
One JSON per case with expected extraction results. Fields:
- `input`: filename in synthetic/
- `channel`: "upload" or "email"
- `expect.client_code`: expected resolved client
- `expect.period`: expected period
- `expect.rows[]`: per-row expectations (emp_id, days, leave, resolved, ambiguous, candidates)

---

## Eval Harness (`workers/ai/tia_ai/eval/run.py`)

### Metrics
- **Per-field F1:** emp_id, days_worked, ot_hours, hours, leave_codes, resolved, ambiguous
- **Macro F1:** average across all cases per field
- **ECE (Expected Calibration Error):** 5-bin calibration of confidence vs. correctness
- **Per-case pass/fail:** all rows must match gold expectations
- **Latency:** wall-clock time per case

### Join Strategy
Gold rows joined to pipeline output by:
1. Resolved emp_id (preferred)
2. Employee name (fallback)

Fields gold is silent on → not penalized (no grade for what wasn't asked).

### CI Gate Thresholds
- All 9 non-vision cases must PASS
- `days_worked` macro F1 ≥ 0.98
- `resolved` macro F1 ≥ 0.98
- Case 4 (vision) skipped in CI without GLM_OCR_API_KEY

---

## CI/CD (`.github/workflows/ci.yml`)

5-job pipeline on push to master/main + PRs:

| Job | What | Timeout |
|-----|------|---------|
| `backend-tests` | `uv run pytest tests/ -q` | 8min |
| `frontend-build` | `bun install --frozen-lockfile` + `bun run lint` + `bun run build` (tsc + vite) | 8min |
| `eval-harness` | seed + synth + run 9 cases + F1/ECE gates | 8min |
| `api-smoke` | Boot uvicorn, curl health/clients/upload/eval/documents | 8min |
| `ci-status` | Aggregator gate (all 4 must succeed) | — |

Concurrency: `ci-${{ github.ref }}`, cancel-in-progress.

---

## Makefile Commands

```makefile
make install    # uv sync (python) + bun install (frontend)
make seed       # Seed master data from TASC xlsx → SQLite
make synth      # Generate 10 synthetic test cases + gold ground truth
make eval       # Run eval harness (F1, ECE, pass/fail per case)
make api        # FastAPI on http://127.0.0.1:8000 (--reload)
make web        # Vite dev server on http://127.0.0.1:5173
make dev        # api + web in parallel
make demo       # Full: install → seed → synth → eval → instructions
make demo-seed-3 # Upload 3 test cases to running API via requests
make clean      # Remove .venv, node_modules, dist, staging, tia.db
```

---

## Configuration (`workers/ai/tia_ai/config.py`)

Minimal .env loader (no external dep). Checks repo root and worker dir.

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `sqlite:///tia.db` | DB connection string |
| `GLM_OCR_BASE_URL` | `https://versifine--glm-ocr-serve.modal.run` | OCR endpoint |
| `GLM_OCR_API_KEY` | (empty) | Required for case 4 vision |
| `TIA_STAGING_DIR` | `{repo}/staging` | File staging directory |

### Key Paths
- `REPO_ROOT`: 3 parents up from config.py
- `DATA_DIR`: `{repo}/data`
- `SEED_XLSX`: `data/seed/TASC_Sample_Database_vF.xlsx`
- `STAGING_DIR`: created on import if missing

---

## Test Suite (`workers/ai/tests/`)

7 test files, pytest-based:

| File | Coverage |
|------|----------|
| `test_api.py` | E2E: upload clean→auto, upload ambiguous→hitl, dedup, empty→escalate, dispatch idempotency, why drawer, eval endpoint |
| `test_extract_email.py` | All email cases: prose, roster, structured, reimbursements, noise filtering |
| `test_resolver.py` | Client resolution (exact/fuzzy), emp_id definitive, unique name, ambiguity detection |
| `test_validators.py` | Gross/net math, working days bounds, currency, attendance, threshold |
| `test_hungarian.py` | Cost matrix assignment, collision avoidance, non-square matrices |
| `test_canonicalize.py` | Leave codes, period normalization, punch summaries |
| `conftest.py` | Per-session temp SQLite, auto DB init |

---

## Contracts (`CONTRACTS.md`)

Stable interfaces for parallel development:

1. **OCR serving** — GLM-OCR on Modal (OpenAI-compatible vLLM, KIE + Layout modes)
2. **WhatsApp bridge** — POST `/intake/whatsapp` with idempotency
3. **NATS JetStream events** — Stream "TIA" with 8 subject patterns (doc.*, invoice.*)
4. **Canonical schema** — `TimesheetExtraction` (shared source of truth)
5. **Worker RPC** — POST /extract, /match, /ocr/kie, /ocr/layout
6. **Idempotency & audit** — Every mutation needs Idempotency-Key, events table dedup

---

## Key Design Decisions

1. **No-wrapper architecture:** 70% of extraction works without any LLM (Excel + email regex). Only handwritten/scanned images need GLM-OCR.
2. **Hungarian assignment over fuzzy lookup:** Prevents two timesheet rows from claiming the same employee. Makes ambiguity explicit and HITL-routable.
3. **Confidence never from model:** Final calibrated confidence is computed by matcher + validators. Model signals are inputs, not outputs.
4. **Deterministic validation:** Decimal money math catches errors regardless of extraction path. The math reconciler doesn't care whether values came from Excel, email, or OCR.
5. **Eval-gated CI:** PRs fail if extraction regresses. F1 and ECE thresholds enforced.
6. **Content-hash dedup:** Same bytes uploaded twice → same doc_id (no reprocessing).
7. **Idempotency everywhere:** Every mutating API call requires Idempotency-Key. External side-effects check events table before firing.
8. **Typst for PDF:** Rust-backed, reproducible, typographic-grade invoices with audit hash.
9. **Append-only events:** Full audit trail; the events table is the durable log until NATS is wired.
10. **Graceful degradation:** Empty/corrupt inputs → empty extraction → escalate routing (never crash).

---

## Dependencies

### Python (`workers/ai/pyproject.toml`)
```
pydantic>=2.7, pydantic-settings>=2.3
fastapi>=0.115, uvicorn[standard]>=0.30
python-multipart>=0.0.9, httpx>=0.27
sqlalchemy>=2.0, openpyxl>=3.1, pdfplumber>=0.11
rapidfuzz>=3.9, scipy>=1.13, jellyfish>=1.0
pillow>=10.3, imagehash>=4.3, typst>=0.13
python-dateutil>=2.9
[dev] pytest>=8.2, ruff>=0.5
[ocr] opencv-python-headless>=4.10
```

### Frontend (`apps/web/package.json`)
```
react@^19.2.7, react-dom@^19.2.7
react-router-dom@^7.18.0
@tanstack/react-query@^5.101.1
zustand@^5.0.14
framer-motion@^12.42.0
lucide-react@^1.21.0
clsx@^2.1.1, tailwind-merge@^3.6.0
[dev] vite@^8.1.0, typescript@~6.0.2, tailwindcss@3, oxlint@^1.69.0
```

---

## Quickstart

```bash
# One-time setup
make install         # uv sync + bun install
cp .env.example .env # add GLM_OCR_API_KEY for vision case

# Seed + generate test data
make seed            # 10 clients, 200 employees, 200 payroll rows
make synth           # 10 sample inputs + gold ground truth

# Verify
make eval            # 9/9 PASS (case 4 needs OCR key), F1 + ECE printed

# Run
make api             # FastAPI on http://127.0.0.1:8000
make web             # Vite on http://127.0.0.1:5173
```

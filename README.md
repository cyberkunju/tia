<p align="center">
  <img src="assets/banner.svg" alt="TIA · Touchless Invoice Agent · TASC Outsourcing UAE" width="100%">
</p>

<p align="center">
  <a href="https://github.com/cyberkunju/tia/actions/workflows/ci.yml"><img src="https://github.com/cyberkunju/tia/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  &nbsp;·&nbsp; Python 3.12 · FastAPI &nbsp;·&nbsp; React 19 · Vite &nbsp;·&nbsp; Rust · axum &nbsp;·&nbsp; Postgres &nbsp;·&nbsp; MIT
</p>

# TIA · Touchless Invoice Agent

A staffing timesheet shows up however the client felt like sending it: a tidy
spreadsheet, a punch-clock export, a photo of a signed register, an email with
three people's hours buried in the body, a forwarded reply thread. Someone in
finance then re-keys it, matches names to employees, checks the contract, builds
the invoice, and emails it out in whatever order each client prefers.

TIA does that whole walk on its own, and only asks a human when something is
genuinely unclear. It reads the **source timesheet**, reconciles every person
against the payroll master, and then does the part most invoice tools skip: it
**validates the invoice against the client's contract**. Rate cards, overtime caps,
scope-of-work limits, VAT, closed periods, all of it gets checked before the
invoice is allowed to leave the building.

Built for the **TASC Outsourcing** challenge at **HackArena 2.0**. TASC runs UAE
manpower supply at real scale (10,500+ associates, 750+ clients), so "messy input
from many channels" and "the contract is the source of truth, not the timesheet"
are not hypotheticals here.

---

## The one idea worth keeping

Most automation in this space reads an invoice someone already made and tries to
approve it. That misses the expensive mistakes, because by the time a number is on
an invoice the error is already baked in.

TIA works the other way around. The timesheet is the raw material, the contract is
the spec, and the invoice is the output that has to match both. A model helps read a
blurry photo, but no model moves money. Extraction confidence is an input, not a
verdict. The final call comes from a deterministic matcher and a set of contract
rules that can each explain themselves in one plain sentence.

The target the brief set, and what TIA is tuned for:

- **80%+ touchless.** Clean cases go end to end with nobody touching them.
- **Minutes, not days**, from "received" to "dispatched".
- **99%+ accuracy**, and when confidence is low it routes to a person instead of guessing.

---

## How a timesheet becomes an invoice

```
Capture → Extract → Resolve → Validate → Generate → Dispatch → Operate
```

**Capture.** Timesheets arrive over six channels: portal upload, plain email, a
watched mailbox (real Zoho IMAP), an online form, a WhatsApp number, and direct
image/PDF upload. Every file is content-hashed on the way in, so the same bytes sent
twice never get processed twice.

**Extract.** Structured files are parsed directly. `openpyxl` handles Excel and tells
clean layouts from punch-clock layouts; `pdfplumber` reads text-layer PDFs. Only the
genuinely unstructured inputs (handwritten photos, scanned pages) go to a vision
model: GLM-OCR over an OpenAI-compatible endpoint, with a markdown pass first, a
schema-constrained JSON pass as fallback, and a layout pass that anchors each
extracted figure to a box on the source image. Everything lands in one canonical
`TimesheetExtraction` shape regardless of where it came from.

**Resolve.** This is the part that earns its keep. The master data is deliberately
ambiguous: two different `Fatima Khan`s at the same client, names that sound alike
across clients. A fuzzy lookup would happily assign both rows to the same person.
TIA builds a cost matrix (exact emp-ID, scoped exact name, `rapidfuzz` similarity,
`jellyfish` phonetics) and runs a **Hungarian assignment** (`scipy`) so the picks are
globally consistent and no two rows fight over one employee. When the top two
candidates are within a hair of each other, the row is flagged ambiguous and sent to
a human. The full cost matrix shows up in the review screen, so a reviewer can see
exactly why a match was made.

**Validate.** The mock ERP builds the invoice line by line: prorate the monthly cost
by attendance, add overtime and reimbursements, apply the client's markup, compute
VAT. Then the contract rules run (R1 to R15). Is this employee even on the contract,
does the billed rate match the rate card, is the period inside the contract term, is
overtime under the cap, has a fixed-scope SOW already been completed, does the math
reconcile, is VAT correct, is the period closed, is this bill suspiciously larger
than the employee's own history. Money math is exact, not floating-point
approximate. Each rule carries a stable ID and a plain-English message a client could
actually read.

**Generate.** A UAE Tax Invoice is rendered with Typst (Rust-backed, deterministic
output): TRN, 5% VAT, SAC code, place of supply, an invoice sequence number, a
SHA-256 audit hash in the footer, and a branded WhatsApp QR. Alongside it, the
Smart-Bot/SAP layer emits a Ramco-shaped consolidated workbook, a WPS SIF bank file,
and a SAP Business One A/R OData payload, with the audit hash carried into a
`U_TIA_AuditHash` field. Clawbacks produce a proper Tax Credit Note with the right
FTA references, including partial credit notes.

**Dispatch.** If every blocking rule passes and the amount is under the client's
threshold, the invoice auto-dispatches in that client's preferred order. Anything
else routes to FinOps or Finance. The side effect itself, the actual send, is owned
by a small **Rust** service with an idempotent outbox, so a retry never double-sends.

**Operate.** Client, FinOps, and Finance each get their own view of the same truth:
submit and track, triage and review, close the month. Every state change is written
to an append-only, hash-chained audit log that can be re-walked and verified end to
end.

---

## Architecture

```mermaid
flowchart LR
  subgraph In[Channels]
    P[Portal upload]
    E[Email / Zoho mailbox]
    F[Online form]
    W[WhatsApp]
    O[Image / PDF]
  end

  subgraph Core[FastAPI core · Python]
    IN[Intake]
    EX[Extractors]
    MA[Hungarian resolver]
    ER[Smart-Bot / SAP mock]
    RU[Contract rules R1..R15]
    IV[Typst invoice + credit note]
    AU[Hash-chained audit]
  end

  subgraph Out[Side effects]
    DS[Rust dispatch + outbox]
    ML[Zoho SMTP reply]
  end

  subgraph UI[Apps]
    WEB[React persona console]
    AI[TIA agent · MCP tools]
  end

  P & E & F & W --> IN
  O --> EX
  IN --> EX --> MA --> ER --> RU --> IV
  RU -->|clean & under threshold| DS --> ML
  RU -->|exception| WEB
  IV --> WEB
  AU --> WEB
  AU --> AI
```

Three runtimes, one source of truth. The **FastAPI core** owns the pipeline and the
database. A **Rust axum/sqlx** service owns dispatch so the money-moving side effect
is isolated and idempotent. A **Bun + Hono** bridge speaks the Meta WhatsApp Cloud
API. The **React** app is a single operating console with three persona modes. Models
sit only at the document edge (OCR) and the reasoning edge (the chat agent).

---

## Why it holds up

A model reading a document is the easy 10%. These are the parts that make the output
trustworthy.

**The matcher is an assignment problem, not a lookup.** Entity resolution is global,
not row by row. That single decision is what makes the duplicate-name cases solvable
instead of silently wrong, and it turns ambiguity into a first-class, routable state
rather than a coin flip.

**Confidence is computed, never borrowed from the model.** Raw OCR confidence is a
signal that feeds the matcher and validators. The number a reviewer sees is produced
by TIA's own logic, so a confident-but-wrong model cannot talk its way past the gate.

**Validation is deterministic and contract-bound.** The rules are plain Python with
exact money math. They do not care whether a value came from a spreadsheet, an email,
or a photo. The same R6 reconciliation catches the same error every time, and it
catches it against the contract, not just internal consistency.

**The audit log is the spine, and it is verifiable.** Every event stores the actor,
entity, action, payload, and a hash of the previous event plus its own. `GET
/audit/verify` re-walks the whole chain and returns the head hash, so tampering is
detectable rather than theoretical.

**The eval harness gates CI.** `data/gold` holds the ground truth for the canonical
cases. CI seeds the data, generates the inputs, runs them, and fails the build if the
pass rate drops or field-level F1 falls below threshold. Extraction cannot quietly
regress.

**Side effects are idempotent and isolated.** Dispatch lives in its own Rust service
with an outbox, and mutating API calls take idempotency keys. A retry is safe by
construction, not by hope.

This is the "no wrapper" stance the brief asked for. The model is one node in the
graph, and the other dozen (evidence, assignment, deterministic rules, eval gate,
audit chain) are the engineering.

---

## The contract rules

Validation runs against the client's actual contract, not a generic template.

| Rule | Name | What it catches |
|------|------|-----------------|
| R1 | `employee_in_contract_scope` | Billing someone who is not on the contract roster |
| R2 | `rate_compliance_per_category` | A billed rate that does not match the rate card |
| R3 | `period_boundary_check` | An invoice period outside the contract term |
| R4 | `ot_within_contract_cap` | Overtime above the per-contract cap |
| R5 | `sow_hours_not_exceeded` | Billing a fixed-scope SOW that is complete or over budget |
| R6 | `markup_correctly_applied` | A line total that does not reconcile to payroll + OT + markup + reimbursements |
| R7 | `vat_calculation_correct` | VAT that does not match the jurisdiction's rate |
| R10 | `holiday_weekend_multiplier_check` | OT amount that ignores the statutory multiplier |
| R14 | `period_not_closed` | Invoicing a period the client has locked |
| R15 | `anomaly_vs_history` | A bill that is wildly larger than the employee's own baseline |

Each failure produces a stable ID and a sentence written for a human ("The billing
period is currently closed for your account..."). R8 (extended duplicate detection)
and R9 (signature warning) exist in the code but are held back from the live flow to
keep reruns quiet.

---

## TIA, the operator you can talk to

The console has an embedded agent. It is a tool-calling agent over an
OpenAI-compatible endpoint, and it is grounded: every factual claim has to come from
a database tool call and carries a citation, or the answer is "no evidence in the
database." Answers stream, and the tool calls it made are shown in the open.

It has **read** tools (`get_contract`, `get_invoice`, `get_timesheet`, `get_events`,
`search_employees`, `get_employee_history`, `find_revenue_leakage`,
`verify_audit_chain`, `metrics_stp`, `list_clients`, `list_invoices`,
`get_client_settings`) and **write** tools (`recover_leakage`, `dispatch_invoice`,
`clawback_invoice`, `approve_timesheet`, `resend_invoice_email`). Every write logs an
`agent.<tool>_invoked` event to the audit chain, and in the Client persona the tools
are scope-locked so the agent physically cannot read another client's data.

The same tool registry is exposed over **MCP** (Model Context Protocol): a streamable
HTTP transport at `/mcp` and a `tia-mcp` stdio server, so Claude Desktop, Cursor, or
any MCP host can drive TIA directly. See [docs/CONNECT.md](docs/CONNECT.md).

---

## Compliance and ERP artifacts

This is built for UAE staffing finance, so the outputs are the ones finance actually
files:

- **UAE Tax Invoice PDF** with TRN, 5% VAT, SAC code, place of supply, sequence number, audit hash, and a WhatsApp QR.
- **Tax Credit Note** for clawbacks, with FTA Article 60 / 62 references and partial-credit support.
- **Ramco/SAP consolidated workbook** at `GET /consolidate/{client}/{period}.xlsx`.
- **WPS SIF bank file** at `GET /payroll/sif/{client}/{period}.sif`.
- **SAP Business One A/R payload**, OData v4 at `GET /invoices/{id}/sap-b1-payload`, audit hash carried as `U_TIA_AuditHash`.
- **Client statement and a quarter's audit bundle** at `GET /client/{client}/statement` and `GET /client/{client}/audit/{quarter}.zip`.

A **revenue-leakage sentinel** watches for associates who were paid but never billed,
and can generate a recovery invoice on request. That is the kind of slow leak that
stays invisible until someone reconciles payroll against AR.

---

## The console

One React app, three persona modes, no page reloads between them.

- **Client.** Submit a timesheet (file, paste, or form), watch it get billed, approve or reject the invoice, raise a query thread.
- **FinOps.** The pipeline console: review queue, the source document beside the extracted rows, the contract panel, the matcher's cost matrix, red and green rule chips, dispatch ordering and tracking, the eval dashboard, client and rule config.
- **Finance.** Month close: touchless rate, time to invoice, extraction accuracy, the auto / HITL / finance dispatch split, the leakage sentinel, the approval queue, and the compliance downloads.

It is a command-bar-first layout (press ⌘K to jump anywhere), a live activity rail fed
by server-sent events, and a public landing page with working WhatsApp and email
demos that run against the real pipeline.

---

## API surface

Around 65 endpoints. The ones that matter most:

| Group | Endpoints |
|-------|-----------|
| Health / status | `GET /health`, `GET /status`, `GET /rules` |
| Intake | `POST /intake/upload`, `/intake/email`, `/intake/mailbox-webhook`, `/intake/whatsapp`, `/submit/{client_code}` |
| Documents / timesheets | `GET /documents`, `/documents/{id}`, `/documents/{id}/source`, `POST /timesheets/{id}/approve`, `/reject` |
| Invoices | `GET /invoices`, `/invoices/{id}`, `/invoices/{id}/pdf`, `/invoices/{id}/why`, `POST /invoices/{id}/dispatch`, `/client-approve`, `/finance-approve`, `/clawback`, `/resend-email`, `/payments` |
| Finance / periods | `GET /finance/queue`, `POST /clients/{c}/periods/{p}/close`, `/reopen`, `GET /metrics/leakage`, `POST /finance/leakage/{emp}/recover` |
| Metrics | `GET /metrics/stp`, `/time-to-invoice`, `/accuracy`, `/headcount`, `/sla` |
| ERP exports | `GET /consolidate/{c}/{p}.xlsx`, `/payroll/sif/{c}/{p}.sif`, `/invoices/{id}/sap-b1-payload` |
| Audit | `GET /audit/verify`, `/invoices/{id}/audit`, `/events`, `/events/stream` |
| Agent / MCP | `POST /qa`, `POST /qa/stream`, `ANY /mcp` |
| Eval | `GET /eval`, `POST /eval/run` |

---

## Repository layout

```text
tia/
├── apps/web/              React 19 + Vite operating console (landing, 3 personas)
├── workers/ai/            Python core
│   └── tia_ai/
│       ├── api/           FastAPI app + MCP mount
│       ├── extract/       excel · pdf · email · attachments · vision (GLM-OCR)
│       ├── match/         tiered resolver + Hungarian assignment
│       ├── validate/      contract rules R1..R15
│       ├── erp/           Smart-Bot/SAP mock, Ramco xlsx, WPS SIF, SAP B1
│       ├── invoice/       Typst tax invoice + credit note + QR
│       ├── qa/            grounded tool-calling agent + streaming
│       ├── mcp/           MCP server (HTTP + stdio)
│       ├── mailbox/       Zoho IMAP poller + SMTP reply
│       ├── finance/       leakage sentinel + recovery invoices
│       ├── eval/          F1 / ECE harness over data/gold
│       └── tests/         pytest suite
├── workers/whatsapp/      Bun + Hono Meta Cloud API bridge
├── services/dispatch/     Rust axum/sqlx dispatch + idempotent outbox
├── data/                  seed master DB · gold ground truth · synthetic inputs
├── deploy/                systemd continuous-deploy units
├── docs/                  demo script, deck, connector guide
└── docker-compose.yml     Postgres + api + web + whatsapp
```

---

## Tech stack

**Core.** Python 3.12, FastAPI, Uvicorn, Pydantic v2, SQLAlchemy 2.0 (SQLite for a
zero-setup demo, Postgres in deployment).
**Documents.** openpyxl, pdfplumber, Pillow, and GLM-OCR over an OpenAI-compatible
vLLM endpoint.
**Resolution.** rapidfuzz, jellyfish, scipy (`linear_sum_assignment`).
**Invoices.** Typst (Rust-backed Python wheel) for deterministic PDFs.
**Dispatch.** Rust, axum, tokio, sqlx.
**Agent.** OpenAI-compatible tool calling with SSE streaming, MCP via FastMCP.
**WhatsApp.** Bun, Hono, TypeScript.
**Frontend.** React 19, Vite, TypeScript, Tailwind 3, TanStack Query, Zustand, React
Router, Framer Motion.
**Tooling.** uv (Python), bun (JS/TS), cargo (Rust), Docker, and a Makefile that ties
it together. No pip or npm drift.

---

## Quickstart

You need Python 3.12, [uv](https://docs.astral.sh/uv/), [Bun](https://bun.sh/), and a
Rust toolchain. OCR and the chat agent are optional. Without them, structured
timesheets still go end to end and the agent falls back to grounded, model-free
answers.

```bash
make install          # uv sync + bun install
make seed             # load the TASC master DB (10 clients, ~200 employees)
make synth            # generate the synthetic inputs + gold ground truth
```

Then, in three terminals:

```bash
make api              # FastAPI core on :8000
make dispatch         # Rust dispatch service on :8001
make web              # Vite dev server on :5173
```

Open the URL Vite prints (usually `http://127.0.0.1:5173/`).

Configuration lives in `.env`:

```bash
DATABASE_URL=postgresql+psycopg://tia:tia@localhost:5432/tia   # or sqlite:///tia.db

GLM_OCR_BASE_URL=https://your-ocr-endpoint/v1                  # optional: handwritten/photo cases
GLM_OCR_API_KEY=...
GLM_OCR_MODEL=glm-ocr:q8_0

OPENAI_BASE_URL=https://api.openai.com/v1                      # optional: the chat agent
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4o-mini                                       # any OpenAI-compatible gateway works

ZOHO_IMAP_USER=...                                             # optional: real mailbox ingestion
ZOHO_IMAP_PASSWORD=...
```

---

## Evaluation and CI

```bash
make eval     # per-case pass/fail, field-level F1, ECE, latency
make test     # pytest
```

The gold set covers the cases that actually break things: ambiguous duplicate names,
a structured employee email, a full client roster, a handwritten photo, punch-clock
and messy spreadsheets, a quoted reply thread, a typed PDF, a completed fixed-scope
SOW, and overtime over the cap. CI runs five jobs on every push: backend tests, the
frontend type-check and build, the eval gate, an API smoke test that boots the server
and curls the critical endpoints, and an aggregate status check. A regression in
extraction fails the build.

---

## Deployment

The repo ships a `docker-compose.yml` (Postgres, API, web, and the WhatsApp bridge),
per-service Dockerfiles, and `deploy/` systemd units that pull and roll out on every
push to the default branch. The live deployment runs on Postgres with continuous
deploy. The demo defaults to SQLite and local staging, so you can run it with nothing
external configured.

---

## A two-minute demo

1. **Clean path.** Client → Submit, upload `data/synthetic/case_07_clean.xlsx`. It
   routes `auto`, generates and dispatches the invoice. Open the PDF and look at the
   TRN, VAT, sequence number, and audit hash.
2. **Exception path.** Upload `data/synthetic/case_13_out_of_scope_sow.eml`. It routes
   `hitl` on R5. Open the FinOps review: the source email, the contract panel, the
   cost matrix, the red rule chip, the audit timeline.
3. **Finance.** Look at the touchless rate, time to invoice, accuracy, the dispatch
   split, and the leakage sentinel.
4. **Ask TIA.** "Why did case 13 fail validation?" and "What is CL001's auto-dispatch
   threshold?" Watch the tool calls and citations.

---

## Team

- **Chethas Dileep / edneam**: backend, agentic core, eval harness.
- **Navaneeth K / cyberkunju**: frontend, WhatsApp bridge, agentic core and deployment.

## License

MIT.

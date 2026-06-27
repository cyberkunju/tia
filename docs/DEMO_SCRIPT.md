# TIA Demo Script — 90-second pitch + 3-minute walkthrough

> Stage flow for HackArena 2.0 finals. Persona arc: **Client → FinOps → Finance → Client**.

---

## 90-second pitch (open with this)

> "TASC Outsourcing places 10,500 associates across 750 clients. Every month, Mariam — TASC's FinOps lead — opens 750 inboxes, downloads timesheets in seven different shapes, retypes them, calculates payroll, builds invoices, double-checks per-client rules, and emails the bills. **Four working days. Errors creep in. The client has no visibility.**
>
> **TIA does that whole loop while Mariam makes coffee.**
>
> The trick? Three things judges should remember.
>
> **One** — TIA reads anything. Handwritten registers, photos, Excel punches, messy emails. Cross-validation against the **contract** — not just the timesheet — catches the errors most AP tools miss.
>
> **Two** — Every value can be traced. Hungarian assignment, scipy. Decimal math. 10 deterministic rules. The AI does only what the AI is good at: reading handwriting and answering questions with citations.
>
> **Three** — Production-ready compliance. UAE Tax Invoice with TRN and VAT. Wages Protection System SIF file for the bank. Ramco SRP-shaped consolidated export. The mocks here are one mapping away from real TASC plumbing.
>
> Demo in three minutes."

---

## 3-minute walkthrough (live, on screen)

### Step 1 — As a Client (30s)
1. Open `http://localhost:5173/client/submit`
2. Drag in **`data/synthetic/case_04_handwritten.png`** (the handwritten one)
3. Watch the response: `routing=auto`, `confidence=0.9`, status `invoice_generated`

> "A real handwritten timesheet became an invoice in two seconds. GLM-OCR ran on Modal. Three rows extracted: Carlos, Ahmed, Meera. Hungarian matched all three to their employee IDs."

### Step 2 — As FinOps (60s)
1. Open `http://localhost:5173/finops`
2. Click the handwritten doc just submitted
3. Show LEFT: source image · RIGHT: extracted rows + cost matrix
4. Hit **"Why this invoice?"** drawer
5. Show the **events timeline**: `ingested → extracted → resolved → rules_evaluated → payroll_processed_by_sap → generated`
6. Point at the `payroll_processed_by_sap` event — that's TASC's Smart Bot + SAP block from their diagram, live

> "Every decision has a row in the audit log. Replay any of them with the same idempotency key — same outcome."

### Step 3 — The hard case (30s)
1. Open the inbox row for **case_13_out_of_scope_sow.eml**
2. Show: `routing=hitl`, `reason=contract rule(s) failed: R5`
3. Hover the rule chip: **"timesheet bills 192h, but SOW 'Design phase' is COMPLETED"**

> "The mentors told us about this exact case. Worker finished the design phase early. Timesheet keeps charging. Most billing tools miss it. **Our rule R5 catches it because we validated against the contract, not the timesheet alone.**"

### Step 4 — As Finance (30s)
1. Open `http://localhost:5173/finance/eval`
2. Show: **13/13 PASS**, macro F1, ECE 0.07
3. Show the 3 KPIs on the dashboard:
   - Touchless rate (`/metrics/stp`)
   - Mean time to invoice (`/metrics/time-to-invoice`)
   - Extraction accuracy (`/metrics/accuracy`)
4. Open the `/finance/queue` view: high-value invoices flagged for sign-off

### Step 5 — The chat (20s)
1. Open the chat panel; ask: **"Why did case 13 fail validation?"**
2. TIA replies with citations: `[rule:R5]`, `[invoice:xxxx]`
3. Open the dev tools: see `get_invoice` + `get_events` tool calls executed
4. _"Refuses to answer without DB evidence. Strict citation contract. Same backend serves the web chat and (later) WhatsApp."_

### Step 6 — As the Client again (10s)
1. Open `http://localhost:5173/client/invoices?client=CL001`
2. Show the new invoice in the client's portal — PDF + TRN + VAT + sequential number
3. Click **Approve**, watch status flip
4. Note the `client_approved` event on the timeline

---

## The numbers to drop in the close

- **17 commits** through the build window, every push green on CI
- **67/67 pytest** + **13/13 eval** PASS gates
- **4 ingestion channels** (portal · email × 3 modes · online form · OCR)
- **10 contract-bound rules** + **10 seeded contracts** across 3 jurisdictions (UAE / KSA / India)
- **Typst PDF** + **WPS SIF** + **Ramco-shaped consolidated Excel** — compliance artifacts judges from TASC will recognise

---

## What to do if something blows up on stage

- **GLM-OCR cold start (>10s)** → switch to case 11 (typed PDF, 80ms) or case 07 (Excel)
- **Browser blank on `:8000`** → that's the API; demo at `:5173`
- **OpenAI rate limit** → chat falls back to a "no key" mode; show citations regex instead
- **Rust dispatch unreachable** → `/status` shows `rust_dispatch: in_process`; demo still works
- **Network down** → eval + pytest + all Excel/PDF/email cases work offline; only handwriting needs Modal

# BACKEND HANDOFF — Phases 0–6

Navaneeth: this is the API surface I've shipped through 6 phases. Use it for the
UI. All endpoints are live in `tia_ai/api/app.py`. JSON unless noted otherwise.

## Phase 0–1 — contracts + rules (already wired through orchestrator)

Existing endpoints (you have these):
- `POST /intake/upload` · `POST /intake/email` · `POST /intake/whatsapp`
- `GET /documents` · `GET /documents/{id}` · `GET /documents/{id}/source`
- `POST /timesheets/{id}/approve` · `POST /timesheets/{id}/reject`
- `GET /invoices` · `GET /invoices/{id}` · `GET /invoices/{id}/pdf`
- `GET /invoices/{id}/audit` · `GET /invoices/{id}/why`
- `POST /invoices/{id}/dispatch`

New types on existing endpoints:

- `Invoice` now has: `invoice_sequence_no`, `supplier_trn`, `customer_trn`, `vat_rate`, `vat_amount`, `total_excl_vat`, `total_incl_vat`, `sac_code`, `place_of_supply`, `due_date`, `contract_id`, `client_approval_status` (`pending|approved|rejected`), `client_approval_reason`, `rule_results: RuleResult[]`
- `RuleResult` = `{ rule_id, rule_name, passed, severity, expected?, actual?, message, line_idx?, emp_id? }`
- `Timesheet.validations` now includes the rule results too (alongside math validators)
- `Timesheet.hitl_reason` includes failing rule IDs, e.g. `"contract rule(s) failed: R4, R8"`

## Phase 2 — SAP + WPS SIF

- `GET /consolidate/{client_code}/{period}.xlsx` → Ramco SRP-shaped consolidated workbook (download)
- `GET /payroll/sif/{client_code}/{period}.sif` → WPS SIF file (download)
- New event in audit timeline: `payroll_processed_by_sap` with `consolidated_excel` + `wps_sif` paths in payload

## Phase 3 — chat

```ts
// POST /qa
type QAReq = { question: string, entity_context?: { kind: string, id: string } };
type QAResp = {
  answer: string,
  citations: { kind: string, id: string }[],
  tool_calls: { name: string, args: object, result_keys?: string[] }[],
  model: string,
};
```

Render `citations` as inline `[kind:id]` chips that scroll to / open the cited entity.
Pass `entity_context` when the user is looking at a doc/invoice/client.

## Phase 4 — email modes + Phase 4b online form

- `POST /intake/email` now accepts `to_addrs: string[]`, `cc_addrs: string[]`, `intake_mode?: string`. Response includes `intake_mode` ∈ `{ direct_forward, cc_silent, watched_mailbox, unknown }` and `reply_drafted: boolean`.
- `POST /intake/mailbox-webhook` (Postmark/SES shape: `From`, `To`, `Cc`, `Subject`, `TextBody`, `HtmlBody`) — auto-binds to `Client.settings.watched_mailboxes`.
- `POST /submit/{client_code}` body `{ period, rows[], submitted_by?, notes? }` — online form, 4th channel.

## Phase 5 — onboarding, approvals, KPIs, status, dispatch

```ts
// POST /clients
type NewClient = {
  code: string, name: string, city?: string, industry?: string, contact_email?: string,
  currency?: string, jurisdiction?: 'UAE'|'KSA'|'IN', customer_trn?: string,
  billing_entity?: string, validation_threshold_aed?: number,
  dispatch_order_rule?: 'asc_by_amount'|'desc_by_amount'|'by_emp_id',
  dispatch_grouping_mode?: 'none'|'by_client_period',
  sla_days_to_invoice?: number, payment_terms_days?: number,
  watched_mailboxes?: string[], whatsapp_number?: string,
};
```

- `PUT /clients/{code}/settings` — patches `Client.settings` JSONB (all `NewClient` fields are optional)
- `POST /invoices/{id}/client-approve` body `{ by_user?, reason? }`
- `POST /invoices/{id}/client-reject` — auto-opens a query thread
- `GET /finance/queue` → invoices over per-client `validation_threshold_aed`
- `POST /invoices/{id}/finance-approve` · `POST /invoices/{id}/finance-reject`
- `POST /clients/{code}/queries` body `{ subject, body?, invoice_id?, raised_by? }`
- `GET /clients/{code}/queries` → list with `thread[]`
- `POST /queries/{id}/reply` body `{ body, by_user?, close?: boolean }`
- `GET /status` → `{ api, db, openai, modal_ocr, rust_dispatch, last_eval }`
- `GET /metrics/stp` → `{ total, auto, hitl, escalate, touchless_rate, target: 0.8 }`
- `GET /metrics/time-to-invoice` → `{ mean_minutes, target_max_minutes: 5 }`
- `GET /metrics/accuracy` → `{ macro_f1, overall_macro_f1, passed, runnable, ece }`
- `GET /metrics/headcount` → `{ by_period, total_unique_emps }`
- `GET /dispatch/tracking` → dispatch queue + history with confidence + rule_results_failed
- `GET /dispatch/{client_code}/queue` → ordered/grouped per `Client.settings`

## TypeScript types I'd add to `apps/web/src/types.ts`

```ts
export interface RuleResult {
  rule_id: string; rule_name: string; passed: boolean;
  severity: 'error'|'warning'|'info';
  expected?: unknown; actual?: unknown; message: string;
  line_idx?: number | null; emp_id?: string | null;
}

export interface InvoiceTax {
  invoice_sequence_no: string | null;
  supplier_trn: string | null;
  customer_trn: string | null;
  vat_rate: number; vat_amount: number;
  total_excl_vat: number; total_incl_vat: number;
  sac_code: string | null; place_of_supply: string | null;
  due_date: string | null;
}

export interface ClientApproval {
  client_approval_status: 'pending'|'approved'|'rejected'|null;
  client_approved_at: string | null;
  client_approval_reason: string | null;
}

export interface QAResponse {
  answer: string;
  citations: { kind: string; id: string }[];
  tool_calls: { name: string; args: object; result_keys?: string[] }[];
  model: string;
}

export interface STPMetric { total: number; auto: number; hitl: number; escalate: number; touchless_rate: number; target: number; }
```

## What you still own (frontend + WhatsApp)

- Client config screen — bind to `POST /clients` + `PUT /clients/{c}/settings`
- Rate-card editor on the contract detail page (no API yet; let me know if you want one)
- Review-screen **rule-violation chips** — read `timesheet.validations[]` where `rule_id` starts with `R`
- Finance queue UI — `GET /finance/queue` + approve/reject
- Raise-query thread UI — `POST /clients/{c}/queries` + `POST /queries/{id}/reply`
- Chat panel — slide-out on every persona screen, calls `POST /qa` with `entity_context`
- Online form page — `POST /submit/{client_code}` with mobile camera capture
- Dispatch tracking dashboard — `GET /dispatch/tracking` + `GET /dispatch/{c}/queue`
- 3 brief-success KPI tiles on Finance dashboard — `/metrics/stp` + `/metrics/time-to-invoice` + `/metrics/accuracy`
- All WhatsApp wiring (you own this end-to-end; backend has nothing to expose beyond `/qa`)

Ping me if anything in the shape isn't what you wanted — the backend's flexible.

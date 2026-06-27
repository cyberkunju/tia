/** Backend types — mirror the Python TimesheetExtraction + API responses. */

export type LeaveCode = "AL" | "SICK" | "UNPAID" | "PUBLIC_HOLIDAY" | "ABSENT" | "PRESENT";
export type Persona = "client" | "finops" | "finance";
export type Routing = "auto" | "hitl" | "escalate";

export interface BBox { page: number; norm: [number, number, number, number] }

export interface Reimbursement { reason: string; amount_aed: number }

export interface ExtractedRow {
  employee_name: string;
  emp_id?: string | null;
  days_worked?: number | null;
  hours?: number | null;
  ot_hours?: number | null;
  leave_codes: LeaveCode[];
  reimbursements: Reimbursement[];
  notes?: string | null;
}

export interface RowProvenance {
  row_idx: number;
  bbox: [number, number, number, number];
  coord_space: "pixel" | "norm";
  image_w: number;
  image_h: number;
  source_text: string | null;
  source_block_id: string | null;
}

export interface TimesheetExtraction {
  client_code?: string | null;
  client_hint?: string | null;
  period?: string | null;
  signed_by?: string | null;
  rows: ExtractedRow[];
  confidence_per_field: Record<string, number>;
  row_provenance?: RowProvenance[];
}

export interface Candidate {
  emp_id: string;
  full_name: string;
  client_code: string;
  score: number;
  signals: Record<string, number>;
}

export interface RowMatch {
  row_idx: number;
  chosen_emp_id: string | null;
  candidates: Candidate[];
  ambiguous: boolean;
  confidence: number;
  reason: string;
}

export interface MatchResult {
  matches: RowMatch[];
  cost_matrix: number[][];
  candidate_labels: string[];
  row_labels: string[];
}

export interface ValidationResult {
  rule: string;
  passed: boolean;
  message: string;
  severity?: "error" | "warning" | "info";
  emp_id?: string;
  // contract-bound rule fields (Phase 1 backend additions)
  rule_id?: string;
  rule_name?: string;
  expected?: unknown;
  actual?: unknown;
  line_idx?: number | null;
}

export interface LineItem {
  emp_id: string;
  employee_name: string;
  job_title?: string;
  days_worked: number;
  standard_days: number;
  ot_hours?: number;
  monthly_gross: number;
  prorated: number;
  ot_amount: number;
  ot_hourly_rate?: number;
  reimbursements: number;
  markup_pct: number;
  amount: number;
  confidence: number;
}

export interface DocSummary {
  doc_id: string;
  channel: string;
  mime: string | null;
  uploaded_at: string | null;
  uploaded_by: string | null;
  timesheet_id: string | null;
  status: string;
  routing: Routing | null;
  confidence: number | null;
  client_code: string | null;
  period: string | null;
}

export interface Timesheet {
  id: string;
  doc_id: string | null;
  client_code: string | null;
  period: string | null;
  status: string;
  routing: Routing | null;
  confidence: number | null;
  hitl_reason: string | null;
  extraction: TimesheetExtraction;
  match_result: MatchResult;
  validations: ValidationResult[];
  resolved_rows: LineItem[];
}

export interface Invoice {
  id: string;
  timesheet_id: string;
  client_code: string;
  period: string | null;
  amount: number;
  currency: string;
  status: string;
  line_items: LineItem[];
  pdf_available: boolean;
  dispatched_at: string | null;
  // Phase 2 tax compliance fields
  invoice_sequence_no?: string | null;
  supplier_trn?: string | null;
  customer_trn?: string | null;
  vat_rate?: number | null;
  vat_amount?: number | null;
  total_excl_vat?: number | null;
  total_incl_vat?: number | null;
  sac_code?: string | null;
  place_of_supply?: string | null;
  due_date?: string | null;
  client_approval_status?: "pending" | "approved" | "rejected" | null;
  client_approval_reason?: string | null;
  rule_results?: ValidationResult[];
  // Clawback — void path
  voided_at?: string | null;
  voided_by?: string | null;
  voided_reason_code?: string | null;
  voided_reason?: string | null;
  // Clawback — credit-note path
  credit_note_sequence_no?: string | null;
  credit_note_issued_at?: string | null;
  credit_note_issued_by?: string | null;
  credit_note_reason_code?: string | null;
  credit_note_reason_text?: string | null;
  credit_note_article_refs?: string[] | null;
  credit_note_amount?: number | null;
  credit_note_disputed_hours?: number | null;
  adjustment_type?: string | null;
  // Reissue chain
  replaces_invoice_id?: string | null;
  superseded_by_invoice_id?: string | null;
}

export interface ApiClient {
  code: string; name: string; city: string; industry: string;
  settings: Record<string, unknown>;
}

export interface EventRow {
  id: string;
  at: string;
  actor: string | null;
  kind: string;
  entity_id: string;
  action: string;
  payload: Record<string, unknown>;
  idempotency_key: string | null;
}

export interface InvoiceWhy {
  invoice: Invoice;
  extraction: TimesheetExtraction | null;
  match_result: MatchResult | null;
  validations: ValidationResult[];
  confidence_calibrated: number | null;
  routing: Routing | null;
  events: EventRow[];
}

export interface EvalRunResult {
  total_cases: number;
  passed: number;
  runnable: number;
  macro_f1: Record<string, number>;
  ece: number;
  results: EvalCaseResult[];
}

export interface EvalCaseResult {
  case: string;
  input: string;
  channel: string;
  passed: boolean;
  f1: Record<string, number>;
  extracted_rows: number;
  expected_rows: number;
  matches: { row_idx: number; chosen: string | null; ambiguous: boolean; confidence: number }[];
  invoice_amount: number;
  client_code: string | null;
  exceptions: number;
  latency_s: number;
  details: { employee_name: string; matched: boolean; row_ok?: boolean; expected: Record<string, unknown>; actual?: Record<string, unknown> }[];
}

/* ── Phase 3+ types ────────────────────────────────────────────── */

export interface QAResponse {
  answer: string;
  citations: { kind: string; id: string }[];
  tool_calls: { name: string; args: Record<string, unknown>; result_keys?: string[] }[];
  model: string;
}

export interface QueryThreadMessage {
  by: string;
  role: "client" | "finops";
  body: string;
  at: string;
}

export interface QueryThread {
  id: string;
  subject: string;
  body: string | null;
  status: "open" | "answered" | "closed";
  invoice_id: string | null;
  raised_by: string | null;
  raised_at: string | null;
  thread: QueryThreadMessage[];
}

/* ── Phase 5 metric/status types ───────────────────────────────── */

export interface StpMetric {
  total: number; auto: number; hitl: number; escalate: number;
  touchless_rate: number; target: number;
}

export interface TimeMetric {
  invoices: number; samples: number;
  mean_minutes: number; target_max_minutes: number;
}

export interface AccuracyMetric {
  target: number;
  macro_f1: Record<string, number>;
  overall_macro_f1: number | null;
  passed: number | null;
  runnable: number | null;
  ece: number | null;
  note?: string;
}

export interface HeadcountMetric {
  by_period: Record<string, number>;
  total_unique_emps: number;
}

export interface StatusResponse {
  api: string; db: string;
  openai: "configured" | "missing_key" | "down";
  modal_ocr: "configured" | "missing_key" | "down";
  rust_dispatch: "ok" | "in_process" | "unreachable" | string;
  last_eval?: {
    passed: number | null; runnable: number | null;
    macro_f1: Record<string, number> | null;
  };
}

/* ── Contract / RateCard / SOW for the Contract panel ─────────── */

export interface RateCard {
  labor_category: string;
  regular_rate: number;
  ot_rate: number;
  night_rate: number;
  holiday_rate: number;
}

export interface SOW {
  deliverable: string;
  hours_expected: number;
  hours_consumed: number;
  status: "OPEN" | "COMPLETED" | "CANCELLED";
  completed_at: string | null;
}

export interface ContractDetail {
  id: string;
  client_code: string;
  name: string;
  type: "TIME_AND_MATERIALS" | "FIXED_SCOPE" | "RETAINER";
  jurisdiction: "UAE" | "KSA" | "IN" | string;
  currency: string;
  vat_rate: number;
  sac_code: string | null;
  markup_pct: number;
  max_ot_pct: number;
  payment_terms_days: number;
  billing_cadence: string;
  start_date: string;
  end_date: string | null;
  authorized_emp_count?: number;
  rate_cards: RateCard[];
  sows: SOW[];
}

/* ── Dispatch tracking ─────────────────────────────────────────── */

export interface DispatchTrackingRow {
  id: string;
  invoice_sequence_no: string | null;
  client_code: string;
  period: string | null;
  amount: number;
  total_incl_vat: number | null;
  status: string;
  client_approval_status: "pending" | "approved" | "rejected" | null;
  dispatch_idempotency_key: string | null;
  dispatch_attempted_at: string | null;
  confidence: number | null;
  rule_results_failed: ValidationResult[];
}

/* ── Finance queue ─────────────────────────────────────────────── */

export interface FinanceQueueRow {
  id: string;
  invoice_sequence_no: string | null;
  client_code: string;
  client_name: string | null;
  period: string | null;
  amount: number;
  total_incl_vat: number | null;
  currency: string;
  status: string;
  threshold: number;
  rule_failures: ValidationResult[];
}

/* ── Phase α/β additions ─────────────────────────────────────── */

export interface Payment {
  id: string;
  amount: number;
  currency: string;
  method: "bank_transfer" | "wire" | "card" | "cheque" | "ach" | string;
  reference: string | null;
  paid_at: string | null;
  paid_by: string | null;
  status: "received" | "reconciled" | "disputed" | "refunded";
  receipt_number: string | null;
}

export interface StatementPeriod {
  period: string;
  invoices: number;
  billed_excl_vat: number;
  vat: number;
  billed_incl_vat: number;
  paid: number;
  outstanding: number;
}

export interface ClientStatement {
  client_code: string;
  client_name: string;
  currency: string;
  generated_at: string;
  periods: StatementPeriod[];
  summary: {
    invoices: number;
    total_billed_incl_vat: number;
    total_paid: number;
    outstanding: number;
  };
}

export interface NotificationRow {
  id: string;
  at: string | null;
  actor: string | null;
  kind: string;
  entity_id: string;
  action: string;
  summary: string;
  read: boolean;
}

export interface ClientUser {
  email: string;
  name: string;
  role: "viewer" | "approver" | "admin";
}

export interface AuditChainReport {
  ok: boolean;
  total: number;
  errors: {
    event_id: string;
    at: string | null;
    kind: "hash_mismatch" | "prev_mismatch";
    [k: string]: unknown;
  }[];
  head: string | null;
}

export interface SlaByStatus {
  count: number;
  mean_min: number;
  max_min: number;
}

export interface SlaMetric {
  by_status: Record<string, SlaByStatus>;
  over_sla_count: number;
  over_sla: { id: string; status: string; age_min: number; limit_min: number }[];
  checked_at: string;
}

/* ── Touchless auto-dispatch + Clawback ──────────────────────────────── */

export interface StpBreakdown {
  auto_dispatched: number;
  hitl_dispatched: number;
  finance_dispatched: number;
  total_dispatched: number;
}

// /metrics/stp extends with this — keep the original fields for compat
export interface StpMetricFull extends StpMetric {
  dispatched_breakdown?: StpBreakdown;
}

export type ClawbackReasonCode =
  | "PRICING_ERROR" | "GOODS_RETURNED" | "DISCOUNT" | "DUPLICATE" | "OTHER";

export type AdjustmentType =
  | "CREDIT_TO_CLIENT"
  | "DEDUCT_FROM_NEXT_INVOICE"
  | "DEDUCT_FROM_PAYROLL"
  | "INTERNAL_WRITE_OFF"
  | "MANUAL_REVIEW";

export type ClawbackAction =
  | "void"
  | "credit_note"
  | "credit_note_with_refund_pending";

export interface ClawbackEligibility {
  current_state: string;
  amount_aed?: number;
  currency?: string;
  action_when_clawed_back: ClawbackAction | null;
  reason?: string;
  dispatched_at?: string;
  days_since_dispatch?: number;
  fta_14_day_deadline?: string;
  days_remaining?: number;
  urgency?: "normal" | "warning" | "urgent";
  explanation?: string;
  valid_reason_codes?: ClawbackReasonCode[];
  valid_adjustment_types?: AdjustmentType[];
  adjustment_type_labels?: Record<AdjustmentType, string>;
}

export interface ClawbackRequest {
  by_user?: string;
  reason_code: ClawbackReasonCode;
  reason_text?: string;
  partial_amount?: number;
  disputed_hours?: number;
  adjustment_type?: AdjustmentType;
}

export interface ClawbackResponse {
  action_taken: ClawbackAction | "already_settled" | "already_credit_noted";
  status: string;
  invoice_id: string;
  voided_at?: string;
  credit_note_sequence_no?: string;
  credit_note_issued_at?: string;
  article_refs?: string[];
  source_timesheet_id?: string;
  auto_query_id?: string;
  refund_required?: boolean;
  is_partial?: boolean;
  credit_note_amount?: number;
  invoice_amount?: number;
  disputed_hours?: number;
  adjustment_type?: AdjustmentType;
  adjustment_friendly?: string;
  reason?: string;
}

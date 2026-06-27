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
  severity?: "error" | "warning";
  emp_id?: string;
}

export interface LineItem {
  emp_id: string;
  employee_name: string;
  job_title?: string;
  days_worked: number;
  standard_days: number;
  monthly_gross: number;
  prorated: number;
  ot_amount: number;
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
}

export interface ApiClient { code: string; name: string; city: string; industry: string; settings: Record<string, unknown> }

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

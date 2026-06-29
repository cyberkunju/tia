import type {
  AccuracyMetric, ApiClient, ContractDetail, DispatchTrackingRow, DocSummary,
  EvalRunResult, FinanceQueueRow, HeadcountMetric, Invoice, InvoiceWhy,
  QAResponse, QueryThread, StatusResponse, StpMetric, TimeMetric, Timesheet,
} from "./types";

export const API_BASE = import.meta.env.VITE_API_BASE || "http://127.0.0.1:8000";
// Optional bearer token. Empty by default (open API / public demo). When the
// backend has TIA_API_TOKEN set, build the SPA with VITE_API_TOKEN to match and
// every request below carries `Authorization: Bearer <token>` automatically.
const API_TOKEN = import.meta.env.VITE_API_TOKEN || "";

function uuid(): string {
  return (crypto as { randomUUID?: () => string }).randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (API_TOKEN) {
    init = { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${API_TOKEN}` } };
  }
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    throw new Error(`${res.status} ${res.statusText} on ${path}${detail ? ` ΓÇö ${detail}` : ""}`);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? (await res.json() as T) : (await res.text() as unknown as T);
}

function jsonInit(method: string, body: unknown, key?: string): RequestInit {
  return {
    method,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key ?? uuid(),
    },
    body: JSON.stringify(body),
  };
}

export const api = {
  base: API_BASE,

  health: () => req<{ status: string }>("/health"),
  status: () => req<StatusResponse>("/status"),

  /* ΓöÇΓöÇ intake ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ */

  uploadFile: async (file: File, uploadedBy = "client") => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("uploaded_by", uploadedBy);
    return req<{ doc_id: string; timesheet_id: string; status: string; routing: string; confidence: number }>(
      "/intake/upload",
      { method: "POST", body: fd, headers: { "Idempotency-Key": uuid() } },
    );
  },

  submitEmail: (body: string, subject = "", from_addr = "", uploaded_by = "client") =>
    req<{ doc_id: string; timesheet_id: string; status: string; routing: string; confidence: number; intake_mode?: string; reply_drafted?: boolean }>(
      "/intake/email",
      // Portal "email body" represents a message sent TO TIA's inbox → a direct intake
      // (not an orphan). Address it so the backend processes it normally.
      jsonInit("POST", { body, subject, from_addr, uploaded_by, to_addrs: ["tia@tasc.test"] }),
    ),

  submitOnlineForm: (
    clientCode: string,
    payload: {
      period: string;
      rows: { emp_id?: string; employee_name?: string; days_worked?: number; ot_hours?: number; leave_codes?: string[] }[];
      submitted_by?: string;
      notes?: string;
    },
  ) =>
    req<{ doc_id: string; timesheet_id: string; status: string; routing: string; confidence: number; client_code: string }>(
      `/submit/${clientCode}`,
      jsonInit("POST", payload),
    ),

  /* ΓöÇΓöÇ docs / timesheets ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ */

  listDocs: () => req<DocSummary[]>("/documents"),
  getDoc: (id: string) =>
    req<{
      doc: { id: string; channel: string; mime: string; filename: string; uploaded_at: string; uploaded_by: string };
      timesheet: Timesheet | null;
      invoices: Invoice[];
    }>(`/documents/${id}`),
  docSourceUrl: (id: string) => `${API_BASE}/documents/${id}/source`,

  approve: (tsId: string, corrections: { row_idx: number; chosen_emp_id: string }[] = [], byUser = "finops") =>
    req<{ timesheet_id: string; status: string; invoice_id: string; amount: number }>(
      `/timesheets/${tsId}/approve`,
      jsonInit("POST", { by_user: byUser, corrections }),
    ),

  reject: (tsId: string, reason: string, byUser = "finops") =>
    req<{ timesheet_id: string; status: string }>(
      `/timesheets/${tsId}/reject`,
      jsonInit("POST", { by_user: byUser, reason }),
    ),

  /* ΓöÇΓöÇ invoices ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ */

  listInvoices: (clientCode?: string) =>
    req<Invoice[]>(`/invoices${clientCode ? `?client_code=${clientCode}` : ""}`),
  getInvoice: (id: string) => req<Invoice>(`/invoices/${id}`),
  invoicePdfUrl: (id: string) => `${API_BASE}/invoices/${id}/pdf`,
  invoiceWhy: (id: string) => req<InvoiceWhy>(`/invoices/${id}/why`),
  dispatchInvoice: (id: string, byUser = "finops") =>
    req<{ status: string; idempotency_key: string }>(
      `/invoices/${id}/dispatch`,
      jsonInit("POST", { by_user: byUser }),
    ),
  resendInvoiceEmail: (id: string, byUser = "finops") =>
    req<{ sent: boolean; to?: string; message_id?: string; idempotency_key?: string; reason?: string }>(
      `/invoices/${id}/resend-email`,
      jsonInit("POST", { by_user: byUser }),
    ),
  clientApprove: (id: string, byUser = "client", reason?: string) =>
    req<{ status: string; invoice_id: string }>(
      `/invoices/${id}/client-approve`,
      jsonInit("POST", { by_user: byUser, reason }),
    ),
  clientReject: (id: string, reason: string, byUser = "client") =>
    req<{ status: string; invoice_id: string; query_id?: string }>(
      `/invoices/${id}/client-reject`,
      jsonInit("POST", { by_user: byUser, reason }),
    ),
  financeApprove: (id: string, byUser = "finance", reason?: string) =>
    req<{ status: string; invoice_id: string }>(
      `/invoices/${id}/finance-approve`,
      jsonInit("POST", { by_user: byUser, reason }),
    ),
  financeReject: (id: string, reason: string, byUser = "finance") =>
    req<{ status: string; invoice_id: string; reason: string }>(
      `/invoices/${id}/finance-reject`,
      jsonInit("POST", { by_user: byUser, reason }),
    ),

  /* ΓöÇΓöÇ clients (onboarding + config) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ */

  listClients: () => req<ApiClient[]>("/clients"),
  createClient: (payload: {
    code: string; name: string; city?: string; industry?: string; contact_email?: string;
    currency?: string; jurisdiction?: string; customer_trn?: string; billing_entity?: string;
    validation_threshold_aed?: number; dispatch_order_rule?: string; dispatch_grouping_mode?: string;
    sla_days_to_invoice?: number; payment_terms_days?: number;
    watched_mailboxes?: string[]; whatsapp_number?: string;
  }) =>
    req<{ code: string; name: string; settings: Record<string, unknown> }>(
      "/clients", jsonInit("POST", payload),
    ),
  updateClientSettings: (code: string, settings: Record<string, unknown>) =>
    req<{ code: string; settings: Record<string, unknown> }>(
      `/clients/${code}/settings`,
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) },
    ),

  /* ΓöÇΓöÇ contract (for the Contract panel on Review) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ */

  getContract: async (clientCode: string): Promise<ContractDetail | null> => {
    // We use the /qa tool's data shape indirectly; the simplest path is to ask
    // the agent's contract tool via a synthetic question. We'll instead expose
    // a future /contracts endpoint ΓÇö for now, fall back gracefully.
    try {
      const r = await fetch(`${API_BASE}/contracts/${clientCode}`);
      if (!r.ok) return null;
      return await r.json() as ContractDetail;
    } catch { return null; }
  },

  /* ΓöÇΓöÇ queries (raise + thread) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ */

  raiseQuery: (clientCode: string, payload: { subject: string; body?: string; invoice_id?: string; raised_by?: string }) =>
    req<{ id: string; status: string; client_code: string }>(
      `/clients/${clientCode}/queries`,
      jsonInit("POST", payload),
    ),
  listQueries: (clientCode: string) =>
    req<QueryThread[]>(`/clients/${clientCode}/queries`),
  replyToQuery: (queryId: string, payload: { body: string; by_user?: string; close?: boolean }) =>
    req<{ id: string; status: string; thread: QueryThread["thread"] }>(
      `/queries/${queryId}/reply`,
      jsonInit("POST", payload),
    ),

  /* ΓöÇΓöÇ chat (context-aware /qa) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ */

  qa: (question: string, entity_context?: { kind: string; id: string }) =>
    req<QAResponse>(
      "/qa",
      jsonInit("POST", { question, entity_context }),
    ),

  /* ΓöÇΓöÇ KPIs ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ */

  metricsStp: () => req<StpMetric>("/metrics/stp"),
  metricsTimeToInvoice: () => req<TimeMetric>("/metrics/time-to-invoice"),
  metricsAccuracy: () => req<AccuracyMetric>("/metrics/accuracy"),
  metricsHeadcount: () => req<HeadcountMetric>("/metrics/headcount"),

  /* ΓöÇΓöÇ Finance queue + Dispatch tracking ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ */

  financeQueue: () => req<FinanceQueueRow[]>("/finance/queue"),
  dispatchTracking: () => req<DispatchTrackingRow[]>("/dispatch/tracking"),

  /* ΓöÇΓöÇ SAP artifacts ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ */

  consolidatedExcelUrl: (clientCode: string, period: string) =>
    `${API_BASE}/consolidate/${clientCode}/${encodeURIComponent(period)}.xlsx`,
  wpsSifUrl: (clientCode: string, period: string) =>
    `${API_BASE}/payroll/sif/${clientCode}/${encodeURIComponent(period)}.sif`,

  /* ΓöÇΓöÇ eval ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ */

  evalSummary: () => req<EvalRunResult>("/eval"),
  runEval: () => req<EvalRunResult>("/eval/run", { method: "POST" }),

  /* ΓöÇΓöÇ events (append-only audit feed) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ */

  listEvents: (entityId?: string, limit = 100) =>
    req<import("./types").EventRow[]>(
      `/events?${entityId ? `entity_id=${encodeURIComponent(entityId)}&` : ""}limit=${limit}`,
    ),

  /* ΓöÇΓöÇ admin (stage demo helper) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ */

  demoReset: () => req<{ status: string; wiped: Record<string, number> }>("/admin/demo-reset", { method: "POST" }),

  /* ── rule catalogue (for friendly subtext on chips & config) ── */

  listRules: () => req<import("./types").RuleCatalogue>("/rules"),

  /* ── audit chain integrity (tamper-evident hash chain) ──────── */

  verifyAuditChain: () => req<import("./types").AuditChainReport>("/audit/verify"),

  /* ── Phase α/β: payments, statement, audit bundle, SLA, notifications, multi-user, period lock ── */

  payInvoice: (id: string, payload: {
    amount: number; method?: string; reference?: string; notes?: string; paid_by?: string;
  }) =>
    req<{ id: string; receipt_number: string; status: string }>(
      `/invoices/${id}/payments`, jsonInit("POST", payload),
    ),
  listPayments: (id: string) =>
    req<import("./types").Payment[]>(`/invoices/${id}/payments`),

  clientStatement: (clientCode: string, months = 12) =>
    req<import("./types").ClientStatement>(`/client/${clientCode}/statement?months=${months}`),

  clientAuditBundleUrl: (clientCode: string, quarter: string) =>
    `${API_BASE}/client/${clientCode}/audit/${encodeURIComponent(quarter)}.zip`,

  closePeriod: (clientCode: string, period: string) =>
    req<{ client_code: string; period: string; closed: boolean }>(
      `/clients/${clientCode}/periods/${encodeURIComponent(period)}/close`,
      { method: "POST" },
    ),
  reopenPeriod: (clientCode: string, period: string) =>
    req<{ client_code: string; period: string; closed: boolean }>(
      `/clients/${clientCode}/periods/${encodeURIComponent(period)}/reopen`,
      { method: "POST" },
    ),

  notifications: (persona: "client" | "finops" | "finance" = "client", clientCode?: string, limit = 30) =>
    req<import("./types").NotificationRow[]>(
      `/notifications?persona=${persona}${clientCode ? `&client_code=${clientCode}` : ""}&limit=${limit}`,
    ),

  listClientUsers: (clientCode: string) =>
    req<import("./types").ClientUser[]>(`/clients/${clientCode}/users`),
  setClientUsers: (clientCode: string, users: import("./types").ClientUser[]) =>
    req<{ code: string; users: import("./types").ClientUser[] }>(
      `/clients/${clientCode}/users`,
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(users) },
    ),

  metricsSla: () => req<import("./types").SlaMetric>("/metrics/sla"),

  /* ── Per-client dispatch ordering queue ─────────────────────── */

  dispatchQueue: (clientCode: string) =>
    req<{ client_code: string; entries: import("./types").DispatchQueueEntry[]; rule?: string }>(
      `/dispatch/${clientCode}/queue`,
    ),

  /* ── WhatsApp / mailbox webhook + invoice audit chain ─────── */

  invoiceAudit: (id: string) =>
    req<{ invoice_id: string; events: import("./types").EventRow[] }>(`/invoices/${id}/audit`),

  /* ── Clawback (void / credit-note / partial) ───────────────── */

  clawbackEligibility: (id: string) =>
    req<import("./types").ClawbackEligibility>(`/invoices/${id}/clawback-eligibility`),

  clawback: (id: string, payload: import("./types").ClawbackRequest, key?: string) =>
    req<import("./types").ClawbackResponse>(
      `/invoices/${id}/clawback`,
      jsonInit("POST", payload, key),
    ),

  /* ── Peak Agentic: streaming chat + leakage sentinel + SAP B1 ─ */

  /**
   * POST /qa/stream — async generator yielding structured events as the agent
   * fires tools and tokens stream back. Each event is a `QaStreamEvent`.
   * Caller `for await` loops it; consumes the SSE under the hood.
   */
  qaStream: async function* qaStream(
    question: string,
    entity_context?: { kind: string; id: string },
    client_scope?: string | null,
    signal?: AbortSignal,
    history?: { role: "user" | "assistant"; content: string }[],
  ): AsyncGenerator<import("./types").QaStreamEvent, void, void> {
    const res = await fetch(`${API_BASE}/qa/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, entity_context, client_scope, history }),
      signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`qa/stream ${res.status}: ${text.slice(0, 200)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE messages are separated by \n\n
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            yield JSON.parse(payload) as import("./types").QaStreamEvent;
          } catch {
            // ignore malformed event
          }
        }
      }
    }
  },

  metricsLeakage: (period?: string, clientCode?: string) => {
    const qs = new URLSearchParams();
    if (period) qs.set("period", period);
    if (clientCode) qs.set("client_code", clientCode);
    const tail = qs.toString();
    return req<import("./types").LeakageReport>(
      `/metrics/leakage${tail ? `?${tail}` : ""}`,
    );
  },

  recoverLeakage: (
    empId: string,
    period: string,
    reason: import("./types").LeakageReason = "no_timesheet",
    byUser = "finops",
  ) =>
    req<import("./types").RecoveryInvoiceResult>(
      `/finance/leakage/${encodeURIComponent(empId)}/recover`,
      jsonInit("POST", { period, reason, by_user: byUser }),
    ),

  sapB1Payload: (invoiceId: string) =>
    req<import("./types").SapB1PayloadResponse>(
      `/invoices/${invoiceId}/sap-b1-payload`,
    ),
};

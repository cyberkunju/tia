import type {
  ApiClient, DocSummary, EvalRunResult, Invoice, InvoiceWhy, Timesheet,
} from "./types";

export const API_BASE = import.meta.env.VITE_API_BASE || "http://127.0.0.1:8000";

function uuid(): string {
  return (crypto as { randomUUID?: () => string }).randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path}`);
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? (await res.json() as T) : (await res.text() as unknown as T);
}

export const api = {
  base: API_BASE,

  health: () => req<{ status: string }>("/health"),

  // intake
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
    req<{ doc_id: string; timesheet_id: string; status: string; routing: string; confidence: number }>(
      "/intake/email",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": uuid() },
        body: JSON.stringify({ body, subject, from_addr, uploaded_by }),
      },
    ),

  // docs / timesheets
  listDocs: () => req<DocSummary[]>("/docs"),
  getDoc: (id: string) => req<{ doc: { id: string; channel: string; mime: string; filename: string; uploaded_at: string; uploaded_by: string }; timesheet: Timesheet | null; invoices: Invoice[] }>(`/docs/${id}`),
  docSourceUrl: (id: string) => `${API_BASE}/docs/${id}/source`,

  approve: (tsId: string, corrections: { row_idx: number; chosen_emp_id: string }[] = [], byUser = "finops") =>
    req<{ timesheet_id: string; status: string; invoice_id: string; amount: number }>(
      `/timesheets/${tsId}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": uuid() },
        body: JSON.stringify({ by_user: byUser, corrections }),
      },
    ),

  reject: (tsId: string, reason: string, byUser = "finops") =>
    req<{ timesheet_id: string; status: string }>(`/timesheets/${tsId}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": uuid() },
      body: JSON.stringify({ by_user: byUser, reason }),
    }),

  // invoices
  listInvoices: (clientCode?: string) =>
    req<Invoice[]>(`/invoices${clientCode ? `?client_code=${clientCode}` : ""}`),
  getInvoice: (id: string) => req<Invoice>(`/invoices/${id}`),
  invoicePdfUrl: (id: string) => `${API_BASE}/invoices/${id}/pdf`,
  invoiceWhy: (id: string) => req<InvoiceWhy>(`/invoices/${id}/why`),
  dispatchInvoice: (id: string, byUser = "finops") =>
    req<{ status: string; idempotency_key: string }>(`/invoices/${id}/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": uuid() },
      body: JSON.stringify({ by_user: byUser }),
    }),

  // clients
  listClients: () => req<ApiClient[]>("/clients"),
  updateClientSettings: (code: string, settings: Record<string, unknown>) =>
    req<{ code: string; settings: Record<string, unknown> }>(`/clients/${code}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    }),

  // eval
  evalSummary: () => req<EvalRunResult>("/eval"),
  runEval: () => req<EvalRunResult>("/eval/run", { method: "POST" }),
};

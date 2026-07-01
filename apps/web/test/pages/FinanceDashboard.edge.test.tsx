import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  AccuracyMetric, ApiClient, HeadcountMetric, Invoice, LeakageReport,
  StpMetric, TimeMetric, AuditChainReport,
} from "../../src/types";

vi.mock("../../src/api", () => ({
  api: {
    metricsStp: vi.fn(), metricsTimeToInvoice: vi.fn(), metricsAccuracy: vi.fn(),
    metricsHeadcount: vi.fn(), listInvoices: vi.fn(), listClients: vi.fn(),
    submitEmail: vi.fn(), verifyAuditChain: vi.fn(), metricsLeakage: vi.fn(), recoverLeakage: vi.fn(),
  },
  API_BASE: "http://127.0.0.1:8000",
}));

import { api } from "../../src/api";
import { FinanceDashboard } from "../../src/pages/FinanceDashboard";

function renderPage(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

// Edge KPI shapes flip the "unhappy"/fallback ternaries the main test doesn't:
// below-target touchless, no cycle-time samples (no speedup), accuracy with no
// overall F1 (passed/runnable fallback, no ECE), and singular invoice/associate/client.
const stp: StpMetric = { total: 4, auto: 1, hitl: 3, escalate: 0, touchless_rate: 0.4, target: 0.9 };
const time: TimeMetric = { invoices: 0, samples: 0, mean_minutes: 0, target_max_minutes: 5 };
const acc: AccuracyMetric = { target: 0.95, macro_f1: {}, overall_macro_f1: null, passed: 3, runnable: 5, ece: null };
const head: HeadcountMetric = { by_period: {}, total_unique_emps: 1 };
const clients: ApiClient[] = [{ code: "CL001", name: "Emirates Steel", city: "AUH", industry: "Steel", settings: {} }];
const chain: AuditChainReport = { ok: true, total: 1, errors: [], head: "abc123" };
const leakageEmpty: LeakageReport = {
  period: "2026-06", generated_at: "now", total_aed: 0, associate_count: 0, by_client: [],
  entries: [], by_reason: {}, baseline_mean_aed: 0, baseline_stdev_aed: 0, is_anomalous_period: false, baseline_delta_pct: null,
};
const oneInv: Invoice = {
  id: "i1", timesheet_id: "t1", client_code: "CL001", period: "2026-06", amount: 1000,
  currency: "AED", status: "generated", line_items: [], pdf_available: false,
  dispatched_at: null, total_incl_vat: 1050, invoice_sequence_no: "INV-1",
};

beforeEach(() => {
  vi.mocked(api.metricsStp).mockResolvedValue(stp);
  vi.mocked(api.metricsTimeToInvoice).mockResolvedValue(time);
  vi.mocked(api.metricsAccuracy).mockResolvedValue(acc);
  vi.mocked(api.metricsHeadcount).mockResolvedValue(head);
  vi.mocked(api.listClients).mockResolvedValue(clients);
  vi.mocked(api.verifyAuditChain).mockResolvedValue(chain);
  vi.mocked(api.metricsLeakage).mockResolvedValue(leakageEmpty);
  vi.mocked(api.listInvoices).mockResolvedValue([oneInv]);
});
afterEach(() => vi.clearAllMocks());

describe("FinanceDashboard — edge KPI shapes", () => {
  it("renders below-target touchless, no-speedup cycle time, F1 fallback and singular counts", async () => {
    renderPage(<FinanceDashboard />);
    // below-target touchless rate
    expect(await screen.findByText("40.0%")).toBeInTheDocument();
    // cycle time value present, no speedup → falls to samples/target hint
    expect(screen.getByText("0.0 min")).toBeInTheDocument();
    expect(screen.getByText(/0 samples · target <5 min/)).toBeInTheDocument();
    // accuracy has no overall F1 → passed/runnable fallback, and no ECE in the hint
    expect(screen.getByText("3/5")).toBeInTheDocument();
    expect(screen.getByText("target 0.95")).toBeInTheDocument();
    // singular invoice/associate/client billed-hint branch
    expect(screen.getByText(/1 invoice · 1 associate · 1 client/)).toBeInTheDocument();
  });
});

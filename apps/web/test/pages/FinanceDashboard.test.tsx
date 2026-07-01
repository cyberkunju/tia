import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../src/api", () => ({
  api: {
    metricsStp: vi.fn(),
    metricsTimeToInvoice: vi.fn(),
    metricsAccuracy: vi.fn(),
    metricsHeadcount: vi.fn(),
    listInvoices: vi.fn(),
    listClients: vi.fn(),
    submitEmail: vi.fn(),
    verifyAuditChain: vi.fn(),
    metricsLeakage: vi.fn(),
    recoverLeakage: vi.fn(),
  },
  API_BASE: "http://127.0.0.1:8000",
}));

import { api } from "../../src/api";
import { FinanceDashboard } from "../../src/pages/FinanceDashboard";
import type {
  AccuracyMetric, ApiClient, HeadcountMetric, Invoice, LeakageReport,
  StpMetric, TimeMetric, AuditChainReport,
} from "../../src/types";

function renderPage(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const stp: StpMetric = { total: 10, auto: 9, hitl: 1, escalate: 0, touchless_rate: 0.9, target: 0.9 };
const time: TimeMetric = { invoices: 10, samples: 8, mean_minutes: 4, target_max_minutes: 5 };
const acc: AccuracyMetric = { target: 0.95, macro_f1: { days_worked: 0.98 }, overall_macro_f1: 0.97, passed: 8, runnable: 8, ece: 0.01 };
const head: HeadcountMetric = { by_period: { "2026-06": 5 }, total_unique_emps: 5 };
const clients: ApiClient[] = [{ code: "CL001", name: "Emirates Steel", city: "AUH", industry: "Steel", settings: {} }];
const chain: AuditChainReport = { ok: true, total: 12, errors: [], head: "a7d23bcd1234" };
const leakageEmpty: LeakageReport = {
  period: "2026-06", generated_at: "now", total_aed: 0, associate_count: 0,
  by_client: [], entries: [], by_reason: {}, baseline_mean_aed: 0, baseline_stdev_aed: 0,
  is_anomalous_period: false, baseline_delta_pct: null,
};

const inv = (over: Partial<Invoice> = {}): Invoice => ({
  id: "iiii1111", timesheet_id: "t1", client_code: "CL001", period: "2026-06",
  amount: 1000, currency: "AED", status: "dispatched", line_items: [],
  pdf_available: false, dispatched_at: null, total_incl_vat: 1050, invoice_sequence_no: "INV-1", ...over,
});

beforeEach(() => {
  vi.mocked(api.metricsStp).mockReset().mockResolvedValue(stp);
  vi.mocked(api.metricsTimeToInvoice).mockReset().mockResolvedValue(time);
  vi.mocked(api.metricsAccuracy).mockReset().mockResolvedValue(acc);
  vi.mocked(api.metricsHeadcount).mockReset().mockResolvedValue(head);
  vi.mocked(api.listClients).mockReset().mockResolvedValue(clients);
  vi.mocked(api.verifyAuditChain).mockReset().mockResolvedValue(chain);
  vi.mocked(api.metricsLeakage).mockReset().mockResolvedValue(leakageEmpty);
  vi.mocked(api.submitEmail).mockReset().mockResolvedValue({ doc_id: "d", timesheet_id: "t", status: "ok", routing: "auto", confidence: 0.9 });
  vi.mocked(api.listInvoices).mockReset().mockResolvedValue([]);
});
afterEach(() => vi.clearAllMocks());

describe("FinanceDashboard page", () => {
  it("renders empty invoice panels but live KPI metrics", async () => {
    vi.mocked(api.listInvoices).mockResolvedValue([]);
    renderPage(<FinanceDashboard />);

    // touchless rate metric
    expect(await screen.findByText("90.0%")).toBeInTheDocument();
    // cycle time
    expect(screen.getByText("4.0 min")).toBeInTheDocument();
    // audit chain valid
    expect(await screen.findByText("chain valid")).toBeInTheDocument();
    // no leakage
    expect(await screen.findByText("No leakage detected")).toBeInTheDocument();
    // empty invoice panels
    expect(screen.getAllByText("No invoices yet").length).toBeGreaterThanOrEqual(2);
  });

  it("renders the top-clients bar and recent invoices when invoices exist", async () => {
    vi.mocked(api.listInvoices).mockResolvedValue([
      inv({ id: "i1", client_code: "CL001", total_incl_vat: 2000 }),
      inv({ id: "i2", client_code: "CL001", total_incl_vat: 1000, status: "generated", invoice_sequence_no: null }),
    ]);
    renderPage(<FinanceDashboard />);

    // Client name resolved from clients list, appears in top clients + recent
    await waitFor(() => expect(screen.getAllByText(/Emirates Steel/).length).toBeGreaterThan(0));
    // Billed total 3000 shows in the metric hint area
    expect(screen.getAllByText(/2 invoices/).length).toBeGreaterThan(0);
  });

  it("seeds sample data by firing prefab emails", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listInvoices).mockResolvedValue([]);
    renderPage(<FinanceDashboard />);

    await user.click(await screen.findByRole("button", { name: /Seed sample data/ }));
    await waitFor(() => expect(vi.mocked(api.submitEmail)).toHaveBeenCalled());
    // 5 prefab payloads
    expect(vi.mocked(api.submitEmail).mock.calls.length).toBe(5);
  });
});

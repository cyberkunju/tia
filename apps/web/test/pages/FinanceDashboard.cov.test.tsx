import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../src/api", () => ({
  api: {
    metricsStp: vi.fn(), metricsTimeToInvoice: vi.fn(), metricsAccuracy: vi.fn(),
    metricsHeadcount: vi.fn(), listInvoices: vi.fn(), listClients: vi.fn(), submitEmail: vi.fn(),
  },
  API_BASE: "http://127.0.0.1:8000",
}));
vi.mock("../../src/components/AuditChainCard", () => ({ AuditChainCard: () => <div>audit</div> }));
vi.mock("../../src/components/LeakageSentinelCard", () => ({ LeakageSentinelCard: () => <div>leakage</div> }));
vi.mock("../../src/components/LiveActivityRail", () => ({ LiveActivityRail: () => <div>rail</div> }));

import { api } from "../../src/api";
import { FinanceDashboard } from "../../src/pages/FinanceDashboard";

function renderPage(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(api.metricsStp).mockReset().mockResolvedValue({ total: 10, auto: 9, hitl: 1, escalate: 0, touchless_rate: 0.9, target: 0.9, dispatched_breakdown: { total_dispatched: 9, auto_dispatched: 8, hitl_dispatched: 1, finance_dispatched: 0 } } as never);
  vi.mocked(api.metricsTimeToInvoice).mockReset().mockResolvedValue({ invoices: 10, samples: 8, mean_minutes: 4.2, target_max_minutes: 5 } as never);
  vi.mocked(api.metricsAccuracy).mockReset().mockResolvedValue({ target: 0.95, macro_f1: {}, overall_macro_f1: 0.97, passed: 8, runnable: 8, ece: 0.01 } as never);
  vi.mocked(api.metricsHeadcount).mockReset().mockResolvedValue({ total_unique_emps: 1 } as never);
  vi.mocked(api.listClients).mockReset().mockResolvedValue([{ code: "CL001", name: "Emirates Steel", settings: {} }] as never);
  vi.mocked(api.submitEmail).mockReset().mockResolvedValue({ doc_id: "d", timesheet_id: "t", status: "ok", routing: "auto", confidence: 0.9 } as never);
});
afterEach(() => vi.clearAllMocks());

describe("FinanceDashboard — populated with field fallbacks", () => {
  it("renders KPIs, top clients (name fallback), and recent invoices (seq fallback)", async () => {
    vi.mocked(api.listInvoices).mockResolvedValue([
      { id: "aaaa1111bbbb", client_code: "CL001", period: "2026-06", status: "dispatched", total_incl_vat: 5000, amount: 4761, invoice_sequence_no: "INV-1" },
      { id: "cccc2222dddd", client_code: "CLX", period: "2026-06", status: "generated", amount: 3000, invoice_sequence_no: null }, // no total_incl_vat, unknown client, no seq
    ] as never);
    renderPage(<FinanceDashboard />);

    expect(await screen.findByText("90.0%")).toBeInTheDocument(); // touchless
    expect(screen.getByText("4.2 min")).toBeInTheDocument(); // cycle
    expect(screen.getByText("0.97")).toBeInTheDocument(); // accuracy F1
    // top clients: CL001 has a name, CLX falls back to the code
    expect((await screen.findAllByText("Emirates Steel")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("CLX").length).toBeGreaterThan(0);
    // recent invoice with no seq → id slice
    expect(screen.getByText("cccc2222")).toBeInTheDocument();
  });

  it("seeds sample data across clients", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listInvoices).mockResolvedValue([] as never);
    renderPage(<FinanceDashboard />);
    await user.click(await screen.findByRole("button", { name: /Seed sample data/ }));
    await waitFor(() => expect(vi.mocked(api.submitEmail)).toHaveBeenCalledTimes(5));
  });
});

describe("FinanceDashboard — cycle-time samples fallback", () => {
  it("shows the samples/target hint when mean_minutes is 0 (no speedup)", async () => {
    vi.mocked(api.metricsTimeToInvoice).mockResolvedValue({ invoices: 5, samples: null, mean_minutes: 0, target_max_minutes: null } as never);
    vi.mocked(api.listInvoices).mockResolvedValue([] as never);
    renderPage(<FinanceDashboard />);
    // mins === 0 → speedup null; samples/target null → `?? 0` / `?? 5`
    expect(await screen.findByText(/0 samples · target <5 min/)).toBeInTheDocument();
  });
});

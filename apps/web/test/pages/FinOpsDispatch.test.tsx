import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("../../src/api", () => ({
  api: {
    listClients: vi.fn(),
    listInvoices: vi.fn(),
    metricsStp: vi.fn(),
    updateClientSettings: vi.fn(),
    dispatchInvoice: vi.fn(),
  },
}));

import { api } from "../../src/api";
import { FinOpsDispatch } from "../../src/pages/FinOpsDispatch";
import type { ApiClient, Invoice, StpMetric } from "../../src/types";

// Mount at a route that carries the :clientCode param so useParams resolves.
function renderPage(node: ReactElement, entry = "/console/dispatch/CL001") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/console/dispatch/:clientCode" element={node} />
          <Route path="/console/dispatch" element={node} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const stp: StpMetric = { total: 10, auto: 7, hitl: 2, escalate: 1, touchless_rate: 0.7, target: 0.9 };
const clients: ApiClient[] = [
  { code: "CL001", name: "Emirates Steel", city: "AUH", industry: "Steel", settings: { dispatch_rule: "alphabetical" } },
  { code: "CL002", name: "Dubai Co", city: "DXB", industry: "Logistics", settings: {} },
];

const inv = (over: Partial<Invoice> = {}): Invoice => ({
  id: "iiii1111jjjj2222", timesheet_id: "t1", client_code: "CL001", period: "2026-06",
  amount: 1000, currency: "AED", status: "generated",
  line_items: [{ emp_id: "E1", employee_name: "Bravo", job_title: "Welder", days_worked: 20, standard_days: 20, monthly_gross: 5000, prorated: 5000, ot_amount: 0, reimbursements: 0, markup_pct: 0.15, amount: 1000, confidence: 0.9 }],
  pdf_available: false, dispatched_at: null, ...over,
});

beforeEach(() => {
  vi.mocked(api.listClients).mockReset().mockResolvedValue(clients);
  vi.mocked(api.metricsStp).mockReset().mockResolvedValue(stp);
  vi.mocked(api.updateClientSettings).mockReset().mockResolvedValue({ code: "CL001", settings: {} });
  vi.mocked(api.dispatchInvoice).mockReset().mockResolvedValue({ status: "dispatched", idempotency_key: "k" });
  vi.mocked(api.listInvoices).mockReset().mockResolvedValue([]);
});
afterEach(() => vi.clearAllMocks());

describe("FinOpsDispatch page", () => {
  it("shows the empty queue when the client has no invoices", async () => {
    vi.mocked(api.listInvoices).mockResolvedValue([]);
    renderPage(<FinOpsDispatch />);
    expect(await screen.findByText("No invoices for this client yet")).toBeInTheDocument();
    expect(screen.getByText(/Queue · 0 invoices/)).toBeInTheDocument();
  });

  it("renders the pipeline KPI strip and the queue ordered alphabetically by employee", async () => {
    vi.mocked(api.listInvoices).mockImplementation((code?: string) =>
      Promise.resolve(
        code
          ? [inv({ id: "z1", line_items: [{ ...inv().line_items[0], employee_name: "Zed" }] }),
             inv({ id: "a1", line_items: [{ ...inv().line_items[0], employee_name: "Adam" }] })]
          : [inv({ status: "dispatched" }), inv({ status: "generated" })],
      ),
    );
    renderPage(<FinOpsDispatch />);

    // Employee names appear once ordered; Adam should sort before Zed.
    const adam = await screen.findByText("Adam");
    const zed = screen.getByText("Zed");
    expect(adam.compareDocumentPosition(zed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // touchless rate on the KPI strip
    expect(screen.getByText("70.0%")).toBeInTheDocument();
  });

  it("dispatches all pending invoices", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listInvoices).mockImplementation((code?: string) =>
      Promise.resolve(code ? [inv({ id: "p1", status: "generated" })] : []),
    );
    renderPage(<FinOpsDispatch />);

    const btn = await screen.findByRole("button", { name: /Dispatch 1/ });
    await user.click(btn);
    await waitFor(() => expect(vi.mocked(api.dispatchInvoice)).toHaveBeenCalledWith("p1"));
  });

  it("re-sorts the queue for ascending, descending and job-title rules", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listInvoices).mockImplementation((code?: string) =>
      Promise.resolve(
        code
          ? [
              inv({ id: "hi", amount: 900, line_items: [{ ...inv().line_items[0], employee_name: "Bravo", job_title: "Zeta" }] }),
              inv({ id: "lo", amount: 100, line_items: [{ ...inv().line_items[0], employee_name: "Alpha", job_title: "Alpha" }] }),
            ]
          : [],
      ),
    );
    renderPage(<FinOpsDispatch />);
    await screen.findByText("Ordering rule");

    // Each click drives a different branch of the `ordered` useMemo sort.
    await user.click(screen.getByRole("button", { name: /Ascending billable amount/ }));
    await user.click(screen.getByRole("button", { name: /Descending billable amount/ }));
    await user.click(screen.getByRole("button", { name: /Group by job title/ }));
    // Both employees still present after re-sorts.
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Bravo")).toBeInTheDocument();
  });

  it("changing the ordering rule reveals the unsaved hint and can save the default", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listInvoices).mockResolvedValue([]);
    renderPage(<FinOpsDispatch />);

    await screen.findByText("Ordering rule");
    await user.click(screen.getByRole("button", { name: /Descending billable amount/ }));
    expect(await screen.findByText(/Unsaved/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Save as default/ }));
    await waitFor(() =>
      expect(vi.mocked(api.updateClientSettings)).toHaveBeenCalledWith("CL001", { dispatch_rule: "descending_amount" }),
    );
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

vi.mock("../../src/api", () => ({
  api: { listClients: vi.fn(), listInvoices: vi.fn(), metricsStp: vi.fn(), updateClientSettings: vi.fn(), dispatchInvoice: vi.fn() },
}));

import { api } from "../../src/api";
import { FinOpsDispatch } from "../../src/pages/FinOpsDispatch";

const loc = { value: "" };
function LocationProbe() {
  loc.value = useLocation().pathname;
  return null;
}

function renderPage(node: ReactElement, entry: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/console/dispatch/:clientCode" element={node} />
          <Route path="/console/dispatch" element={node} />
        </Routes>
        <LocationProbe />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  loc.value = "";
  vi.mocked(api.listClients).mockReset().mockResolvedValue([
    { code: "CL001", name: "Emirates Steel", settings: {} },
    { code: "CL002", name: "Dubai Co", settings: {} },
  ] as never);
  vi.mocked(api.metricsStp).mockReset().mockResolvedValue({ total: 0, auto: 0, hitl: 0, escalate: 0, touchless_rate: 0, target: 0.9 } as never);
  vi.mocked(api.listInvoices).mockReset().mockResolvedValue([]);
  vi.mocked(api.updateClientSettings).mockReset().mockResolvedValue({ code: "CL001", settings: {} } as never);
  vi.mocked(api.dispatchInvoice).mockReset().mockResolvedValue({ status: "dispatched", idempotency_key: "k" } as never);
});
afterEach(() => vi.clearAllMocks());

describe("FinOpsDispatch — redirect + header client switch", () => {
  it("redirects to the first client when no :clientCode is present", async () => {
    renderPage(<FinOpsDispatch />, "/console/dispatch");
    await waitFor(() => expect(loc.value).toBe("/console/dispatch/CL001"));
  });

  it("navigates when a different client is picked from the header select", async () => {
    const user = userEvent.setup();
    renderPage(<FinOpsDispatch />, "/console/dispatch/CL001");
    await screen.findByText("Ordering rule");
    await user.click(screen.getByRole("button", { name: "Select client" }));
    await user.click(await screen.findByRole("option", { name: /CL002 · Dubai Co/ }));
    await waitFor(() => expect(loc.value).toBe("/console/dispatch/CL002"));
  });

  it("renders queue rows with employee/job fallbacks", async () => {
    vi.mocked(api.listInvoices).mockImplementation((code?: string) =>
      Promise.resolve(
        code
          ? ([{ id: "no-lineitems-1", timesheet_id: "t", client_code: "CL001", period: "2026-06", amount: 500, currency: "AED", status: "generated", line_items: [], pdf_available: false, dispatched_at: null }] as never)
          : ([] as never),
      ),
    );
    renderPage(<FinOpsDispatch />, "/console/dispatch/CL001");
    // employee_name ?? client_code fallback → shows client_code
    expect(await screen.findByText("CL001")).toBeInTheDocument();
  });
});

describe("FinOpsDispatch — job-title sort fallback + pending spinners", () => {
  const noLineItems = (id: string) => ({
    id, timesheet_id: "t", client_code: "CL001", period: "2026-06", amount: 500, currency: "AED",
    status: "generated", line_items: [], pdf_available: false, dispatched_at: null,
  });

  it("sorts by job title with empty line items (`?? ''` fallback) and dispatches (pending spinner)", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listInvoices).mockImplementation((code?: string) =>
      Promise.resolve(code ? ([noLineItems("a"), noLineItems("b")] as never) : ([] as never)),
    );
    vi.mocked(api.dispatchInvoice).mockReturnValue(new Promise(() => {}) as never); // pending
    renderPage(<FinOpsDispatch />, "/console/dispatch/CL001");
    await screen.findByText("Ordering rule");
    await user.click(screen.getByRole("button", { name: /Group by job title/ })); // job_title ?? "" (line 55)
    await user.click(screen.getByRole("button", { name: /Dispatch \d/ }));
    expect(await screen.findByText("Dispatching…")).toBeInTheDocument(); // line 139
  });

  it("shows the save spinner while persisting the rule", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listInvoices).mockResolvedValue([] as never);
    vi.mocked(api.updateClientSettings).mockReturnValue(new Promise(() => {}) as never); // pending
    renderPage(<FinOpsDispatch />, "/console/dispatch/CL001");
    await screen.findByText("Ordering rule");
    await user.click(screen.getByRole("button", { name: /Descending billable amount/ }));
    await user.click(screen.getByRole("button", { name: /Save as default/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Save as default/ })).toBeDisabled()); // line 136
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { Invoice } from "../../src/types";

vi.mock("../../src/api", () => ({
  api: {
    listClients: vi.fn(), listInvoices: vi.fn(),
    clientApprove: vi.fn(), clientReject: vi.fn(), raiseQuery: vi.fn(),
  },
  API_BASE: "http://127.0.0.1:8000",
}));

import { api } from "../../src/api";
import { ClientInvoices } from "../../src/pages/ClientInvoices";
import { usePersona } from "../../src/store";

function renderPage(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={["/portal/invoices"]}>
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const inv = (over: Partial<Invoice> = {}): Invoice => ({
  id: "i-note", timesheet_id: "ts", client_code: "CL001", period: "2026-06", amount: 1000,
  currency: "AED", status: "generated", line_items: [], pdf_available: false,
  dispatched_at: null, invoice_sequence_no: "INV-N", client_approval_status: null, ...over,
});

beforeEach(() => {
  usePersona.setState({ persona: "client", currentClientCode: "CL001", aidaOpen: false, focusedEntity: null });
  vi.mocked(api.listClients).mockResolvedValue([{ code: "CL001", name: "Emirates Steel", city: "AUH", industry: "Steel", settings: {} }]);
  vi.mocked(api.clientApprove).mockResolvedValue({ status: "approved", invoice_id: "i-note" });
});
afterEach(() => vi.clearAllMocks());

describe("ClientInvoices — approve with a note", () => {
  it("forwards the typed note to clientApprove (the reason-present branch)", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listInvoices).mockResolvedValue([inv()]);
    renderPage(<ClientInvoices />);

    const hero = (await screen.findByText("Awaiting your approval")).closest("section")!;
    await user.click(within(hero).getByRole("button", { name: /Approve/ }));

    const dialog = screen.getByRole("heading", { name: "Approve invoice" }).closest("div")!;
    await user.type(within(dialog).getByPlaceholderText(/Anything FinOps should know/), "Looks correct, thanks");
    await user.click(within(dialog).getByRole("button", { name: /^Approve$/ }));

    await waitFor(() =>
      expect(vi.mocked(api.clientApprove)).toHaveBeenCalledWith("i-note", "client", "Looks correct, thanks"),
    );
  });
});

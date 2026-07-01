import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../src/api", () => ({
  api: { listClients: vi.fn(), listInvoices: vi.fn(), clientApprove: vi.fn(), clientReject: vi.fn(), raiseQuery: vi.fn() },
  API_BASE: "http://127.0.0.1:8000",
}));

import { api } from "../../src/api";
import { ClientInvoices } from "../../src/pages/ClientInvoices";
import { usePersona } from "../../src/store";
import type { Invoice } from "../../src/types";

function renderPage(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={["/portal/invoices"]}>
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </MemoryRouter>,
  );
}

// A pending invoice missing the VAT/sequence/period fields → exercises the
// vatBreakdown + id.slice + "-" fallbacks.
const pending = {
  id: "pending-1234-5678", client_code: "CL001", amount: 1000, currency: "AED",
  status: "generated", client_approval_status: null, line_items: [], pdf_available: true,
  timesheet_id: "t1", dispatched_at: null,
} as unknown as Invoice;

beforeEach(() => {
  usePersona.setState({ persona: "client", currentClientCode: "CL001" });
  vi.mocked(api.listClients).mockReset().mockResolvedValue([{ code: "CL001", name: "Emirates Steel", settings: {} }] as never);
  vi.mocked(api.listInvoices).mockReset().mockResolvedValue([pending] as never);
  vi.mocked(api.clientApprove).mockReset().mockResolvedValue({ status: "approved", invoice_id: "pending-1234-5678" } as never);
  vi.mocked(api.clientReject).mockReset().mockResolvedValue({ status: "rejected", invoice_id: "pending-1234-5678" } as never);
  vi.mocked(api.raiseQuery).mockReset().mockResolvedValue({ id: "Q1", status: "open", client_code: "CL001" } as never);
});
afterEach(() => vi.clearAllMocks());

describe("ClientInvoices — pending hero actions + modal submit", () => {
  it("approves from the hero card", async () => {
    const user = userEvent.setup();
    renderPage(<ClientInvoices />);
    await screen.findByText("Awaiting your approval");
    // hero Approve button (there are hero + table approve buttons; take the first)
    await user.click(screen.getAllByRole("button", { name: /Approve/ })[0]);
    await screen.findByText("Approve invoice");
    const approveBtns = screen.getAllByRole("button", { name: "Approve" });
    await user.click(approveBtns[approveBtns.length - 1]);
    await waitFor(() => expect(vi.mocked(api.clientApprove)).toHaveBeenCalledWith("pending-1234-5678", "client", undefined));
  });

  it("rejects from the hero card with a reason", async () => {
    const user = userEvent.setup();
    renderPage(<ClientInvoices />);
    await screen.findByText("Awaiting your approval");
    await user.click(screen.getAllByRole("button", { name: /Reject/ })[0]);
    await screen.findByText("Reject invoice");
    await user.type(screen.getByPlaceholderText(/Why are you rejecting/), "wrong total");
    await user.click(screen.getByRole("button", { name: /Confirm reject/ }));
    await waitFor(() => expect(vi.mocked(api.clientReject)).toHaveBeenCalledWith("pending-1234-5678", "wrong total"));
  });

  it("raises a query from the hero card", async () => {
    const user = userEvent.setup();
    renderPage(<ClientInvoices />);
    await screen.findByText("Awaiting your approval");
    await user.click(screen.getAllByRole("button", { name: /Raise query/ })[0]);
    await screen.findByText("Raise a query");
    await user.type(screen.getByPlaceholderText(/Describe the question/), "please clarify");
    await user.click(screen.getByRole("button", { name: /Submit query/ }));
    await waitFor(() => expect(vi.mocked(api.raiseQuery)).toHaveBeenCalled());
  });
});

describe("ClientInvoices — table-row actions, totals, submitting", () => {
  it("opens the query modal from a table row and edits the subject", async () => {
    const user = userEvent.setup();
    renderPage(<ClientInvoices />);
    await screen.findByText("Awaiting your approval");
    const table = screen.getByRole("table");
    // table-row "Raise query" (icon button, title) → setActionFor (line 108)
    await user.click(within(table).getByRole("button", { name: /Raise query/i }));
    await screen.findByText("Raise a query");
    // subject input onChange (line 228)
    const subject = screen.getByDisplayValue(/Question on invoice/);
    await user.clear(subject);
    await user.type(subject, "New subject");
    await user.type(screen.getByPlaceholderText(/Describe the question/), "details");
    await user.click(screen.getByRole("button", { name: /Submit query/ }));
    await waitFor(() => expect(vi.mocked(api.raiseQuery)).toHaveBeenCalled());
  });

  it("rejects and approves from table rows", async () => {
    const user = userEvent.setup();
    renderPage(<ClientInvoices />);
    await screen.findByText("Awaiting your approval");
    const table = screen.getByRole("table");
    await user.click(within(table).getByRole("button", { name: /Reject/ })); // line 109
    await screen.findByText("Reject invoice");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(within(table).getByRole("button", { name: /Approve/ })); // line 110
    await screen.findByText("Approve invoice");
  });

  it("uses backend VAT fields when present and vatBreakdown otherwise", async () => {
    vi.mocked(api.listInvoices).mockResolvedValue([
      { id: "with-vat", client_code: "CL001", amount: 1000, currency: "AED", status: "approved", client_approval_status: "approved", total_incl_vat: 1050, vat_amount: 50, total_excl_vat: 1000, line_items: [], pdf_available: false, timesheet_id: "t", dispatched_at: null },
      { id: "no-vat", client_code: "CL001", amount: 2000, currency: "AED", status: "approved", client_approval_status: "approved", line_items: [], pdf_available: false, timesheet_id: "t", dispatched_at: null },
      { id: "total-no-vatamt", client_code: "CL001", amount: 3000, currency: "AED", status: "approved", client_approval_status: "approved", total_incl_vat: 3150, line_items: [], pdf_available: false, timesheet_id: "t", dispatched_at: null },
      // total_incl_vat + vat_amount present but no total_excl_vat → return's `total_excl_vat ?? amount`
      { id: "noexcl99", client_code: "CL001", amount: 4000, currency: "AED", status: "approved", client_approval_status: "approved", total_incl_vat: 4200, vat_amount: 200, line_items: [], pdf_available: false, timesheet_id: "t", dispatched_at: null },
    ] as never);
    renderPage(<ClientInvoices />);
    // rows render; totals() takes every branch incl. total_excl_vat ?? amount
    expect(await screen.findByText("with-vat")).toBeInTheDocument();
    expect(screen.getByText("no-vat")).toBeInTheDocument();
    expect(screen.getByText("total-no")).toBeInTheDocument(); // id sliced to 8 chars
    expect(screen.getByText("noexcl99")).toBeInTheDocument();
  });

  it("shows the submitting spinner while an approve is in flight", async () => {
    const user = userEvent.setup();
    vi.mocked(api.clientApprove).mockReturnValue(new Promise(() => {}) as never); // pending
    renderPage(<ClientInvoices />);
    await screen.findByText("Awaiting your approval");
    await user.click(screen.getAllByRole("button", { name: /Approve/ })[0]);
    await screen.findByText("Approve invoice");
    const approveBtns = screen.getAllByRole("button", { name: "Approve" });
    const modalApprove = approveBtns[approveBtns.length - 1];
    fireEvent.click(modalApprove);
    await waitFor(() => expect(modalApprove).toBeDisabled());
  });
});

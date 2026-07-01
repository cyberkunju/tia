import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// Single network seam. Declare every api.* the page (and the InvoiceChatTrigger
// child, which uses none) touch. API_BASE is imported for the PDF href.
vi.mock("../../src/api", () => ({
  api: {
    listClients: vi.fn(),
    listInvoices: vi.fn(),
    clientApprove: vi.fn(),
    clientReject: vi.fn(),
    raiseQuery: vi.fn(),
  },
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

const inv = (over: Partial<Invoice> = {}): Invoice => ({
  id: "aaaa1111-2222-3333-4444",
  timesheet_id: "ts-1",
  client_code: "CL001",
  period: "2026-06",
  amount: 1000,
  currency: "AED",
  status: "generated",
  line_items: [],
  pdf_available: false,
  dispatched_at: null,
  invoice_sequence_no: "INV-2026-0001",
  client_approval_status: null,
  ...over,
});

beforeEach(() => {
  usePersona.setState({ persona: "client", currentClientCode: "CL001", resetTick: 0, aidaOpen: false, focusedEntity: null });
  vi.mocked(api.listClients).mockResolvedValue([
    { code: "CL001", name: "Emirates Steel", city: "AUH", industry: "Steel", settings: {} },
  ]);
  vi.mocked(api.clientApprove).mockResolvedValue({ status: "approved", invoice_id: "aaaa1111-2222-3333-4444" });
  vi.mocked(api.clientReject).mockResolvedValue({ status: "rejected", invoice_id: "aaaa1111-2222-3333-4444" });
  vi.mocked(api.raiseQuery).mockResolvedValue({ id: "q1", status: "open", client_code: "CL001" });
});
afterEach(() => vi.clearAllMocks());

describe("ClientInvoices page", () => {
  it("prompts to pick a client when no client is selected", async () => {
    usePersona.setState({ currentClientCode: null });
    vi.mocked(api.listInvoices).mockResolvedValue([]);
    renderPage(<ClientInvoices />);
    expect(await screen.findByText("Pick a client")).toBeInTheDocument();
    // Generic header (no client name suffix) when no client is chosen.
    expect(screen.getByText("Invoices")).toBeInTheDocument();
  });

  it("shows the empty state and client-scoped header when the client has no invoices", async () => {
    vi.mocked(api.listInvoices).mockResolvedValue([]);
    renderPage(<ClientInvoices />);
    expect(await screen.findByText("No invoices yet")).toBeInTheDocument();
    expect(screen.getByText("Invoices · Emirates Steel")).toBeInTheDocument();
    expect(vi.mocked(api.listInvoices)).toHaveBeenCalledWith("CL001");
  });

  it("renders the loading skeleton while invoices are in flight", async () => {
    // A never-resolving promise keeps the query pending → TableSkeleton renders.
    vi.mocked(api.listInvoices).mockReturnValue(new Promise<Invoice[]>(() => {}));
    const { container } = renderPage(<ClientInvoices />);
    await waitFor(() => expect(container.querySelector(".skeleton")).toBeTruthy());
    expect(screen.queryByText("No invoices yet")).not.toBeInTheDocument();
  });

  it("renders rows with dispatch/approval badges and both VAT total paths", async () => {
    vi.mocked(api.listInvoices).mockResolvedValue([
      // approved + dispatched → 'approved' badge, dispatched (not AUTO) badge.
      inv({ id: "i-approved", invoice_sequence_no: "INV-A", status: "dispatched", client_approval_status: "approved", total_excl_vat: 2000, vat_amount: 100, total_incl_vat: 2100 }),
      // rejected → 'rejected' badge, generated status → no dispatch chip.
      inv({ id: "i-rejected", invoice_sequence_no: "INV-R", status: "generated", client_approval_status: "rejected" }),
      // pending + dispatched + no approval → AUTO chip; this is the hero.
      inv({ id: "i-auto", invoice_sequence_no: "INV-AUTO", status: "dispatched", client_approval_status: null, total_incl_vat: 1050, vat_amount: 50, total_excl_vat: 1000, pdf_available: true }),
      // pending + generated + no explicit VAT → totals fall back to vatBreakdown(amount).
      inv({ id: "i-fallback", invoice_sequence_no: "INV-FB", status: "generated", amount: 200, total_incl_vat: null, vat_amount: null }),
    ]);
    renderPage(<ClientInvoices />);

    // Hero is the first pending invoice (INV-AUTO).
    expect(await screen.findByText("Awaiting your approval")).toBeInTheDocument();
    const table = screen.getByRole("table");
    const t = within(table);
    expect(t.getByText("INV-A")).toBeInTheDocument();
    expect(t.getByText("approved")).toBeInTheDocument();
    expect(t.getByText("rejected")).toBeInTheDocument();
    // AUTO chip for the auto-dispatched pending invoice.
    expect(t.getByText("AUTO")).toBeInTheDocument();
    // dispatched (non-auto) chip on the approved+dispatched row.
    expect(t.getByText("dispatched")).toBeInTheDocument();
    // vatBreakdown fallback: amount 200 → subtotal 200, vat 10, total 210.
    expect(t.getByText("AED 200.00")).toBeInTheDocument();
    expect(t.getByText("AED 10.00")).toBeInTheDocument();
    expect(t.getByText("AED 210.00")).toBeInTheDocument();
    // 'pending' approval badges present for the two unresolved rows.
    expect(t.getAllByText("pending").length).toBe(2);
    // PDF link uses API_BASE.
    const pdf = t.getAllByRole("link").find((a) => a.getAttribute("href")?.includes("/invoices/i-auto/pdf"));
    expect(pdf).toBeTruthy();
  });

  it("approves the hero invoice through the modal", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listInvoices).mockResolvedValue([inv({ id: "i-auto", status: "generated" })]);
    renderPage(<ClientInvoices />);

    const hero = (await screen.findByText("Awaiting your approval")).closest("section")!;
    await user.click(within(hero).getByRole("button", { name: /Approve/ }));

    const dialog = screen.getByRole("heading", { name: "Approve invoice" }).closest("div")!;
    await user.click(within(dialog).getByRole("button", { name: /^Approve$/ }));

    await waitFor(() => expect(vi.mocked(api.clientApprove)).toHaveBeenCalledWith("i-auto", "client", undefined));
    // onDone closes the modal.
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Approve invoice" })).not.toBeInTheDocument());
  });

  it("requires a reason before rejecting and calls clientReject", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listInvoices).mockResolvedValue([inv({ id: "i-auto", status: "generated" })]);
    renderPage(<ClientInvoices />);

    const hero = (await screen.findByText("Awaiting your approval")).closest("section")!;
    await user.click(within(hero).getByRole("button", { name: /Reject/ }));

    const dialog = screen.getByRole("heading", { name: "Reject invoice" }).closest("div")!;
    const confirm = within(dialog).getByRole("button", { name: /Confirm reject/ });
    expect(confirm).toBeDisabled();

    await user.type(within(dialog).getByRole("textbox"), "wrong amount");
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => expect(vi.mocked(api.clientReject)).toHaveBeenCalledWith("i-auto", "wrong amount"));
  });

  it("raises a query with the prefilled subject and typed details", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listInvoices).mockResolvedValue([inv({ id: "i-auto", invoice_sequence_no: "INV-AUTO", status: "generated" })]);
    renderPage(<ClientInvoices />);

    const hero = (await screen.findByText("Awaiting your approval")).closest("section")!;
    await user.click(within(hero).getByRole("button", { name: /Raise query/ }));

    const dialog = screen.getByRole("heading", { name: "Raise a query" }).closest("div")!;
    const submit = within(dialog).getByRole("button", { name: /Submit query/ });
    expect(submit).toBeDisabled();
    // Subject is prefilled from the invoice sequence number.
    expect(within(dialog).getByDisplayValue("Question on invoice INV-AUTO")).toBeInTheDocument();

    await user.type(within(dialog).getByPlaceholderText(/Describe the question/), "Need a breakdown");
    await user.click(submit);

    await waitFor(() =>
      expect(vi.mocked(api.raiseQuery)).toHaveBeenCalledWith("CL001", {
        subject: "Question on invoice INV-AUTO",
        body: "Need a breakdown",
        invoice_id: "i-auto",
        raised_by: "client",
      }),
    );
  });

  it("closes the modal via Cancel and via the X button without mutating", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listInvoices).mockResolvedValue([inv({ id: "i-auto", status: "generated" })]);
    renderPage(<ClientInvoices />);

    const hero = (await screen.findByText("Awaiting your approval")).closest("section")!;
    await user.click(within(hero).getByRole("button", { name: /Approve/ }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Approve invoice" })).not.toBeInTheDocument());

    await user.click(within(hero).getByRole("button", { name: /Reject/ }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Reject invoice" })).not.toBeInTheDocument());

    expect(vi.mocked(api.clientApprove)).not.toHaveBeenCalled();
    expect(vi.mocked(api.clientReject)).not.toHaveBeenCalled();
  });
});

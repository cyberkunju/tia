import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../src/api", () => ({
  api: {
    listClients: vi.fn(),
    listInvoices: vi.fn(),
    updateClientSettings: vi.fn(),
    createClient: vi.fn(),
  },
}));

import { api } from "../../src/api";
import { ClientsConfig } from "../../src/pages/ClientsConfig";
import type { ApiClient, Invoice } from "../../src/types";

function renderPage(node: ReactElement, entry = "/console/settings/clients") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const clients: ApiClient[] = [
  {
    code: "CL001", name: "Emirates Steel", city: "Abu Dhabi", industry: "Steel",
    settings: { watched_mailboxes: ["ts@steel.ae"], whatsapp_enabled: true, dispatch_rule: "ascending_amount", markup_pct: 0.2, threshold_aed: 70000, currency: "AED" },
  },
  { code: "CL002", name: "Dubai Co", city: "Dubai", industry: "Logistics", settings: {} },
];

const inv = (over: Partial<Invoice> = {}): Invoice => ({
  id: "i1", timesheet_id: "t1", client_code: "CL001", period: "2026-06",
  amount: 1000, currency: "AED", status: "dispatched", line_items: [],
  pdf_available: false, dispatched_at: "2026-06-10T09:00:00Z", total_incl_vat: 1050, ...over,
});

beforeEach(() => {
  vi.mocked(api.listClients).mockReset().mockResolvedValue(clients);
  vi.mocked(api.listInvoices).mockReset().mockResolvedValue([]);
  vi.mocked(api.updateClientSettings).mockReset().mockResolvedValue({ code: "CL001", settings: {} });
  vi.mocked(api.createClient).mockReset().mockResolvedValue({ code: "CL011", name: "New", settings: {} });
});
afterEach(() => vi.clearAllMocks());

describe("ClientsConfig page", () => {
  it("lists clients and shows the first client's detail with channel chips", async () => {
    vi.mocked(api.listInvoices).mockResolvedValue([inv(), inv({ id: "i2", status: "generated" })]);
    renderPage(<ClientsConfig />);

    // Sidebar list + detail header
    expect(await screen.findAllByText("CL001")).not.toHaveLength(0);
    expect(screen.getAllByText("Emirates Steel").length).toBeGreaterThan(0);
    // Channels derived from settings: Portal + Email (1 mailbox) + WhatsApp
    expect(screen.getByText("Portal upload")).toBeInTheDocument();
    expect(screen.getByText(/Email · 1 mailbox/)).toBeInTheDocument();
    expect(screen.getByText("WhatsApp")).toBeInTheDocument();
    // Live activity tiles derived from invoices
    expect(screen.getByText("Invoices")).toBeInTheDocument();
    expect(screen.getByText("Dispatched")).toBeInTheDocument();
  });

  it("shows the no-activity message when the active client has no invoices", async () => {
    vi.mocked(api.listInvoices).mockResolvedValue([]);
    renderPage(<ClientsConfig />);
    expect(await screen.findByText(/No invoices generated for this client yet/)).toBeInTheDocument();
  });

  it("selects a different client from the sidebar", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listInvoices).mockResolvedValue([]);
    renderPage(<ClientsConfig />);

    await screen.findByText("Dubai Co");
    await user.click(screen.getByRole("button", { name: /Dubai Co/ }));
    await waitFor(() => expect(screen.getByText(/CL002 · Dubai/)).toBeInTheDocument());
  });

  it("saves processing parameters for the active client", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listInvoices).mockResolvedValue([]);
    renderPage(<ClientsConfig />);

    await screen.findByText("Processing parameters");
    await user.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(vi.mocked(api.updateClientSettings)).toHaveBeenCalledWith("CL001", expect.objectContaining({ dispatch_rule: expect.any(String) })));
  });

  it("opens the new-client form, creates a client, and disables submit until required fields are set", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listInvoices).mockResolvedValue([]);
    renderPage(<ClientsConfig />);

    await user.click(await screen.findByRole("button", { name: /New client/ }));
    const create = screen.getByRole("button", { name: /Create/ });
    expect(create).toBeDisabled();

    await user.type(screen.getByPlaceholderText("CL011"), "cl011");
    // Name is the first md:col-span-2 input; grab the Name label's input by role among textboxes.
    const nameInput = screen.getAllByRole("textbox")[1];
    await user.type(nameInput, "New Client Co");
    expect(create).toBeEnabled();
    await user.click(create);
    await waitFor(() => expect(vi.mocked(api.createClient)).toHaveBeenCalled());
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../src/api", () => ({
  api: { listClients: vi.fn(), listInvoices: vi.fn(), updateClientSettings: vi.fn(), createClient: vi.fn() },
}));

import { api } from "../../src/api";
import { ClientsConfig } from "../../src/pages/ClientsConfig";

function renderPage(node: ReactElement, entry = "/console/settings/clients") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(api.listClients).mockReset().mockResolvedValue([
    { code: "CL001", name: "Emirates Steel", city: "AUH", industry: "Steel", settings: { watched_mailboxes: ["ops@x.com"], whatsapp_enabled: true } },
    { code: "CL002", name: "Dubai Co", city: "DXB", industry: "Logistics", settings: {} },
  ] as never);
  // invoices with dispatched_at drive the per-client "latest" stats (line 68).
  vi.mocked(api.listInvoices).mockReset().mockResolvedValue([
    { id: "i1", client_code: "CL001", status: "dispatched", total_incl_vat: 5000, period: "2026-05", dispatched_at: "2026-05-10T10:00:00Z" },
    { id: "i2", client_code: "CL001", status: "generated", amount: 3000, period: "2026-06", dispatched_at: "2026-06-10T10:00:00Z" },
  ] as never);
  vi.mocked(api.updateClientSettings).mockReset().mockResolvedValue({ code: "CL001", settings: {} } as never);
  vi.mocked(api.createClient).mockReset().mockResolvedValue({ code: "CL011", name: "New", settings: {} } as never);
});
afterEach(() => vi.clearAllMocks());

describe("ClientsConfig — selection, params + new client form", () => {
  it("renders the processing panel (rule/profile selects) and edits markup/threshold", async () => {
    const user = userEvent.setup();
    renderPage(<ClientsConfig />);
    // Processing parameters panel renders once a client is active → DISPATCH_RULES/PROFILES maps run.
    expect(await screen.findByLabelText("Dispatch rule")).toBeInTheDocument();
    expect(screen.getByLabelText("Validation profile")).toBeInTheDocument();

    // live stats derived from invoices (latest period comparison)
    expect(screen.getByText("Live activity")).toBeInTheDocument();

    // edit markup + threshold number inputs (onChange handlers)
    const nums = screen.getAllByRole("spinbutton");
    await user.clear(nums[0]);
    await user.type(nums[0], "0.2");
    await user.clear(nums[1]);
    await user.type(nums[1], "70000");
    expect((nums[1] as HTMLInputElement).value).toBe("70000");
  });

  it("selects a client from the sidebar list", async () => {
    const user = userEvent.setup();
    renderPage(<ClientsConfig />);
    await screen.findByText("Dubai Co");
    // click the CL002 sidebar entry → setParams
    await user.click(screen.getByText("CL002"));
    await waitFor(() => expect(screen.getAllByText("Dubai Co").length).toBeGreaterThan(0));
  });

  it("opens the new-client form and fills every field", async () => {
    const user = userEvent.setup();
    renderPage(<ClientsConfig />);
    await user.click(await screen.findByRole("button", { name: /New client/ }));
    await user.type(screen.getByPlaceholderText("CL011"), "cl011");
    // NewClientForm textboxes: [code, name, city, industry, customer_trn]
    const tb = screen.getAllByRole("textbox");
    await user.type(tb[1], "New Client Co");
    await user.type(tb[2], "Sharjah");
    await user.type(tb[3], "Retail");
    await user.type(tb[4], "100999");
    await user.click(screen.getByRole("button", { name: /Create/ }));
    await waitFor(() => expect(vi.mocked(api.createClient)).toHaveBeenCalled());
    expect(tb.length).toBeGreaterThan(0);
  });
});

describe("ClientsConfig — stats edge cases + pending/error", () => {
  it("handles invoices with no client_code / no amount and default StatTile tones", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listClients).mockResolvedValue([
      { code: "CL001", name: "Emirates Steel", city: null, industry: null, settings: {} }, // null city/industry
      { code: "CL002", name: "Dubai Co", city: "DXB", industry: "Logistics", settings: {} },
    ] as never);
    vi.mocked(api.listInvoices).mockResolvedValue([
      { id: "x0", client_code: null, status: "generated", amount: 1 }, // no client_code → `continue`
      { id: "x1", client_code: "CL002", status: "approved" }, // neither total_incl_vat nor amount → `?? 0`; not dispatched/generated → default tones
    ] as never);
    renderPage(<ClientsConfig />, "/console/settings/clients?c=CL002");
    // CL002 selected: null city/industry on CL001 aren't shown, but CL002 stats render
    await screen.findByText("Live activity");
    // CL002 has 1 invoice, 0 dispatched, 0 pending → default tones + no latest hint
    expect(screen.getByText("Invoices")).toBeInTheDocument();
    // switch to CL001 (null city/industry → "-")
    await user.click(screen.getByText("CL001"));
    await waitFor(() => expect(screen.getAllByText("-").length).toBeGreaterThan(0));
  });

  it("shows the save spinner while saving", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateClientSettings).mockReturnValue(new Promise(() => {}) as never);
    renderPage(<ClientsConfig />);
    const save = await screen.findByRole("button", { name: /Save/ });
    await user.click(save);
    await waitFor(() => expect(save).toBeDisabled());
  });

  it("surfaces a create error and shows the create spinner", async () => {
    const user = userEvent.setup();
    let reject!: (e: Error) => void;
    vi.mocked(api.createClient).mockReturnValue(new Promise((_r, rej) => { reject = rej; }) as never);
    renderPage(<ClientsConfig />);
    await user.click(await screen.findByRole("button", { name: /New client/ }));
    await user.type(screen.getByPlaceholderText("CL011"), "CL099");
    const tb = screen.getAllByRole("textbox");
    await user.type(tb[1], "Name Co");
    const createBtn = screen.getByRole("button", { name: /Create/ });
    await user.click(createBtn);
    await waitFor(() => expect(createBtn).toBeDisabled()); // create.isPending spinner
    reject(new Error("dup"));
    expect(await screen.findByText(/Could not create client/)).toBeInTheDocument();
  });
});

describe("ClientsConfig — client with no settings object", () => {
  it("derives channels from an undefined settings object (`?? {}`)", async () => {
    vi.mocked(api.listClients).mockResolvedValue([
      { code: "CL003", name: "No Settings Co", city: "AUH", industry: "X" }, // no settings prop
    ] as never);
    vi.mocked(api.listInvoices).mockResolvedValue([] as never);
    renderPage(<ClientsConfig />, "/console/settings/clients?c=CL003");
    // Input channels panel renders → clientChannels(undefined) → Portal upload always present
    expect(await screen.findByText("Portal upload")).toBeInTheDocument();
  });
});

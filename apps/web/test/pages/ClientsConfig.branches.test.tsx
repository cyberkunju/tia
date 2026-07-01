import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ApiClient, Invoice } from "../../src/types";

vi.mock("../../src/api", () => ({
  api: {
    listClients: vi.fn(), listInvoices: vi.fn(),
    updateClientSettings: vi.fn(), createClient: vi.fn(),
  },
}));

import { api } from "../../src/api";
import { ClientsConfig } from "../../src/pages/ClientsConfig";

function renderPage(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={["/console/settings/clients"]}>
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </MemoryRouter>,
  );
}

// A client that flips the branches the main ClientsConfig test doesn't:
//  - >1 watched mailbox → the plural "mailboxes" label
//  - whatsapp_enabled falsy → no WhatsApp chip (the `if` false branch)
//  - dispatch_order_rule set but dispatch_rule absent → the `?? dispatch_order_rule` fallback
const clients: ApiClient[] = [
  {
    code: "CL050", name: "Fujairah Freight", city: "Fujairah", industry: "Logistics",
    settings: {
      watched_mailboxes: ["ops@ff.ae", "billing@ff.ae"],
      dispatch_order_rule: "by_job_title",
      validation_threshold_aed: 80000,
    },
  },
];

const inv = (over: Partial<Invoice> = {}): Invoice => ({
  id: "i1", timesheet_id: "t1", client_code: "CL050", period: "2026-06", amount: 1000,
  currency: "AED", status: "dispatched", line_items: [], pdf_available: false,
  dispatched_at: "2026-06-10T09:00:00Z", total_incl_vat: 1050, ...over,
});

beforeEach(() => {
  vi.mocked(api.listClients).mockReset().mockResolvedValue(clients);
  vi.mocked(api.updateClientSettings).mockReset().mockResolvedValue({ code: "CL050", settings: {} });
  vi.mocked(api.createClient).mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("ClientsConfig — branch coverage", () => {
  it("renders a plural mailbox chip, no WhatsApp chip, and dispatched/pending stat tones", async () => {
    vi.mocked(api.listInvoices).mockResolvedValue([
      inv({ id: "d1", status: "dispatched" }),
      inv({ id: "g1", status: "generated", dispatched_at: null }),
    ]);
    renderPage(<ClientsConfig />);

    // plural "mailboxes" (2 watched) — exercises the length !== 1 branch
    expect(await screen.findByText(/Email · 2 mailboxes/)).toBeInTheDocument();
    // whatsapp not enabled → chip absent
    expect(screen.queryByText("WhatsApp")).not.toBeInTheDocument();
    // watched-mailboxes footnote line
    expect(screen.getByText(/ops@ff\.ae, billing@ff\.ae/)).toBeInTheDocument();
    // stats: one dispatched + one generated(pending) → both tiles show 1
    expect(screen.getByText("Dispatched")).toBeInTheDocument();
    expect(screen.getByText("Pending dispatch")).toBeInTheDocument();
  });
});

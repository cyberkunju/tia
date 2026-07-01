import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../src/api", () => ({
  api: {
    listRules: vi.fn(),
    listInvoices: vi.fn(),
  },
}));

import { api } from "../../src/api";
import { RulesConfig } from "../../src/pages/RulesConfig";
import type { Invoice, RuleCatalogue } from "../../src/types";

function renderPage(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const catalogue: RuleCatalogue = {
  count: 3,
  rules: [
    { rule_id: "R1", function_name: "r1_rate_match", friendly_message: "Rate matches the contract" },
    { rule_id: "R2", function_name: "r2_ot_cap", friendly_message: "Overtime within cap" },
    { rule_id: "R3", function_name: "r3_scope", friendly_message: "" },
  ],
  friendly_message_table: {},
};

const inv = (over: Partial<Invoice> = {}): Invoice => ({
  id: "i1", timesheet_id: "t1", client_code: "CL001", period: "2026-06",
  amount: 1000, currency: "AED", status: "generated", line_items: [],
  pdf_available: false, dispatched_at: null, ...over,
});

beforeEach(() => {
  vi.mocked(api.listRules).mockReset();
  vi.mocked(api.listInvoices).mockReset().mockResolvedValue([]);
});
afterEach(() => vi.clearAllMocks());

describe("RulesConfig page", () => {
  it("shows the loading state while the catalogue is in flight", async () => {
    vi.mocked(api.listRules).mockReturnValue(new Promise<RuleCatalogue>(() => {}));
    renderPage(<RulesConfig />);
    expect(await screen.findByText("Loading rule catalogue…")).toBeInTheDocument();
  });

  it("renders the catalogue with a friendly name, description fallback and enabled badge", async () => {
    vi.mocked(api.listRules).mockResolvedValue(catalogue);
    renderPage(<RulesConfig />);

    expect(await screen.findByText("rate match")).toBeInTheDocument();
    expect(screen.getByText("Rate matches the contract")).toBeInTheDocument();
    // R3 has an empty friendly_message → falls back to "-"
    expect(screen.getByText("scope")).toBeInTheDocument();
    // all 3 enabled by default
    expect(screen.getByText("3/3 enabled")).toBeInTheDocument();
    // no invoices yet → "no invoices yet" italic markers
    expect(screen.getAllByText("no invoices yet").length).toBe(3);
  });

  it("derives live fire/fail counts from invoice rule_results", async () => {
    vi.mocked(api.listRules).mockResolvedValue(catalogue);
    vi.mocked(api.listInvoices).mockResolvedValue([
      inv({
        id: "iA",
        rule_results: [
          { rule: "x", rule_id: "R1", passed: true, message: "" },
          { rule: "y", rule_id: "R2", passed: false, message: "" },
          // missing rule_id is skipped
          { rule: "z", passed: false, message: "" },
        ],
      }),
      inv({
        id: "iB",
        rule_results: [
          { rule: "x", rule_id: "R1", passed: true, message: "" },
        ],
      }),
    ]);
    renderPage(<RulesConfig />);

    // R1 fired twice, all passed
    expect(await screen.findByText("2 fired")).toBeInTheDocument();
    expect(screen.getByText("all passed")).toBeInTheDocument();
    // R2 fired once, one failure
    expect(screen.getByText("1 fired")).toBeInTheDocument();
    expect(screen.getByText("1 failed")).toBeInTheDocument();

    // Summary tiles: 2 invoices checked, 3 evaluations, 1 failure
    expect(screen.getByText("Invoices checked")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("Rule evaluations")).toBeInTheDocument();
    // Pass rate = (1 - 1/3) * 100 = 66.7%
    expect(screen.getByText("66.7%")).toBeInTheDocument();
  });

  it("toggles a rule off and updates the enabled count", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listRules).mockResolvedValue(catalogue);
    renderPage(<RulesConfig />);

    await screen.findByText("rate match");
    // The toggle buttons are the round switches — grab the first list item's button.
    const toggles = screen.getAllByRole("button");
    await user.click(toggles[0]);
    await waitFor(() => expect(screen.getByText("2/3 enabled")).toBeInTheDocument());
  });
});

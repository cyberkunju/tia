import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../src/api", () => ({
  api: {
    getContract: vi.fn(),
  },
}));

import { api } from "../../src/api";
import { ContractPanel } from "../../src/components/ContractPanel";
import type { ContractDetail } from "../../src/types";

function renderPanel(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const contract: ContractDetail = {
  id: "c1",
  client_code: "CL001",
  name: "Emirates Steel Industries LLC",
  type: "TIME_AND_MATERIALS",
  jurisdiction: "UAE",
  currency: "AED",
  vat_rate: 0.05,
  sac_code: "998519",
  markup_pct: 0.15,
  max_ot_pct: 0.2,
  payment_terms_days: 30,
  billing_cadence: "monthly",
  start_date: "2026-01-15",
  end_date: null,
  authorized_emp_count: 12,
  rate_cards: [
    { labor_category: "Welder", regular_rate: 55, ot_rate: 70, night_rate: 65, holiday_rate: 90 },
    { labor_category: "Fitter", regular_rate: 48, ot_rate: 60, night_rate: 55, holiday_rate: 80 },
  ],
  sows: [
    { deliverable: "Phase 1 fabrication", hours_expected: 100, hours_consumed: 100, status: "COMPLETED", completed_at: "2026-03-01" },
    { deliverable: "Phase 2 assembly", hours_expected: 200, hours_consumed: 40, status: "OPEN", completed_at: null },
  ],
};

beforeEach(() => vi.mocked(api.getContract).mockReset());
afterEach(() => vi.clearAllMocks());

describe("ContractPanel", () => {
  it("renders nothing when no clientCode is provided", () => {
    const { container } = renderPanel(<ContractPanel clientCode={null} />);
    expect(container).toBeEmptyDOMElement();
    expect(vi.mocked(api.getContract)).not.toHaveBeenCalled();
  });

  it("shows a skeleton while the contract loads", async () => {
    let resolve!: (v: ContractDetail | null) => void;
    vi.mocked(api.getContract).mockReturnValue(new Promise((r) => { resolve = r; }));
    const { container } = renderPanel(<ContractPanel clientCode="CL001" />);
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
    // settle the query so the pending promise never dangles
    resolve(null);
    await screen.findByText(/No active contract found/);
  });

  it("shows a graceful empty state when no contract is found", async () => {
    vi.mocked(api.getContract).mockResolvedValue(null);
    renderPanel(<ContractPanel clientCode="CL404" />);
    expect(await screen.findByText(/No active contract found for/)).toBeInTheDocument();
    expect(screen.getByText("CL404")).toBeInTheDocument();
  });

  it("renders the full contract detail on success", async () => {
    vi.mocked(api.getContract).mockResolvedValue(contract);
    renderPanel(<ContractPanel clientCode="CL001" />);

    expect(await screen.findByText("Emirates Steel Industries LLC")).toBeInTheDocument();
    expect(screen.getByText("UAE")).toBeInTheDocument();
    expect(screen.getByText("Time & Materials")).toBeInTheDocument();
    // KV block — computed percentages and terms
    expect(screen.getByText("20%")).toBeInTheDocument(); // max OT
    expect(screen.getByText("15%")).toBeInTheDocument(); // markup
    expect(screen.getByText("5%")).toBeInTheDocument(); // VAT
    expect(screen.getByText("Net 30d")).toBeInTheDocument();
    expect(screen.getByText("2026-01 → open")).toBeInTheDocument();
    expect(screen.getByText("12 emp")).toBeInTheDocument();
    expect(screen.getByText("998519")).toBeInTheDocument();
    // SOWs — completed one is struck through, open one is not
    expect(screen.getByText("Phase 1 fabrication")).toBeInTheDocument();
    expect(screen.getByText("Phase 2 assembly")).toBeInTheDocument();
    // rate card categories
    expect(screen.getByText("Welder")).toBeInTheDocument();
    expect(screen.getByText("Fitter")).toBeInTheDocument();
  });

  it("uses fallbacks for unknown jurisdiction/type and hides empty sections", async () => {
    vi.mocked(api.getContract).mockResolvedValue({
      ...contract,
      jurisdiction: "QA",
      type: "CUSTOM" as ContractDetail["type"],
      sac_code: null,
      rate_cards: [],
      sows: [],
    });
    renderPanel(<ContractPanel clientCode="CL001" />);

    expect(await screen.findByText("QA")).toBeInTheDocument();
    expect(screen.getByText("CUSTOM")).toBeInTheDocument();
    // no SOW / rate-card sections when both arrays are empty
    expect(screen.queryByText("Statements of Work")).not.toBeInTheDocument();
    expect(screen.queryByText(/Rate card/)).not.toBeInTheDocument();
    // SAC row is omitted when null
    expect(screen.queryByText("SAC")).not.toBeInTheDocument();
  });
});

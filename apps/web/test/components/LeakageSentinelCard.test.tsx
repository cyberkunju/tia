import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../src/api", () => ({
  api: {
    metricsLeakage: vi.fn(),
    recoverLeakage: vi.fn(),
  },
}));

import { api } from "../../src/api";
import { LeakageSentinelCard } from "../../src/components/LeakageSentinelCard";
import type { LeakageEntry, LeakageReport } from "../../src/types";

function renderCard(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const entry = (over: Partial<LeakageEntry> = {}): LeakageEntry => ({
  emp_id: "EMP10001",
  name: "Carlos Smith",
  client_code: "CL001",
  client_name: "Emirates Steel",
  reason: "no_timesheet",
  expected_billable_aed: 2436,
  actual_billed_aed: 0,
  days_paid: 20,
  days_billed: 0,
  ot_hours_paid: 0,
  ot_hours_billed: 0,
  last_billed_period: null,
  notes: null,
  ...over,
});

const report = (over: Partial<LeakageReport> = {}): LeakageReport => ({
  period: "June 2026",
  generated_at: "2026-07-01T00:00:00Z",
  total_aed: 48720,
  associate_count: 2,
  by_client: [
    { client_code: "CL001", client_name: "Emirates Steel", total_aed: 30000, entry_count: 1, by_reason: { no_timesheet: 20000, missing_overtime: 10000 } },
    { client_code: "CL002", client_name: "Dubai Cables", total_aed: 18720, entry_count: 1, by_reason: { rate_undercharge: 18720 } },
  ],
  entries: [entry(), entry({ emp_id: "EMP10002", name: "Ahmed Khan", reason: "missing_overtime", expected_billable_aed: 900 })],
  by_reason: { no_timesheet: 20000, missing_overtime: 10900, rate_undercharge: 18720 },
  baseline_mean_aed: 39000,
  baseline_stdev_aed: 5000,
  is_anomalous_period: true,
  baseline_delta_pct: 0.25,
  ...over,
});

beforeEach(() => {
  vi.mocked(api.metricsLeakage).mockReset();
  vi.mocked(api.recoverLeakage).mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("LeakageSentinelCard", () => {
  it("renders the panel title always", async () => {
    vi.mocked(api.metricsLeakage).mockResolvedValue(report());
    renderCard(<LeakageSentinelCard />);
    expect(screen.getByText("Revenue leakage sentinel")).toBeInTheDocument();
    await screen.findByText("AED 48,720.00");
  });

  it("shows a loading state while scanning", () => {
    vi.mocked(api.metricsLeakage).mockReturnValue(new Promise(() => {}));
    renderCard(<LeakageSentinelCard />);
    expect(screen.getByText(/Scanning payroll/)).toBeInTheDocument();
  });

  it("shows an error state when the report fails to load", async () => {
    vi.mocked(api.metricsLeakage).mockRejectedValue(new Error("boom"));
    renderCard(<LeakageSentinelCard />);
    expect(await screen.findByText(/Couldn't load leakage report/)).toBeInTheDocument();
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });

  it("shows the clean empty state when there is no leakage", async () => {
    vi.mocked(api.metricsLeakage).mockResolvedValue(report({ total_aed: 0, entries: [], by_client: [] }));
    renderCard(<LeakageSentinelCard />);
    expect(await screen.findByText("No leakage detected")).toBeInTheDocument();
  });

  it("renders the hero, baseline delta, per-client bars and detail rows", async () => {
    vi.mocked(api.metricsLeakage).mockResolvedValue(report());
    renderCard(<LeakageSentinelCard />);

    expect(await screen.findByText("AED 48,720.00")).toBeInTheDocument();
    expect(screen.getByText(/silently lost · 2 associates · June 2026/)).toBeInTheDocument();
    expect(screen.getByText(/\+25% vs trailing baseline/)).toBeInTheDocument();
    expect(screen.getByText("Emirates Steel")).toBeInTheDocument();
    expect(screen.getByText("Carlos Smith")).toBeInTheDocument();
    expect(screen.getByText("Ahmed Khan")).toBeInTheDocument();
    expect(screen.getByText("no timesheet")).toBeInTheDocument();
    expect(screen.getByText("missing OT")).toBeInTheDocument();
  });

  it("fires a recovery mutation with the right args and shows the result", async () => {
    const user = userEvent.setup();
    vi.mocked(api.metricsLeakage).mockResolvedValue(report());
    vi.mocked(api.recoverLeakage).mockResolvedValue({
      ok: true,
      invoice_id: "rec-1",
      invoice_sequence_no: "TIA-INV-2026-0099",
      amount_aed: 2436,
      status: "generated",
      client_code: "CL001",
      period: "June 2026",
    });
    renderCard(<LeakageSentinelCard />);

    await screen.findByText("Carlos Smith");
    await user.click(screen.getAllByRole("button", { name: /Recover/ })[0]);

    await waitFor(() =>
      expect(vi.mocked(api.recoverLeakage)).toHaveBeenCalledWith("EMP10001", "June 2026", "no_timesheet"),
    );
    expect(await screen.findByText("TIA-INV-2026-0099")).toBeInTheDocument();
    expect(screen.getByText(/Recovery invoice/)).toBeInTheDocument();
  });
});

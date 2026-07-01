import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../src/api", () => ({ api: { metricsLeakage: vi.fn(), recoverLeakage: vi.fn() } }));

import { api } from "../../src/api";
import { LeakageSentinelCard } from "../../src/components/LeakageSentinelCard";
import type { LeakageEntry, LeakageReport } from "../../src/types";

let qc: QueryClient;
function renderCard(node: ReactElement) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const entry = (over: Partial<LeakageEntry> = {}): LeakageEntry => ({
  emp_id: "EMP1", name: "A", client_code: "CL001", client_name: "Emirates Steel",
  reason: "no_timesheet", expected_billable_aed: 100, actual_billed_aed: 0,
  days_paid: 20, days_billed: 0, ot_hours_paid: 0, ot_hours_billed: 0,
  last_billed_period: null, notes: null, ...over,
});

const report = (over: Partial<LeakageReport> = {}): LeakageReport => ({
  period: "June 2026", generated_at: "2026-07-01T00:00:00Z", total_aed: 5000, associate_count: 2,
  by_client: [], entries: [entry()], by_reason: {}, baseline_mean_aed: 4000, baseline_stdev_aed: 500,
  is_anomalous_period: false, baseline_delta_pct: null, ...over,
});

beforeEach(() => {
  vi.mocked(api.metricsLeakage).mockReset();
  vi.mocked(api.recoverLeakage).mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("LeakageSentinelCard — remaining branches", () => {
  it("uses the 'June 2026' recovery fallback when neither data.period nor the prop is set", async () => {
    const user = userEvent.setup();
    vi.mocked(api.metricsLeakage).mockResolvedValue(report({ period: null as unknown as string }));
    vi.mocked(api.recoverLeakage).mockResolvedValue({ ok: true, invoice_id: "r", invoice_sequence_no: "INV-9", amount_aed: 100, status: "generated", client_code: "CL001", period: "June 2026" } as never);
    renderCard(<LeakageSentinelCard />);
    await user.click(await screen.findByRole("button", { name: /Recover/ }));
    await waitFor(() => expect(vi.mocked(api.recoverLeakage)).toHaveBeenCalledWith("EMP1", "June 2026", "no_timesheet"));
  });

  it("falls back to client_code when an entry has no client_name", async () => {
    vi.mocked(api.metricsLeakage).mockResolvedValue(report({ entries: [entry({ client_name: "", client_code: "CL777" })] }));
    renderCard(<LeakageSentinelCard />);
    expect(await screen.findByText(/CL777/)).toBeInTheDocument();
  });

  it("shows the per-row spinner while a recovery is pending", async () => {
    const user = userEvent.setup();
    vi.mocked(api.metricsLeakage).mockResolvedValue(report());
    vi.mocked(api.recoverLeakage).mockReturnValue(new Promise(() => {}) as never); // pending
    const { container } = renderCard(<LeakageSentinelCard />);
    await user.click(await screen.findByRole("button", { name: /Recover/ }));
    await waitFor(() => expect(container.querySelector(".animate-spin")).toBeInTheDocument());
  });

  it("shows the 'refreshing' indicator during a background refetch", async () => {
    let resolveSecond!: (v: LeakageReport) => void;
    vi.mocked(api.metricsLeakage)
      .mockResolvedValueOnce(report())
      .mockReturnValueOnce(new Promise<LeakageReport>((r) => { resolveSecond = r; }));
    renderCard(<LeakageSentinelCard />);
    await screen.findByText("AED 5,000.00");
    // trigger a refetch → isFetching true while previous data is kept (do not await; 2nd call never resolves)
    void qc.refetchQueries({ queryKey: ["metrics-leakage", "", ""] });
    expect(await screen.findByText("refreshing")).toBeInTheDocument();
    resolveSecond(report());
  });
});

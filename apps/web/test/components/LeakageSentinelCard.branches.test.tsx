import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LeakageEntry, LeakageReport } from "../../src/types";

vi.mock("../../src/api", () => ({
  api: { metricsLeakage: vi.fn(), recoverLeakage: vi.fn() },
}));

import { api } from "../../src/api";
import { LeakageSentinelCard } from "../../src/components/LeakageSentinelCard";

function renderCard(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const entry = (over: Partial<LeakageEntry> = {}): LeakageEntry => ({
  emp_id: "EMP1", name: "A", client_code: "CL001", client_name: "Emirates Steel",
  reason: "no_timesheet", expected_billable_aed: 100, actual_billed_aed: 0,
  days_paid: 20, days_billed: 0, ot_hours_paid: 0, ot_hours_billed: 0,
  last_billed_period: null, notes: null, ...over,
});

const base = (over: Partial<LeakageReport> = {}): LeakageReport => ({
  period: "June 2026", generated_at: "2026-07-01T00:00:00Z",
  total_aed: 5000, associate_count: 1,
  by_client: [], entries: [entry()],
  by_reason: {}, baseline_mean_aed: 4000, baseline_stdev_aed: 500,
  is_anomalous_period: false, baseline_delta_pct: null, ...over,
});

beforeEach(() => {
  vi.mocked(api.metricsLeakage).mockReset();
  vi.mocked(api.recoverLeakage).mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("LeakageSentinelCard — branch coverage", () => {
  it("omits the baseline delta chip when baseline_delta_pct is null", async () => {
    vi.mocked(api.metricsLeakage).mockResolvedValue(base({ baseline_delta_pct: null }));
    renderCard(<LeakageSentinelCard />);
    await screen.findByText("AED 5,000.00");
    expect(screen.queryByText(/vs trailing baseline/)).not.toBeInTheDocument();
    // singular "associate" (associate_count === 1) branch
    expect(screen.getByText(/1 associate ·/)).toBeInTheDocument();
  });

  it("renders a negative, non-anomalous delta with the neutral tone and no + prefix", async () => {
    vi.mocked(api.metricsLeakage).mockResolvedValue(
      base({ is_anomalous_period: false, baseline_delta_pct: -0.12 }),
    );
    const { container } = renderCard(<LeakageSentinelCard />);
    expect(await screen.findByText(/-12% vs trailing baseline/)).toBeInTheDocument();
    // neutral (non-anomalous) chip tone
    expect(container.querySelector(".bg-ink-50")).toBeInTheDocument();
  });

  it("colours every reason segment and falls back to client_code when the name is blank", async () => {
    vi.mocked(api.metricsLeakage).mockResolvedValue(
      base({
        by_client: [
          {
            client_code: "CL009", client_name: "", total_aed: 400, entry_count: 4,
            by_reason: { partial_timesheet: 100, late_period: 100, rate_undercharge: 100, missing_overtime: 100 },
          },
        ],
      }),
    );
    renderCard(<LeakageSentinelCard />);
    await screen.findByText("AED 5,000.00");
    // blank client_name → client_code shown in the per-client bar label
    expect(screen.getByText("CL009")).toBeInTheDocument();
  });

  it("shows the '+N more not shown' overflow when there are >10 unbilled associates", async () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      entry({ emp_id: `E${i}`, name: `Assoc ${i}` }),
    );
    vi.mocked(api.metricsLeakage).mockResolvedValue(base({ entries: many, associate_count: 13 }));
    renderCard(<LeakageSentinelCard />);
    expect(await screen.findByText("Top 10 unbilled associates")).toBeInTheDocument();
    expect(screen.getByText("+3 more not shown")).toBeInTheDocument();
  });
});

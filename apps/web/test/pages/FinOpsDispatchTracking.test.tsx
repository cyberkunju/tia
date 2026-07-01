import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../src/api", () => ({
  api: {
    dispatchTracking: vi.fn(),
    metricsStp: vi.fn(),
    resendInvoiceEmail: vi.fn(),
    listEvents: vi.fn(),
    clawbackEligibility: vi.fn(),
    clawback: vi.fn(),
  },
  API_BASE: "http://127.0.0.1:8000",
}));

import { api } from "../../src/api";
import { FinOpsDispatchTracking } from "../../src/pages/FinOpsDispatchTracking";
import type { DispatchTrackingRow, StpMetric } from "../../src/types";

function renderPage(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const stp: StpMetric = { total: 10, auto: 8, hitl: 1, escalate: 1, touchless_rate: 0.8, target: 0.9 };

const row = (over: Partial<DispatchTrackingRow> = {}): DispatchTrackingRow => ({
  id: "aaaa1111bbbb2222",
  invoice_sequence_no: "INV-2026-0001",
  client_code: "CL001",
  period: "2026-06",
  amount: 1000,
  total_incl_vat: 1050,
  status: "dispatched",
  client_approval_status: null,
  dispatch_idempotency_key: "k1",
  dispatch_attempted_at: "2026-06-01T10:00:00Z",
  confidence: 0.92,
  rule_results_failed: [],
  ...over,
});

beforeEach(() => {
  vi.mocked(api.metricsStp).mockReset().mockResolvedValue(stp);
  vi.mocked(api.dispatchTracking).mockReset();
  vi.mocked(api.resendInvoiceEmail).mockReset();
  vi.mocked(api.listEvents).mockReset().mockResolvedValue([]);
  vi.mocked(api.clawbackEligibility).mockReset().mockResolvedValue({
    current_state: "dispatched",
    action_when_clawed_back: "void",
    valid_reason_codes: ["DUPLICATE", "OTHER"],
    valid_adjustment_types: ["INTERNAL_WRITE_OFF"],
  });
});
afterEach(() => vi.clearAllMocks());

describe("FinOpsDispatchTracking page", () => {
  it("shows the loading skeleton then the empty state", async () => {
    vi.mocked(api.dispatchTracking).mockResolvedValue([]);
    renderPage(<FinOpsDispatchTracking />);
    expect(await screen.findByText("No invoices to track yet")).toBeInTheDocument();
    // KPI strip renders zeros
    expect(screen.getByText("Total tracked")).toBeInTheDocument();
  });

  it("renders the KPI strip and an AUTO row with confidence + dispatch age", async () => {
    vi.mocked(api.dispatchTracking).mockResolvedValue([row()]);
    renderPage(<FinOpsDispatchTracking />);

    expect(await screen.findByText("INV-2026-0001")).toBeInTheDocument();
    // Auto-dispatched (dispatched + no client approval) → AUTO chip
    expect(screen.getByText("AUTO")).toBeInTheDocument();
    // touchless rate from stp
    expect(screen.getByText("80.0%")).toBeInTheDocument();
    // confidence badge
    expect(screen.getByText("92.0%")).toBeInTheDocument();
    // client approval defaults to "pending"
    expect(screen.getByText("pending")).toBeInTheDocument();
  });

  it("resends the invoice email and shows the result line", async () => {
    const user = userEvent.setup();
    vi.mocked(api.dispatchTracking).mockResolvedValue([row()]);
    vi.mocked(api.resendInvoiceEmail).mockResolvedValue({ sent: true, to: "ops@x.com" });
    renderPage(<FinOpsDispatchTracking />);

    await user.click(await screen.findByRole("button", { name: /Resend email/ }));
    await waitFor(() => expect(vi.mocked(api.resendInvoiceEmail)).toHaveBeenCalledWith("aaaa1111bbbb2222"));
    expect(await screen.findByText(/sent → ops@x.com/)).toBeInTheDocument();
  });

  it("surfaces a failure message when resend reports not sent", async () => {
    const user = userEvent.setup();
    vi.mocked(api.dispatchTracking).mockResolvedValue([row()]);
    vi.mocked(api.resendInvoiceEmail).mockResolvedValue({ sent: false, reason: "no mailbox" });
    renderPage(<FinOpsDispatchTracking />);

    await user.click(await screen.findByRole("button", { name: /Resend email/ }));
    expect(await screen.findByText("no mailbox")).toBeInTheDocument();
  });

  it("shows the thrown error message when resend rejects", async () => {
    const user = userEvent.setup();
    vi.mocked(api.dispatchTracking).mockResolvedValue([row()]);
    vi.mocked(api.resendInvoiceEmail).mockRejectedValue(new Error("smtp down"));
    renderPage(<FinOpsDispatchTracking />);

    await user.click(await screen.findByRole("button", { name: /Resend email/ }));
    expect(await screen.findByText("smtp down")).toBeInTheDocument();
  });

  it("opens the touchless rationale modal from the Why? button", async () => {
    const user = userEvent.setup();
    vi.mocked(api.dispatchTracking).mockResolvedValue([row()]);
    renderPage(<FinOpsDispatchTracking />);

    await user.click(await screen.findByRole("button", { name: /Why\?/ }));
    expect(await screen.findByText("Why was this touchless?")).toBeInTheDocument();
  });

  it("opens the clawback modal for an eligible invoice", async () => {
    const user = userEvent.setup();
    vi.mocked(api.dispatchTracking).mockResolvedValue([row()]);
    renderPage(<FinOpsDispatchTracking />);

    await user.click(await screen.findByRole("button", { name: /Clawback/ }));
    await waitFor(() => expect(vi.mocked(api.clawbackEligibility)).toHaveBeenCalledWith("aaaa1111bbbb2222"));
  });

  it("renders a rejected approval badge and falls back to id slice without a sequence no", async () => {
    vi.mocked(api.dispatchTracking).mockResolvedValue([
      row({ invoice_sequence_no: null, status: "generated", client_approval_status: "rejected", dispatch_attempted_at: null }),
    ]);
    renderPage(<FinOpsDispatchTracking />);
    // id.slice(0,8)
    expect(await screen.findByText("aaaa1111")).toBeInTheDocument();
    expect(screen.getByText("rejected")).toBeInTheDocument();
    // no dispatch time → "-"
    expect(screen.getAllByText("-").length).toBeGreaterThan(0);
  });
});

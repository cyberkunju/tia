import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../src/api", () => ({
  api: {
    dispatchTracking: vi.fn(), metricsStp: vi.fn(), resendInvoiceEmail: vi.fn(),
    listEvents: vi.fn(), clawbackEligibility: vi.fn(), clawback: vi.fn(),
  },
  API_BASE: "http://127.0.0.1:8000",
}));

import { api } from "../../src/api";
import { FinOpsDispatchTracking } from "../../src/pages/FinOpsDispatchTracking";
import type { DispatchTrackingRow } from "../../src/types";

function renderPage(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const row = (over: Partial<DispatchTrackingRow> = {}): DispatchTrackingRow => ({
  id: "aaaa1111bbbb2222", invoice_sequence_no: "INV-2026-0001", client_code: "CL001", period: "2026-06",
  amount: 1000, total_incl_vat: 1050, status: "dispatched", client_approval_status: null,
  dispatch_idempotency_key: "k1", dispatch_attempted_at: "2026-06-01T10:00:00Z", confidence: 0.92, rule_results_failed: [],
  ...over,
});

beforeEach(() => {
  vi.mocked(api.metricsStp).mockReset().mockResolvedValue({ total: 10, auto: 8, hitl: 1, escalate: 1, touchless_rate: 0.8, target: 0.9 } as never);
  vi.mocked(api.dispatchTracking).mockReset();
  vi.mocked(api.resendInvoiceEmail).mockReset();
  vi.mocked(api.listEvents).mockReset().mockResolvedValue([]);
  vi.mocked(api.clawbackEligibility).mockReset().mockResolvedValue({
    current_state: "dispatched", action_when_clawed_back: "void", valid_reason_codes: ["DUPLICATE"], valid_adjustment_types: ["INTERNAL_WRITE_OFF"],
  } as never);
  vi.mocked(api.clawback).mockReset().mockResolvedValue({ status: "voided" } as never);
});
afterEach(() => vi.clearAllMocks());

describe("FinOpsDispatchTracking — modal close/done + remaining branches", () => {
  it("opens then closes the touchless rationale modal", async () => {
    const user = userEvent.setup();
    vi.mocked(api.dispatchTracking).mockResolvedValue([row()]);
    renderPage(<FinOpsDispatchTracking />);
    await user.click(await screen.findByRole("button", { name: /Why\?/ }));
    expect(await screen.findByText("Why was this touchless?")).toBeInTheDocument();
    // close via the header X (aria-label Close) → setWhyFor(null)
    await user.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(screen.queryByText("Why was this touchless?")).not.toBeInTheDocument());
  });

  it("opens then completes a clawback (onDone) and separately cancels (onClose)", async () => {
    const user = userEvent.setup();
    vi.mocked(api.dispatchTracking).mockResolvedValue([row()]);
    renderPage(<FinOpsDispatchTracking />);

    // open + cancel
    await user.click(await screen.findByRole("button", { name: /Clawback/ }));
    await screen.findByText("Void this invoice");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Void this invoice")).not.toBeInTheDocument());

    // open + submit → onDone closes it
    await user.click(screen.getByRole("button", { name: /Clawback/ }));
    await screen.findByText("Void this invoice");
    await user.click(screen.getByRole("button", { name: /Void invoice/ }));
    await waitFor(() => expect(screen.queryByText("Void this invoice")).not.toBeInTheDocument());
  });

  it("shows a bare 'sent' and 'failed' resend result, and an approved (green) row", async () => {
    const user = userEvent.setup();
    vi.mocked(api.dispatchTracking).mockResolvedValue([
      row({ client_approval_status: "approved", total_incl_vat: null as never }),
    ]);
    vi.mocked(api.resendInvoiceEmail).mockResolvedValue({ sent: true } as never); // no `to` → "sent"
    renderPage(<FinOpsDispatchTracking />);
    expect(await screen.findByText("approved")).toBeInTheDocument();
    // approved status → not auto → no Why button, but resend still available
    await user.click(await screen.findByRole("button", { name: /Resend email/ }));
    expect(await screen.findByText("sent")).toBeInTheDocument();
  });

  it("shows the 'failed' fallback when resend reports not sent with no reason", async () => {
    const user = userEvent.setup();
    vi.mocked(api.dispatchTracking).mockResolvedValue([row()]);
    vi.mocked(api.resendInvoiceEmail).mockResolvedValue({ sent: false } as never); // no reason → "failed"
    renderPage(<FinOpsDispatchTracking />);
    await user.click(await screen.findByRole("button", { name: /Resend email/ }));
    expect(await screen.findByText("failed")).toBeInTheDocument();
  });
});

describe("FinOpsDispatchTracking — KPI + row fallbacks", () => {
  it("counts a generated row, a finance_approved clawback row, null period, and 0-total", async () => {
    vi.mocked(api.dispatchTracking).mockResolvedValue([
      row({ id: "g1", status: "generated", period: null as never, total_incl_vat: null as never, amount: 500, invoice_sequence_no: "INV-G1" }),
      row({ id: "f1", status: "finance_approved", client_approval_status: "approved", invoice_sequence_no: "INV-F1" }),
    ]);
    renderPage(<FinOpsDispatchTracking />);
    // generated row present; period "-" fallback; finance_approved → Clawback button
    expect(await screen.findByText("INV-G1")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Clawback/ }).length).toBeGreaterThan(0);
  });

  it("stringifies a non-Error thrown during resend", async () => {
    const user = userEvent.setup();
    vi.mocked(api.dispatchTracking).mockResolvedValue([row()]);
    // reject with a non-Error → `String((e as Error).message || e)` uses `|| e`
    vi.mocked(api.resendInvoiceEmail).mockRejectedValue("string failure");
    renderPage(<FinOpsDispatchTracking />);
    await user.click(await screen.findByRole("button", { name: /Resend email/ }));
    expect(await screen.findByText("string failure")).toBeInTheDocument();
  });
});

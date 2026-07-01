import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Mock the API module the page depends on. Only financeQueue drives render;
// the mutation fns just need to exist.
vi.mock("../../src/api", () => ({
  api: {
    financeQueue: vi.fn(),
    financeApprove: vi.fn(),
    financeReject: vi.fn(),
  },
}));

import userEvent from "@testing-library/user-event";

import { api } from "../../src/api";
import { FinanceQueue } from "../../src/pages/FinanceQueue";
import type { FinanceQueueRow } from "../../src/types";

function renderPage(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const row = (over: Partial<FinanceQueueRow> = {}): FinanceQueueRow => ({
  id: "11112222-3333-4444",
  invoice_sequence_no: "INV-2026-0001",
  client_code: "CL001",
  client_name: "Emirates Steel",
  period: "2026-06",
  amount: 1000,
  total_incl_vat: 1050,
  currency: "AED",
  status: "generated",
  threshold: 500,
  rule_failures: [],
  ...over,
});

beforeEach(() => {
  vi.mocked(api.financeQueue).mockReset();
  vi.mocked(api.financeApprove).mockReset().mockResolvedValue({ status: "finance_approved", invoice_id: "11112222-3333-4444" });
  vi.mocked(api.financeReject).mockReset().mockResolvedValue({ status: "finance_rejected", invoice_id: "11112222-3333-4444", reason: "no" });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("FinanceQueue page", () => {
  it("shows the empty state and a 0-pending badge when the queue is clear", async () => {
    vi.mocked(api.financeQueue).mockResolvedValue([]);
    renderPage(<FinanceQueue />);

    expect(await screen.findByText("Approval queue is clear")).toBeInTheDocument();
    expect(screen.getByText("0 pending")).toBeInTheDocument();
  });

  it("renders a pending row with formatted totals and pending count", async () => {
    vi.mocked(api.financeQueue).mockResolvedValue([row({ rule_failures: [] })]);
    renderPage(<FinanceQueue />);

    expect(await screen.findByText("INV-2026-0001")).toBeInTheDocument();
    expect(screen.getByText("CL001")).toBeInTheDocument();
    expect(screen.getByText("Emirates Steel")).toBeInTheDocument();
    // total_incl_vat + threshold are rendered via fmtAED
    expect(screen.getByText("AED 1,050.00")).toBeInTheDocument();
    expect(screen.getByText("AED 500.00")).toBeInTheDocument();
    expect(screen.getByText("1 pending")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve/ })).toBeInTheDocument();
  });

  it("falls back to a truncated id when there is no invoice sequence number", async () => {
    vi.mocked(api.financeQueue).mockResolvedValue([row({ invoice_sequence_no: null })]);
    renderPage(<FinanceQueue />);
    // id.slice(0, 8) of "11112222-3333-4444"
    expect(await screen.findByText("11112222")).toBeInTheDocument();
  });

  it("shows a failed-rules badge when a row has rule exceptions", async () => {
    vi.mocked(api.financeQueue).mockResolvedValue([
      row({
        rule_failures: [
          { rule: "R1", passed: false, severity: "error", message: "x" },
          { rule: "R2", passed: false, severity: "error", message: "y" },
        ],
      }),
    ]);
    renderPage(<FinanceQueue />);
    expect(await screen.findByText("2 failed")).toBeInTheDocument();
  });

  it("falls back to amount when total_incl_vat is null", async () => {
    vi.mocked(api.financeQueue).mockResolvedValue([row({ total_incl_vat: null, amount: 777 })]);
    renderPage(<FinanceQueue />);
    await waitFor(() => expect(screen.getByText("AED 777.00")).toBeInTheDocument());
  });

  it("approves a row via the Approve button", async () => {
    const user = userEvent.setup();
    vi.mocked(api.financeQueue).mockResolvedValue([row()]);
    renderPage(<FinanceQueue />);
    await user.click(await screen.findByRole("button", { name: /Approve/ }));
    await waitFor(() => expect(vi.mocked(api.financeApprove)).toHaveBeenCalledWith("11112222-3333-4444"));
  });

  it("rejects a row only when a reason is supplied via prompt", async () => {
    const user = userEvent.setup();
    vi.mocked(api.financeQueue).mockResolvedValue([row()]);
    vi.stubGlobal("prompt", vi.fn().mockReturnValue("too high"));
    renderPage(<FinanceQueue />);
    await user.click(await screen.findByRole("button", { name: /Reject/ }));
    await waitFor(() => expect(vi.mocked(api.financeReject)).toHaveBeenCalledWith("11112222-3333-4444", "too high"));
    vi.unstubAllGlobals();
  });

  it("does not reject when the prompt is cancelled", async () => {
    const user = userEvent.setup();
    vi.mocked(api.financeQueue).mockResolvedValue([row()]);
    vi.stubGlobal("prompt", vi.fn().mockReturnValue(null));
    renderPage(<FinanceQueue />);
    await user.click(await screen.findByRole("button", { name: /Reject/ }));
    expect(vi.mocked(api.financeReject)).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

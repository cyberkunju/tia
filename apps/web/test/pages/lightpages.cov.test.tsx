import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../src/api", () => ({
  api: {
    financeQueue: vi.fn(), financeApprove: vi.fn(), financeReject: vi.fn(),
    evalSummary: vi.fn(), runEval: vi.fn(),
    listRules: vi.fn(), listInvoices: vi.fn(),
  },
}));

import { api } from "../../src/api";
import { FinanceQueue } from "../../src/pages/FinanceQueue";
import { FinOpsEval } from "../../src/pages/FinOpsEval";
import { RulesConfig } from "../../src/pages/RulesConfig";

function renderPage(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => vi.clearAllMocks());

describe("FinanceQueue", () => {
  beforeEach(() => {
    vi.mocked(api.financeApprove).mockReset().mockResolvedValue({ status: "finance_approved", invoice_id: "i1" } as never);
  });

  it("shows amber pending badge, rule-failure chip, and approves a row", async () => {
    const user = userEvent.setup();
    vi.mocked(api.financeQueue).mockResolvedValue([
      { id: "i1", invoice_sequence_no: null, client_code: "CL001", client_name: "Emirates Steel", period: "2026-06", amount: 90000, total_incl_vat: 94500, threshold: 60000, rule_failures: ["R1", "R2"] },
    ] as never);
    renderPage(<FinanceQueue />);
    expect(await screen.findByText("1 pending")).toBeInTheDocument();
    expect(screen.getByText("2 failed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Approve/ }));
    await waitFor(() => expect(vi.mocked(api.financeApprove)).toHaveBeenCalledWith("i1"));
  });

  it("shows the clear empty state (green badge) when the queue is empty", async () => {
    vi.mocked(api.financeQueue).mockResolvedValue([] as never);
    renderPage(<FinanceQueue />);
    expect(await screen.findByText("Approval queue is clear")).toBeInTheDocument();
    expect(screen.getByText("0 pending")).toBeInTheDocument();
  });
});

describe("FinOpsEval — all-pass state", () => {
  it("marks all cases green when passed === runnable", async () => {
    vi.mocked(api.evalSummary).mockResolvedValue({
      passed: 3, runnable: 3, ece: 0.012,
      macro_f1: { days_worked: 0.98, resolved: 0.97, emp_id: 0.95 },
      results: [
        { case: 1, input: "xlsx", channel: "upload", extracted_rows: 2, expected_rows: 2, invoice_amount: 1000, exceptions: 0, latency_s: 0.5, passed: true },
      ],
    } as never);
    renderPage(<FinOpsEval />);
    expect(await screen.findByText("all green")).toBeInTheDocument();
    expect(screen.getByText("#1")).toBeInTheDocument();
  });
});

describe("RulesConfig — rule_results present and absent", () => {
  it("aggregates fire/fail counts across invoices with and without rule_results", async () => {
    vi.mocked(api.listRules).mockResolvedValue({
      count: 2,
      rules: [
        { rule_id: "R1", function_name: "r1_rate_check", friendly_message: "Rate matches" },
        { rule_id: "R2", function_name: "r2_ot_cap", friendly_message: "OT within cap" },
      ],
      friendly_message_table: {},
    } as never);
    vi.mocked(api.listInvoices).mockResolvedValue([
      { id: "i1", rule_results: [{ rule_id: "R1", passed: true }, { rule_id: "R2", passed: false }] },
      { id: "i2" }, // no rule_results → `?? []`
    ] as never);
    renderPage(<RulesConfig />);
    expect(await screen.findByText(/enabled/)).toBeInTheDocument();
    expect(screen.getByText("Rule evaluations")).toBeInTheDocument();
    // R2 failed once
    expect(screen.getByText("1 failed")).toBeInTheDocument();
  });
});

describe("FinanceQueue / FinOpsEval — pending + fallbacks", () => {
  it("FinanceQueue: null period fallback and approve pending", async () => {
    const user = userEvent.setup();
    vi.mocked(api.financeQueue).mockResolvedValue([
      { id: "i1", invoice_sequence_no: "INV-1", client_code: "CL001", client_name: "Steel", period: null, amount: 90000, total_incl_vat: 94500, threshold: 60000, rule_failures: [] },
    ] as never);
    vi.mocked(api.financeApprove).mockReturnValue(new Promise(() => {}) as never); // pending
    renderPage(<FinanceQueue />);
    await screen.findByText("INV-1");
    const approve = screen.getByRole("button", { name: /Approve/ });
    await user.click(approve);
    await waitFor(() => expect(approve).toBeDisabled());
  });

  it("FinOpsEval: shows the running spinner while a run is in flight", async () => {
    const user = userEvent.setup();
    vi.mocked(api.evalSummary).mockResolvedValue({
      passed: 2, runnable: 3, ece: 0.02, macro_f1: { days_worked: 0.9 },
      results: [{ case: 1, input: "x", channel: "upload", extracted_rows: 1, expected_rows: 1, invoice_amount: 100, exceptions: 0, latency_s: 0.1, passed: true }],
    } as never);
    vi.mocked(api.runEval).mockReturnValue(new Promise(() => {}) as never); // pending
    renderPage(<FinOpsEval />);
    await user.click(await screen.findByRole("button", { name: /Run eval/ }));
    expect(await screen.findByText("Running…")).toBeInTheDocument();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../src/api", () => ({
  api: {
    evalSummary: vi.fn(),
    runEval: vi.fn(),
  },
}));

import { api } from "../../src/api";
import { FinOpsEval } from "../../src/pages/FinOpsEval";
import type { EvalRunResult } from "../../src/types";

function renderPage(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const result = (over: Partial<EvalRunResult> = {}): EvalRunResult => ({
  total_cases: 2,
  passed: 2,
  runnable: 2,
  ece: 0.0123,
  macro_f1: { days_worked: 0.98, resolved: 0.95, ot_hours: 0.9 },
  results: [
    {
      case: "1", input: "clean.xlsx", channel: "email", passed: true, f1: {},
      extracted_rows: 2, expected_rows: 2, matches: [], invoice_amount: 1000,
      client_code: "CL001", exceptions: 0, latency_s: 1.23, details: [],
    },
    {
      case: "2", input: "photo.jpg", channel: "whatsapp", passed: false, f1: {},
      extracted_rows: 1, expected_rows: 2, matches: [], invoice_amount: 500,
      client_code: "CL002", exceptions: 1, latency_s: 2.5, details: [],
    },
  ],
  ...over,
});

beforeEach(() => {
  vi.mocked(api.evalSummary).mockReset();
  vi.mocked(api.runEval).mockReset().mockResolvedValue(result());
});
afterEach(() => vi.clearAllMocks());

describe("FinOpsEval page", () => {
  it("shows skeleton cards while the summary loads", () => {
    vi.mocked(api.evalSummary).mockReturnValue(new Promise<EvalRunResult>(() => {}));
    const { container } = renderPage(<FinOpsEval />);
    // 4 placeholder cards render before data
    expect(container.querySelectorAll(".card.p-4").length).toBeGreaterThanOrEqual(4);
  });

  it("renders metrics, the all-green hint, per-field table and result rows", async () => {
    vi.mocked(api.evalSummary).mockResolvedValue(result());
    renderPage(<FinOpsEval />);

    expect(await screen.findByText("all green")).toBeInTheDocument();
    // ECE formatted to 3 dp
    expect(screen.getByText("0.012")).toBeInTheDocument();
    // per-field F1 metrics
    expect(screen.getByText("F1 · days worked")).toBeInTheDocument();
    expect(screen.getByText("0.98")).toBeInTheDocument();
    // result rows: pass + fail badges
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getByText("clean.xlsx")).toBeInTheDocument();
    expect(screen.getByText("Pass")).toBeInTheDocument();
    expect(screen.getByText("Fail")).toBeInTheDocument();
  });

  it("shows the attention-needed hint when not all cases pass", async () => {
    vi.mocked(api.evalSummary).mockResolvedValue(result({ passed: 1, runnable: 2 }));
    renderPage(<FinOpsEval />);
    expect(await screen.findByText("attention needed")).toBeInTheDocument();
  });

  it("falls back to '-' for missing macro F1 fields", async () => {
    vi.mocked(api.evalSummary).mockResolvedValue(result({ macro_f1: {} }));
    renderPage(<FinOpsEval />);
    // Both F1 · days worked and F1 · resolved metrics show "-"
    await screen.findByText("F1 · days worked");
    expect(screen.getAllByText("-").length).toBeGreaterThanOrEqual(2);
  });

  it("runs the eval on demand", async () => {
    const user = userEvent.setup();
    vi.mocked(api.evalSummary).mockResolvedValue(result());
    renderPage(<FinOpsEval />);

    await screen.findByText("all green");
    await user.click(screen.getByRole("button", { name: /Run eval/ }));
    await waitFor(() => expect(vi.mocked(api.runEval)).toHaveBeenCalledTimes(1));
  });
});

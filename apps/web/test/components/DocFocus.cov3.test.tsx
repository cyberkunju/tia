import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../src/api", () => ({
  api: {
    getDoc: vi.fn(), listEvents: vi.fn(), approve: vi.fn(), reject: vi.fn(), dispatchInvoice: vi.fn(),
    invoiceWhy: vi.fn(), qa: vi.fn(), sapB1Payload: vi.fn(), getContract: vi.fn(), listRules: vi.fn(),
    clawbackEligibility: vi.fn(), clawback: vi.fn(),
    docSourceUrl: (id: string) => `http://127.0.0.1:8000/documents/${id}/source`,
    consolidatedExcelUrl: (c: string, p: string) => `http://127.0.0.1:8000/consolidate/${c}/${p}.xlsx`,
    wpsSifUrl: (c: string, p: string) => `http://127.0.0.1:8000/payroll/sif/${c}/${p}.sif`,
  },
  API_BASE: "http://127.0.0.1:8000",
}));
vi.mock("../../src/components/EmlCard", () => ({ EmlCard: () => <div>eml</div> }));
vi.mock("../../src/components/TextCard", () => ({ TextCard: () => <div>text</div> }));
vi.mock("../../src/components/SpreadsheetCard", () => ({ SpreadsheetCard: () => <div>sheet-card</div> }));

import { api } from "../../src/api";
import { DocFocus } from "../../src/components/DocFocus";

function renderDoc(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}>{node}</QueryClientProvider></MemoryRouter>);
}

beforeEach(() => {
  vi.mocked(api.listEvents).mockReset().mockResolvedValue([]);
  vi.mocked(api.getContract).mockReset().mockResolvedValue(null as never);
  vi.mocked(api.listRules).mockReset().mockResolvedValue({ count: 0, rules: [], friendly_message_table: {} } as never);
  vi.mocked(api.sapB1Payload).mockReset().mockResolvedValue({ invoice_id: "i", invoice_sequence_no: "INV", payload: {} } as never);
  vi.mocked(api.qa).mockReset().mockResolvedValue({ answer: "OPENAI_API_KEY not configured", citations: [], model: "x" } as never);
  vi.mocked(api.reject).mockReset().mockResolvedValue({ timesheet_id: "ts1", status: "rejected" } as never);
  vi.mocked(api.approve).mockReset().mockResolvedValue({ timesheet_id: "ts1", status: "ok", invoice_id: "i", amount: 1 } as never);
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("DocFocus — source detection + review bar + candidate pick", () => {
  it("detects an octet-stream .xlsx source", async () => {
    vi.mocked(api.getDoc).mockResolvedValue({
      doc: { id: "D1", channel: "upload", mime: "application/octet-stream", filename: "sheet.xlsx", uploaded_at: "", uploaded_by: "client" },
      timesheet: { id: "ts1", client_code: "CL001", period: "2026-06", status: "invoice_generated", routing: "auto", confidence: 0.9, extraction: { rows: [] }, match_result: null, validations: [] },
      invoices: [],
    } as never);
    renderDoc(<DocFocus docId="D1" />);
    expect(await screen.findByText("sheet-card")).toBeInTheDocument();
  });

  it("shows the resolve prompt, keeps approve disabled, and records a candidate pick", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getDoc).mockResolvedValue({
      doc: { id: "D1", channel: "upload", mime: "text/plain", filename: "t.txt", uploaded_at: "", uploaded_by: "client" },
      timesheet: {
        id: "ts1", client_code: "CL001", period: "2026-06", status: "awaiting_review", routing: "hitl", confidence: 0.5,
        extraction: { rows: [{ employee_name: "Carlos" }] },
        match_result: { matches: [{ row_idx: 0, chosen_emp_id: null, confidence: 0.5, ambiguous: true, candidates: [
          { emp_id: "E1", full_name: "Carlos Smith", client_code: "CL001", score: 0.51 },
          { emp_id: "E2", full_name: "Carlos Silva", client_code: "CL001", score: 0.49 },
        ] }], cost_matrix: [[0.51, 0.49], [0.49, 0.51]], row_labels: ["Carlos"], candidate_labels: ["E1", "E2"] },
        validations: [],
      },
      invoices: [],
    } as never);
    renderDoc(<DocFocus docId="D1" />);
    expect(await screen.findByText(/Resolve 1 ambiguous row/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve & generate/ })).toBeDisabled();
    // pick a candidate → the chosen button gets the selected styling (line 298 cond#0)
    await user.click(screen.getByText(/E1 · Carlos Smith/));
    await waitFor(() => expect(screen.getByRole("button", { name: /Approve & generate/ })).not.toBeDisabled());
  });

  it("non-ambiguous review bar shows 'Approve to generate' and cancels a null-prompt reject", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("prompt", vi.fn(() => null)); // cancel → no reject
    vi.mocked(api.getDoc).mockResolvedValue({
      doc: { id: "D1", channel: "upload", mime: "text/plain", filename: "t.txt", uploaded_at: "", uploaded_by: "client" },
      timesheet: {
        id: "ts1", client_code: "CL001", period: "2026-06", status: "awaiting_review", routing: "hitl", confidence: 0.9,
        extraction: { rows: [{ employee_name: "X" }] },
        match_result: { matches: [{ row_idx: 0, chosen_emp_id: "E1", confidence: 0.9, ambiguous: false, candidates: [] }], cost_matrix: [[0.02]], row_labels: ["X"], candidate_labels: ["E1"] },
        validations: [],
      },
      invoices: [],
    } as never);
    renderDoc(<DocFocus docId="D1" />);
    expect(await screen.findByText("Approve to generate the invoice.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(vi.mocked(api.reject)).not.toHaveBeenCalled(); // prompt returned null
  });
});

describe("DocFocus — TouchlessRationale close + WhyDrawer null/plural", () => {
  const autoInvoiceDoc = {
    doc: { id: "D1", channel: "email", mime: "text/plain", filename: "t.txt", uploaded_at: "", uploaded_by: "client" },
    timesheet: { id: "ts1", client_code: "CL001", period: "2026-06", status: "invoice_generated", routing: "auto", confidence: 0.9, extraction: { rows: [] }, match_result: null, validations: [] },
    invoices: [{ id: "inv-1", status: "dispatched", client_approval_status: null, pdf_available: false, invoice_sequence_no: "INV-1", amount: 1000, client_code: "CL001", period: "2026-06", line_items: [] }],
  };

  it("opens and closes the touchless rationale modal", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getDoc).mockResolvedValue(autoInvoiceDoc as never);
    vi.mocked(api.listEvents).mockResolvedValue([
      { id: "e", kind: "invoice", entity_id: "inv-1", action: "auto_dispatched_within_tolerance", actor: "system", at: "2026-06-01T10:00:00Z", payload: { rules_passed: ["R1"] } },
    ] as never);
    renderDoc(<DocFocus docId="D1" />);
    await user.click(await screen.findByText(/AUTO · Why\?/));
    expect(await screen.findByText("Why was this touchless?")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(screen.queryByText("Why was this touchless?")).not.toBeInTheDocument());
  });

  it("WhyDrawer handles null confidence/validations and pluralises multiple failures", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getDoc).mockResolvedValue(autoInvoiceDoc as never);
    // null confidence + null validations → `?? 0` and `?? []`
    vi.mocked(api.invoiceWhy).mockResolvedValue({ confidence_calibrated: null, validations: null, match_result: null, events: [] } as never);
    const { unmount } = renderDoc(<DocFocus docId="D1" />);
    await user.click(await screen.findByRole("button", { name: "Why" }));
    expect(await screen.findByText(/a FinOps reviewer confirmed the matches/)).toBeInTheDocument();
    unmount();

    // 2 failing validations → "TIA found 2 items" (plural)
    vi.mocked(api.invoiceWhy).mockResolvedValue({
      confidence_calibrated: 0.7,
      validations: [{ passed: false, severity: "error", rule: "R1" }, { passed: false, severity: "error", rule: "R2" }],
      match_result: null, events: [],
    } as never);
    renderDoc(<DocFocus docId="D1" />);
    await user.click(await screen.findByRole("button", { name: "Why" }));
    expect(await screen.findByText(/TIA found 2 items/)).toBeInTheDocument();
  });
});

describe("DocFocus — pending spinners + plural resolve", () => {
  it("pluralises the resolve prompt for multiple ambiguous rows", async () => {
    vi.mocked(api.getDoc).mockResolvedValue({
      doc: { id: "D1", channel: "upload", mime: "text/plain", filename: "t.txt", uploaded_at: "", uploaded_by: "client" },
      timesheet: {
        id: "ts1", client_code: "CL001", period: "2026-06", status: "awaiting_review", routing: "hitl", confidence: 0.5,
        extraction: { rows: [{ employee_name: "A" }, { employee_name: "B" }] },
        match_result: {
          matches: [
            { row_idx: 0, chosen_emp_id: null, confidence: 0.5, ambiguous: true, candidates: [{ emp_id: "E1", full_name: "A One", client_code: "CL001", score: 0.5 }, { emp_id: "E2", full_name: "A Two", client_code: "CL001", score: 0.5 }] },
            { row_idx: 1, chosen_emp_id: null, confidence: 0.5, ambiguous: true, candidates: [{ emp_id: "E3", full_name: "B One", client_code: "CL001", score: 0.5 }, { emp_id: "E4", full_name: "B Two", client_code: "CL001", score: 0.5 }] },
          ],
          cost_matrix: [[0.5, 0.5], [0.5, 0.5]], row_labels: ["A", "B"], candidate_labels: ["E1", "E2"],
        },
        validations: [],
      },
      invoices: [],
    } as never);
    renderDoc(<DocFocus docId="D1" />);
    expect(await screen.findByText(/Resolve 2 ambiguous rows/)).toBeInTheDocument();
  });

  it("shows the Approving… spinner while approve is in flight", async () => {
    const user = userEvent.setup();
    vi.mocked(api.approve).mockReturnValue(new Promise(() => {}) as never); // pending
    vi.mocked(api.getDoc).mockResolvedValue({
      doc: { id: "D1", channel: "upload", mime: "text/plain", filename: "t.txt", uploaded_at: "", uploaded_by: "client" },
      timesheet: { id: "ts1", client_code: "CL001", period: "2026-06", status: "awaiting_review", routing: "hitl", confidence: 0.9, extraction: { rows: [{ employee_name: "X" }] }, match_result: { matches: [{ row_idx: 0, chosen_emp_id: "E1", ambiguous: false, candidates: [] }], cost_matrix: [[0.02]], row_labels: ["X"], candidate_labels: ["E1"] }, validations: [] },
      invoices: [],
    } as never);
    renderDoc(<DocFocus docId="D1" />);
    await user.click(await screen.findByRole("button", { name: /Approve & generate/ }));
    expect(await screen.findByText("Approving…")).toBeInTheDocument();
  });

  it("shows the dispatch spinner while dispatching a generated invoice", async () => {
    const user = userEvent.setup();
    vi.mocked(api.dispatchInvoice).mockReturnValue(new Promise(() => {}) as never); // pending
    vi.mocked(api.getDoc).mockResolvedValue({
      doc: { id: "D1", channel: "email", mime: "text/plain", filename: "t.txt", uploaded_at: "", uploaded_by: "client" },
      timesheet: { id: "ts1", client_code: "CL001", period: "2026-06", status: "invoice_generated", routing: "auto", confidence: 0.9, extraction: { rows: [] }, match_result: null, validations: [] },
      invoices: [{ id: "inv-g", status: "generated", client_approval_status: null, pdf_available: false, invoice_sequence_no: "INV-G", amount: 1000, client_code: "CL001", period: "2026-06", line_items: [] }],
    } as never);
    const { container } = renderDoc(<DocFocus docId="D1" />);
    await user.click(await screen.findByRole("button", { name: /Dispatch/ }));
    await waitFor(() => expect(container.querySelector(".animate-spin")).toBeInTheDocument());
  });
});

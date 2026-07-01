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
vi.mock("../../src/components/SpreadsheetCard", () => ({ SpreadsheetCard: () => <div>sheet</div> }));

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
  vi.mocked(api.clawback).mockReset().mockResolvedValue({ status: "voided" } as never);
  vi.mocked(api.clawbackEligibility).mockReset().mockResolvedValue({ current_state: "dispatched", action_when_clawed_back: "void", valid_reason_codes: ["DUPLICATE"], valid_adjustment_types: ["INTERNAL_WRITE_OFF"], explanation: "ok" } as never);
});
afterEach(() => vi.clearAllMocks());

const minimalDoc = {
  doc: { id: "D1", channel: "email", mime: "text/plain", filename: "", uploaded_at: "", uploaded_by: "client" },
  timesheet: {
    id: "ts1", client_code: null, period: null, status: "invoice_generated", routing: null, confidence: null,
    extraction: { rows: [{ employee_name: "X" }] }, match_result: null, validations: null,
  },
  invoices: [{
    id: "inv-fa", status: "finance_approved", client_approval_status: null, pdf_available: false,
    invoice_sequence_no: null, amount: 1000, voided_at: "2026-06-05T10:00:00Z",
    client_code: "CL001", period: "2026-06", line_items: [],
  }],
};

describe("DocFocus — fallbacks + modal lifecycle", () => {
  it("renders a sparse doc with client/period/validation/voided fallbacks", async () => {
    vi.mocked(api.getDoc).mockResolvedValue(minimalDoc as never);
    renderDoc(<DocFocus docId="D1" />);
    expect(await screen.findByText("Client unknown")).toBeInTheDocument();
    expect(screen.getByText("period unknown")).toBeInTheDocument();
    // finance_approved invoice → Clawback available; voided_at without voided_by → "system"
    expect(screen.getByText(/Voided by system/)).toBeInTheDocument();
  });

  it("opens and closes/completes the clawback modal from an invoice", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getDoc).mockResolvedValue(minimalDoc as never);
    renderDoc(<DocFocus docId="D1" />);
    await user.click(await screen.findByRole("button", { name: /Clawback/ }));
    await screen.findByText("Void this invoice");
    // cancel → onClose
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Void this invoice")).not.toBeInTheDocument());
    // reopen + submit → onDone (setClawbackFor(null) + refetch)
    await user.click(screen.getByRole("button", { name: /Clawback/ }));
    await screen.findByText("Void this invoice");
    await user.click(screen.getByRole("button", { name: /Void invoice/ }));
    await waitFor(() => expect(screen.queryByText("Void this invoice")).not.toBeInTheDocument());
  });

  it("opens and closes the Why drawer", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getDoc).mockResolvedValue(minimalDoc as never);
    vi.mocked(api.invoiceWhy).mockResolvedValue({ confidence_calibrated: 0.7, validations: [], match_result: null, events: [] } as never);
    renderDoc(<DocFocus docId="D1" />);
    await user.click(await screen.findByRole("button", { name: "Why" }));
    expect(await screen.findByText("Why this invoice?")).toBeInTheDocument();
    // deterministic: fails 0, conf 0.7 → "FinOps reviewer confirmed"
    expect(await screen.findByText(/a FinOps reviewer confirmed the matches/)).toBeInTheDocument();
    // close via the drawer's ghost X button
    const closeBtns = screen.getAllByRole("button");
    await user.click(closeBtns.find((b) => b.querySelector(".lucide-x") && b.className.includes("btn-ghost"))!);
    await waitFor(() => expect(screen.queryByText("Why this invoice?")).not.toBeInTheDocument());
  });
});

describe("DocFocus — WhyDrawer deterministic variants", () => {
  const docWith = () => ({
    doc: { id: "D1", channel: "email", mime: "text/plain", filename: "t.txt", uploaded_at: "", uploaded_by: "client" },
    timesheet: { id: "ts1", client_code: "CL001", period: "2026-06", status: "invoice_generated", routing: "auto", confidence: 0.9, extraction: { rows: [] }, match_result: null, validations: [] },
    invoices: [{ id: "inv-1", status: "dispatched", client_approval_status: null, pdf_available: false, invoice_sequence_no: "INV-1", amount: 1000, client_code: "CL001", period: "2026-06", line_items: [] }],
  });

  it("null why → generic pipeline explanation", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getDoc).mockResolvedValue(docWith() as never);
    vi.mocked(api.invoiceWhy).mockResolvedValue(null as never);
    renderDoc(<DocFocus docId="D1" />);
    await user.click(await screen.findByRole("button", { name: "Why" }));
    expect(await screen.findByText(/TIA processed this invoice through the standard pipeline/)).toBeInTheDocument();
  });

  it("failing validations → 'TIA found N items' explanation, amber confidence, unknown action + null actor", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getDoc).mockResolvedValue(docWith() as never);
    vi.mocked(api.invoiceWhy).mockResolvedValue({
      confidence_calibrated: 0.7,
      validations: [{ passed: false, severity: "error", rule: "R2" }],
      match_result: null,
      events: [{ id: "e1", action: "some_unknown_action", actor: null, at: "2026-06-01T10:00:00Z" }],
    } as never);
    renderDoc(<DocFocus docId="D1" />);
    await user.click(await screen.findByRole("button", { name: "Why" }));
    expect(await screen.findByText(/TIA found 1 item/)).toBeInTheDocument();
    // humaniseAction fallback for the unknown action
    expect(screen.getByText(/some unknown action/)).toBeInTheDocument();
  });

  it("no invoice → WhyDrawer shows 'No invoice yet'", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getDoc).mockResolvedValue({
      doc: { id: "D1", channel: "email", mime: "text/plain", filename: "t.txt", uploaded_at: "", uploaded_by: "client" },
      timesheet: { id: "ts1", client_code: "CL001", period: "2026-06", status: "invoice_generated", routing: "auto", confidence: 0.9, extraction: { rows: [] }, match_result: null, validations: [] },
      invoices: [],
    } as never);
    renderDoc(<DocFocus docId="D1" />);
    await user.click(await screen.findByRole("button", { name: "Why" }));
    expect(await screen.findByText(/No invoice yet - approve to generate/)).toBeInTheDocument();
  });
});

describe("DocFocus — CostMatrix variants", () => {
  const ambiguousDoc = (cost: number[][], rowLabels: string[], colLabels: string[]) => ({
    doc: { id: "D1", channel: "upload", mime: "text/plain", filename: "t.txt", uploaded_at: "", uploaded_by: "client" },
    timesheet: {
      id: "ts1", client_code: "CL001", period: "2026-06", status: "awaiting_review", routing: "hitl", confidence: 0.5,
      extraction: { rows: [{ employee_name: "X" }] },
      match_result: { matches: [{ row_idx: 0, chosen_emp_id: null, confidence: 0.5, ambiguous: true, candidates: [] }], cost_matrix: cost, row_labels: rowLabels, candidate_labels: colLabels },
      validations: [],
    },
    invoices: [],
  });

  it("renders 'no candidates' when the cost matrix is empty", async () => {
    vi.mocked(api.getDoc).mockResolvedValue(ambiguousDoc([], [], []) as never);
    renderDoc(<DocFocus docId="D1" />);
    expect(await screen.findByText("no candidates")).toBeInTheDocument();
  });

  it("renders a single non-exact match chip", async () => {
    vi.mocked(api.getDoc).mockResolvedValue(ambiguousDoc([[0.5]], ["Carlos"], ["E1"]) as never);
    renderDoc(<DocFocus docId="D1" />);
    expect(await screen.findByText("Single-candidate match")).toBeInTheDocument();
  });
});

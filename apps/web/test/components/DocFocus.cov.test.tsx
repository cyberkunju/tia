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
  return render(
    <MemoryRouter initialEntries={["/console?doc=D1"]}>
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const baseTs = {
  id: "ts1", client_code: "CL001", period: "2026-06", status: "invoice_generated", routing: "auto", confidence: 0.95,
  hitl_reason: null,
  extraction: { rows: [{ employee_name: "Carlos", days_worked: 20, hours: 160, ot_hours: 2, leave_codes: ["AL"] }] },
  match_result: { matches: [{ row_idx: 0, chosen_emp_id: "E1", confidence: 0.9, ambiguous: false, candidates: [] }], cost_matrix: [[0.02]], row_labels: ["Carlos"], candidate_labels: ["E1"] },
  validations: [{ passed: true, rule: "R1", severity: "error" }],
};

beforeEach(() => {
  vi.mocked(api.listEvents).mockReset().mockResolvedValue([
    { id: "e1", kind: "invoice", entity_id: "inv-1", action: "generated", actor: "system", at: "2026-06-01T10:00:00Z", payload: {} },
  ] as never);
  vi.mocked(api.getContract).mockReset().mockResolvedValue(null as never);
  vi.mocked(api.listRules).mockReset().mockResolvedValue({ count: 0, rules: [], friendly_message_table: {} } as never);
  vi.mocked(api.sapB1Payload).mockReset().mockResolvedValue({ invoice_id: "inv-1", invoice_sequence_no: "INV-1", payload: {} } as never);
  vi.mocked(api.invoiceWhy).mockReset().mockResolvedValue({ confidence_calibrated: 0.95, validations: [], match_result: null, events: [] } as never);
  vi.mocked(api.qa).mockReset().mockResolvedValue({ answer: "OPENAI_API_KEY not configured", citations: [], model: "x" } as never);
  vi.mocked(api.approve).mockReset().mockResolvedValue({ timesheet_id: "ts1", status: "invoice_generated", invoice_id: "inv-1", amount: 1000 } as never);
  vi.mocked(api.reject).mockReset().mockResolvedValue({ timesheet_id: "ts1", status: "rejected" } as never);
  vi.mocked(api.dispatchInvoice).mockReset().mockResolvedValue({ status: "dispatched", idempotency_key: "k" } as never);
  vi.mocked(api.clawbackEligibility).mockReset().mockResolvedValue({ current_state: "generated", action_when_clawed_back: "void", valid_reason_codes: ["DUPLICATE"], valid_adjustment_types: ["INTERNAL_WRITE_OFF"] } as never);
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("DocFocus — full invoice block", () => {
  it("renders dispatched (auto) + generated invoices with breadcrumbs and exports", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getDoc).mockResolvedValue({
      doc: { id: "D1", channel: "email", mime: "text/plain", filename: "t.txt", uploaded_at: "", uploaded_by: "client" },
      timesheet: baseTs,
      invoices: [
        {
          id: "inv-1", status: "dispatched", client_approval_status: null, pdf_available: true,
          invoice_sequence_no: "INV-1", sac_code: "998515", customer_trn: "100999", due_date: "2026-07-01",
          amount: 1000, total_incl_vat: 1050, vat_amount: 50, total_excl_vat: 1000, vat_rate: 0.05, supplier_trn: "100312345600003",
          voided_at: "2026-06-05T10:00:00Z", voided_by: "finops", voided_reason_code: "DUPLICATE",
          credit_note_sequence_no: "CN-1", credit_note_amount: 1050, credit_note_article_refs: ["Art. 60"],
          client_code: "CL001", period: "2026-06", line_items: [],
        },
        {
          id: "inv-2", status: "generated", client_approval_status: null, pdf_available: false,
          invoice_sequence_no: null, amount: 2000, total_incl_vat: 2100, client_code: "CL001", period: "2026-06", line_items: [],
        },
      ],
    } as never);

    renderDoc(<DocFocus docId="D1" />);
    // dispatched auto → "AUTO · Why?" chip
    expect(await screen.findByText(/AUTO · Why\?/)).toBeInTheDocument();
    // voided + credit-note breadcrumbs
    expect(screen.getByText(/Voided by finops/)).toBeInTheDocument();
    expect(screen.getByText(/CN-1/)).toBeInTheDocument();
    // exports row
    expect(screen.getByText("SAP Excel")).toBeInTheDocument();
    expect(screen.getByText("WPS SIF")).toBeInTheDocument();

    // dispatch the generated invoice
    await user.click(screen.getByRole("button", { name: /Dispatch/ }));
    await waitFor(() => expect(vi.mocked(api.dispatchInvoice)).toHaveBeenCalledWith("inv-2"));

    // open touchless rationale from the AUTO chip
    await user.click(screen.getByText(/AUTO · Why\?/));
    expect(await screen.findByText("Why was this touchless?")).toBeInTheDocument();
  });

  it("opens the Why drawer with a deterministic explanation when the agent is unavailable", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getDoc).mockResolvedValue({
      doc: { id: "D1", channel: "email", mime: "text/plain", filename: "t.txt", uploaded_at: "", uploaded_by: "client" },
      timesheet: baseTs,
      invoices: [{ id: "inv-1", status: "dispatched", client_approval_status: null, pdf_available: false, invoice_sequence_no: "INV-1", amount: 1000, total_incl_vat: 1050, client_code: "CL001", period: "2026-06", line_items: [] }],
    } as never);
    vi.mocked(api.invoiceWhy).mockResolvedValue({ confidence_calibrated: 0.95, validations: [], match_result: { cost_matrix: [[0.1, 0.9], [0.9, 0.1]], row_labels: ["A", "B"], candidate_labels: ["X", "Y"] }, events: [{ id: "e1", action: "generated", actor: "system", at: "2026-06-01T10:00:00Z" }] } as never);

    renderDoc(<DocFocus docId="D1" />);
    await user.click(await screen.findByRole("button", { name: "Why" }));
    expect(await screen.findByText("Why this invoice?")).toBeInTheDocument();
    // deterministic explanation (all clean, high confidence)
    expect(await screen.findByText(/without a human in the loop/)).toBeInTheDocument();
  });

  it("renders an ambiguous row with a Hungarian cost matrix and resolves the pick", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getDoc).mockResolvedValue({
      doc: { id: "D1", channel: "upload", mime: "text/plain", filename: "t.txt", uploaded_at: "", uploaded_by: "client" },
      timesheet: {
        ...baseTs,
        status: "awaiting_review",
        match_result: {
          matches: [{ row_idx: 0, chosen_emp_id: null, confidence: 0.5, ambiguous: true, candidates: [
            { emp_id: "E1", full_name: "Carlos Smith", client_code: "CL001", score: 0.51 },
            { emp_id: "E2", full_name: "Carlos Silva", client_code: "CL001", score: 0.49 },
          ] }],
          cost_matrix: [[0.51, 0.49], [0.49, 0.51]], row_labels: ["Carlos"], candidate_labels: ["E1", "E2"],
        },
      },
      invoices: [],
    } as never);

    renderDoc(<DocFocus docId="D1" />);
    expect(await screen.findByText(/Hungarian assignment/)).toBeInTheDocument();
    // resolve the ambiguous row by picking a candidate
    await user.click(screen.getByText(/E1 · Carlos Smith/));
    // approve now enabled
    await user.click(screen.getByRole("button", { name: /Approve & generate/ }));
    await waitFor(() => expect(vi.mocked(api.approve)).toHaveBeenCalled());
  });

  it("rejects an awaiting-review timesheet via the prompt", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("prompt", vi.fn(() => "bad data"));
    vi.mocked(api.getDoc).mockResolvedValue({
      doc: { id: "D1", channel: "upload", mime: "text/plain", filename: "t.txt", uploaded_at: "", uploaded_by: "client" },
      timesheet: { ...baseTs, status: "awaiting_review" },
      invoices: [],
    } as never);
    renderDoc(<DocFocus docId="D1" />);
    await user.click(await screen.findByRole("button", { name: "Reject" }));
    await waitFor(() => expect(vi.mocked(api.reject)).toHaveBeenCalledWith("ts1", "bad data"));
  });

  it("shows the unavailable state when the document has no timesheet", async () => {
    vi.mocked(api.getDoc).mockResolvedValue({
      doc: { id: "D1", channel: "upload", mime: "text/plain", filename: "t.txt", uploaded_at: "", uploaded_by: "client" },
      timesheet: null, invoices: [],
    } as never);
    renderDoc(<DocFocus docId="D1" />);
    expect(await screen.findByText("Document unavailable")).toBeInTheDocument();
  });
});

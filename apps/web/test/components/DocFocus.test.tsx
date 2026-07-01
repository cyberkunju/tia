import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../src/api", () => ({
  api: {
    getDoc: vi.fn(),
    listEvents: vi.fn(),
    invoiceWhy: vi.fn(),
    qa: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    dispatchInvoice: vi.fn(),
    getContract: vi.fn(),
    sapB1Payload: vi.fn(),
    clawbackEligibility: vi.fn(),
    clawback: vi.fn(),
    docSourceUrl: () => "data:text/plain,src",
    consolidatedExcelUrl: (c: string, p: string) => `http://127.0.0.1:8000/consolidate/${c}/${p}.xlsx`,
    wpsSifUrl: (c: string, p: string) => `http://127.0.0.1:8000/payroll/sif/${c}/${p}.sif`,
  },
  API_BASE: "http://127.0.0.1:8000",
}));

import { api } from "../../src/api";
import { DocFocus } from "../../src/components/DocFocus";
import type { Invoice, Timesheet } from "../../src/types";

function renderNode(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const baseTs = (over: Partial<Timesheet> = {}): Timesheet => ({
  id: "ts-1",
  doc_id: "d-1",
  client_code: "CL001",
  period: "2026-06",
  status: "validated",
  routing: "auto",
  confidence: 0.92,
  hitl_reason: null,
  extraction: {
    rows: [
      { employee_name: "Carlos Smith", days_worked: 20, ot_hours: 2, leave_codes: [], reimbursements: [] },
    ],
    confidence_per_field: {},
  },
  match_result: { matches: [], cost_matrix: [], candidate_labels: [], row_labels: [] },
  validations: [],
  resolved_rows: [],
  ...over,
});

const doc = (over: Record<string, unknown> = {}) => ({
  id: "d-1", channel: "email", mime: "text/plain", filename: "ts.txt",
  uploaded_at: "2026-06-01T10:00:00Z", uploaded_by: "client", ...over,
});

const inv = (over: Partial<Invoice> = {}): Invoice => ({
  id: "inv-1", timesheet_id: "ts-1", client_code: "CL001", period: "2026-06",
  amount: 1000, currency: "AED", status: "generated", line_items: [],
  pdf_available: true, dispatched_at: null, invoice_sequence_no: "INV-2026-0001",
  total_excl_vat: 1000, vat_amount: 50, total_incl_vat: 1050, sac_code: "998515", ...over,
});

beforeEach(() => {
  // Source cards (TextCard/EmlCard/SpreadsheetCard) fetch the raw source URL.
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "text/plain" },
    text: async () => "raw timesheet text",
    json: async () => ({}),
    arrayBuffer: async () => new ArrayBuffer(0),
  })));
  vi.mocked(api.listEvents).mockReset().mockResolvedValue([]);
  vi.mocked(api.getContract).mockReset().mockResolvedValue(null);
  vi.mocked(api.sapB1Payload).mockReset().mockResolvedValue({
    invoice_id: "inv-1", invoice_sequence_no: "INV-2026-0001",
    endpoint: "/Invoices", payload: {} as never,
  });
  vi.mocked(api.approve).mockReset().mockResolvedValue({ timesheet_id: "ts-1", status: "approved", invoice_id: "inv-1", amount: 1050 });
  vi.mocked(api.reject).mockReset().mockResolvedValue({ timesheet_id: "ts-1", status: "rejected" });
  vi.mocked(api.dispatchInvoice).mockReset().mockResolvedValue({ status: "dispatched", idempotency_key: "k" });
  vi.mocked(api.invoiceWhy).mockReset();
  vi.mocked(api.qa).mockReset();
  vi.mocked(api.getDoc).mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("DocFocus", () => {
  it("shows the loading state", () => {
    vi.mocked(api.getDoc).mockReturnValue(new Promise(() => {}));
    renderNode(<DocFocus docId="d-1" />);
    expect(screen.getByText("Loading document…")).toBeInTheDocument();
  });

  it("shows the unavailable state when there is no timesheet", async () => {
    vi.mocked(api.getDoc).mockResolvedValue({ doc: doc(), timesheet: null, invoices: [] } as never);
    renderNode(<DocFocus docId="d-1" />);
    expect(await screen.findByText("Document unavailable")).toBeInTheDocument();
  });

  it("renders header, extracted rows and an invoice card with totals + FSM + exports", async () => {
    vi.mocked(api.getDoc).mockResolvedValue({ doc: doc(), timesheet: baseTs(), invoices: [inv()] } as never);
    renderNode(<DocFocus docId="d-1" />);

    expect(await screen.findByText("CL001")).toBeInTheDocument();
    expect(screen.getByText("Carlos Smith")).toBeInTheDocument();
    // Invoice card
    expect(screen.getByText(/Tax invoice · INV-2026-0001/)).toBeInTheDocument();
    expect(screen.getByText("AED 1,050.00")).toBeInTheDocument();
    // PDF link + SAC row
    expect(screen.getByRole("link", { name: /PDF/ })).toHaveAttribute("href", "http://127.0.0.1:8000/invoices/inv-1/pdf");
    expect(screen.getByText(/SAC\/HSN 998515/)).toBeInTheDocument();
    // ERP exports
    expect(screen.getByRole("link", { name: /SAP Excel/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /WPS SIF/ })).toBeInTheDocument();
  });

  it("dispatches a generated invoice", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getDoc).mockResolvedValue({ doc: doc(), timesheet: baseTs(), invoices: [inv({ status: "generated" })] } as never);
    renderNode(<DocFocus docId="d-1" />);

    await user.click(await screen.findByRole("button", { name: /Dispatch/ }));
    await waitFor(() => expect(vi.mocked(api.dispatchInvoice)).toHaveBeenCalledWith("inv-1"));
  });

  it("resolves an ambiguous row then approves; cost matrix is shown", async () => {
    const user = userEvent.setup();
    const ts = baseTs({
      status: "awaiting_review",
      match_result: {
        matches: [
          {
            row_idx: 0, chosen_emp_id: null, ambiguous: true, confidence: 0.5, reason: "tie",
            candidates: [
              { emp_id: "E1", full_name: "Carlos Smith", client_code: "CL001", score: 0.51, signals: {} },
              { emp_id: "E2", full_name: "Carlos Smyth", client_code: "CL001", score: 0.49, signals: {} },
            ],
          },
        ],
        cost_matrix: [[0.51, 0.49]],
        candidate_labels: ["E1", "E2"],
        row_labels: ["Carlos Smith"],
      },
    });
    vi.mocked(api.getDoc).mockResolvedValue({ doc: doc(), timesheet: ts, invoices: [] } as never);
    renderNode(<DocFocus docId="d-1" />);

    expect(await screen.findByText(/Hungarian assignment/)).toBeInTheDocument();
    const approveBtn = screen.getByRole("button", { name: /Approve & generate/ });
    expect(approveBtn).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /E1 · Carlos Smith/ }));
    await waitFor(() => expect(approveBtn).toBeEnabled());
    await user.click(approveBtn);
    await waitFor(() => expect(vi.mocked(api.approve)).toHaveBeenCalledWith("ts-1", [{ row_idx: 0, chosen_emp_id: "E1" }]));
  });

  it("rejects a timesheet via the prompt", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("prompt", vi.fn().mockReturnValue("bad data"));
    vi.mocked(api.getDoc).mockResolvedValue({
      doc: doc(),
      timesheet: baseTs({ status: "awaiting_review", match_result: { matches: [{ row_idx: 0, chosen_emp_id: "E1", ambiguous: false, confidence: 0.9, reason: "ok", candidates: [] }], cost_matrix: [], candidate_labels: [], row_labels: [] } }),
      invoices: [],
    } as never);
    renderNode(<DocFocus docId="d-1" />);

    await user.click(await screen.findByRole("button", { name: "Reject" }));
    await waitFor(() => expect(vi.mocked(api.reject)).toHaveBeenCalledWith("ts-1", "bad data"));
  });

  it("opens the Why drawer and renders the LLM rationale + audit steps", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getDoc).mockResolvedValue({ doc: doc(), timesheet: baseTs(), invoices: [inv()] } as never);
    vi.mocked(api.invoiceWhy).mockResolvedValue({
      invoice: inv(), extraction: null, match_result: null, validations: [],
      confidence_calibrated: 0.95, routing: "auto",
      events: [{ id: "e1", at: "2026-06-01T10:00:00Z", actor: "system", kind: "invoice", entity_id: "inv-1", action: "generated", payload: {}, idempotency_key: null }],
    });
    vi.mocked(api.qa).mockResolvedValue({ answer: "This invoice was generated cleanly.", citations: [], tool_calls: [], model: "gpt-x" });
    renderNode(<DocFocus docId="d-1" />);

    await user.click(await screen.findByRole("button", { name: /Why/ }));
    expect(await screen.findByText("Why this invoice?")).toBeInTheDocument();
    expect(await screen.findByText("This invoice was generated cleanly.")).toBeInTheDocument();
    expect(screen.getByText(/What TIA did, step by step/)).toBeInTheDocument();
  });

  it("opens the touchless rationale for an auto-dispatched invoice", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getDoc).mockResolvedValue({
      doc: doc(), timesheet: baseTs(), invoices: [inv({ status: "dispatched", client_approval_status: null })],
    } as never);
    renderNode(<DocFocus docId="d-1" />);
    await user.click(await screen.findByRole("button", { name: /AUTO · Why\?/ }));
    expect(await screen.findByText("Why was this touchless?")).toBeInTheDocument();
  });

  it("shows an audit timeline when events exist and a voided/credit-note breadcrumb", async () => {
    vi.mocked(api.listEvents).mockResolvedValue([
      { id: "e1", at: "2026-06-01T10:00:00Z", actor: "system", kind: "invoice", entity_id: "inv-1", action: "generated", payload: {}, idempotency_key: null },
    ]);
    vi.mocked(api.getDoc).mockResolvedValue({
      doc: doc(),
      timesheet: baseTs(),
      invoices: [inv({ status: "dispatched", voided_at: "2026-06-02T00:00:00Z", voided_by: "finops", voided_reason_code: "DUPLICATE", credit_note_sequence_no: "CN-1", credit_note_amount: 1050, credit_note_article_refs: ["Art.60"] })],
    } as never);
    renderNode(<DocFocus docId="d-1" />);

    expect(await screen.findByText("Audit timeline")).toBeInTheDocument();
    expect(screen.getByText(/Voided by finops/)).toBeInTheDocument();
    expect(screen.getByText(/Tax Credit Note/)).toBeInTheDocument();
  });

  it("renders validations via PlainEnglishStatus and a hitl reason", async () => {
    vi.mocked(api.getDoc).mockResolvedValue({
      doc: doc(),
      timesheet: baseTs({
        status: "awaiting_review",
        hitl_reason: "Low confidence on OT",
        validations: [{ rule: "R5", passed: false, message: "OT over cap", severity: "error" }],
      }),
      invoices: [],
    } as never);
    renderNode(<DocFocus docId="d-1" />);
    expect(await screen.findByText("Low confidence on OT")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
  });

  it("shows a no-rows message when extraction is empty", async () => {
    vi.mocked(api.getDoc).mockResolvedValue({
      doc: doc(),
      timesheet: baseTs({ extraction: { rows: [], confidence_per_field: {} } }),
      invoices: [],
    } as never);
    renderNode(<DocFocus docId="d-1" />);
    expect(await screen.findByText("No rows extracted.")).toBeInTheDocument();
  });

  it.each([
    ["image/png", "ts.png", "img"],
    ["application/pdf", "ts.pdf", "iframe"],
  ])("renders the %s source preview", async (mime, filename, tag) => {
    vi.mocked(api.getDoc).mockResolvedValue({ doc: doc({ mime, filename }), timesheet: baseTs(), invoices: [] } as never);
    const { container } = renderNode(<DocFocus docId="d-1" />);
    await screen.findByText("CL001");
    expect(container.querySelector(tag)).toBeTruthy();
  });

  it("renders the EmlCard for an email source", async () => {
    vi.mocked(api.getDoc).mockResolvedValue({
      doc: doc({ mime: "message/rfc822", filename: "msg.eml", channel: "email" }),
      timesheet: baseTs(), invoices: [],
    } as never);
    renderNode(<DocFocus docId="d-1" />);
    await screen.findByText("CL001");
    // EmlCard fetched the source URL
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
  });

  it("renders the SpreadsheetCard for an xlsx source", async () => {
    vi.mocked(api.getDoc).mockResolvedValue({
      doc: doc({ mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: "ts.xlsx" }),
      timesheet: baseTs(), invoices: [],
    } as never);
    renderNode(<DocFocus docId="d-1" />);
    await screen.findByText("CL001");
    // SpreadsheetCard renders an inert placeholder (no fetch)
    expect(await screen.findByText("Excel workbook")).toBeInTheDocument();
  });

  it("Why drawer shows the deterministic explanation + exact-match cost matrix when the LLM is unavailable", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getDoc).mockResolvedValue({ doc: doc(), timesheet: baseTs(), invoices: [inv()] } as never);
    vi.mocked(api.invoiceWhy).mockResolvedValue({
      invoice: inv(), extraction: null,
      match_result: { matches: [], cost_matrix: [[0.01]], candidate_labels: ["E1"], row_labels: ["Carlos Smith"] },
      validations: [], confidence_calibrated: 0.95, routing: "auto", events: [],
    });
    // qa returns an "not configured" answer → llmAnswer is null → deterministic path
    vi.mocked(api.qa).mockResolvedValue({ answer: "OPENAI_API_KEY not configured", citations: [], tool_calls: [], model: "m" });
    renderNode(<DocFocus docId="d-1" />);

    await user.click(await screen.findByRole("button", { name: /Why/ }));
    // deterministic explanation prose (95% confidence, all passed)
    expect(await screen.findByText(/matched every associate cleanly/)).toBeInTheDocument();
    // 1x1 exact-match chip
    expect(screen.getByText("Exact match")).toBeInTheDocument();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../src/api", () => ({
  api: { getDoc: vi.fn() },
  API_BASE: "http://127.0.0.1:8000",
}));

import { api } from "../../src/api";
import { UploadReceipt } from "../../src/components/UploadReceipt";
import { usePersona } from "../../src/store";

function renderReceipt(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={["/portal"]}>
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(api.getDoc).mockReset();
  usePersona.setState({ persona: "client", currentClientCode: "CL001" });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("UploadReceipt — populated pipeline states", () => {
  it("walks the full backend-stage derivation and lands on 'Tax invoice ready'", async () => {
    // Non-empty extraction/matches/validations exercise the backendStage ifs
    // + the validations filter callback; a generated (not dispatched) invoice
    // that isn't awaiting review lands on the "Tax invoice ready" headline.
    vi.mocked(api.getDoc).mockResolvedValue({
      doc: { id: "D1", channel: "upload", mime: "xlsx", filename: "t.xlsx", uploaded_at: "", uploaded_by: "client" },
      timesheet: {
        id: "ts1",
        client_code: "CL001",
        period: "June 2026",
        status: "invoice_generated",
        routing: "auto",
        confidence: 0.95,
        extraction: { rows: [{ employee_name: "Carlos" }] },
        match_result: { matches: [{ row_idx: 0, chosen_emp_id: "E1" }] },
        validations: [
          { passed: true, rule: "R1", severity: "error" },
          { passed: false, rule: "R2", severity: "error" },
          { passed: false, rule: "R3", severity: "warning" },
        ],
      },
      invoices: [{ id: "inv-9", status: "generated", pdf_available: true, total_incl_vat: 2100, period: "June 2026" }],
    } as never);

    renderReceipt(<UploadReceipt docId="D1" />);
    expect(await screen.findByText(/Tax invoice ready/, undefined, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText(/Ready for your approval/)).toBeInTheDocument();
    // generated invoice still exposes the PDF link + AED total
    expect(screen.getByRole("link", { name: /Open tax invoice/ })).toHaveAttribute(
      "href",
      "http://127.0.0.1:8000/invoices/inv-9/pdf",
    );
  });

  it("uses the singular wording when exactly one item needs review", async () => {
    vi.mocked(api.getDoc).mockResolvedValue({
      doc: { id: "D1", channel: "upload", mime: "xlsx", filename: "t.xlsx", uploaded_at: "", uploaded_by: "client" },
      timesheet: {
        id: "ts1",
        client_code: "CL001",
        period: "June 2026",
        status: "awaiting_review",
        routing: "hitl",
        confidence: 0.7,
        extraction: { rows: [{ employee_name: "Carlos" }] },
        match_result: { matches: [{ row_idx: 0 }] },
        validations: [{ passed: false, rule: "R2", severity: "error" }],
      },
      invoices: [],
    } as never);

    renderReceipt(<UploadReceipt docId="D1" />);
    // fails === 1 → "1 item needs a quick look."
    expect(await screen.findByText(/1 item needs a quick look/, undefined, { timeout: 4000 })).toBeInTheDocument();
  });
});

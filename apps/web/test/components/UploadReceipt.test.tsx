import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../src/api", () => ({
  api: {
    getDoc: vi.fn(),
  },
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

// A doc payload matching api.getDoc's return shape.
const doc = (over: Record<string, unknown> = {}) => ({
  doc: { id: "D1", channel: "upload", mime: "xlsx", filename: "t.xlsx", uploaded_at: "", uploaded_by: "client" },
  timesheet: null,
  invoices: [],
  ...over,
});

const ts = (over: Record<string, unknown> = {}) => ({
  id: "ts1",
  doc_id: "D1",
  client_code: "CL001",
  period: "June 2026",
  status: "ingested",
  routing: "hitl",
  confidence: 0.72,
  extraction: { rows: [] },
  match_result: { matches: [] },
  validations: [],
  resolved_rows: [],
  ...over,
});

beforeEach(() => {
  vi.mocked(api.getDoc).mockReset();
  usePersona.setState({ persona: "client", currentClientCode: "CL001" });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("UploadReceipt", () => {
  it("shows the working state before a terminal backend status", async () => {
    vi.mocked(api.getDoc).mockResolvedValue(doc() as never);
    renderReceipt(<UploadReceipt docId="D1" />);
    expect(await screen.findByText(/Working on it/)).toBeInTheDocument();
    expect(screen.getByText("Received the timesheet.")).toBeInTheDocument();
  });

  it("renders the awaiting-review terminal state with badges and actions", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getDoc).mockResolvedValue(doc({ timesheet: ts({ status: "awaiting_review" }) }) as never);
    renderReceipt(<UploadReceipt docId="D1" />);

    expect(await screen.findByText(/A FinOps reviewer is taking a look/)).toBeInTheDocument();
    expect(screen.getByText("CL001")).toBeInTheDocument();
    expect(screen.getByText("June 2026")).toBeInTheDocument();
    expect(screen.getByText("needs review")).toBeInTheDocument();

    // "Email to client" toggles into a queued confirmation
    await user.click(screen.getByRole("button", { name: /Email to client/ }));
    expect(await screen.findByText(/Queued for client delivery/)).toBeInTheDocument();

    // "Track in pipeline" switches persona to finops
    await user.click(screen.getByRole("button", { name: /Track in pipeline/ }));
    expect(usePersona.getState().persona).toBe("finops");
  });

  it("animates through to the auto-dispatched state and links the PDF", async () => {
    vi.mocked(api.getDoc).mockResolvedValue(
      doc({
        timesheet: ts({ status: "invoice_generated", routing: "auto", confidence: 0.95 }),
        invoices: [{ id: "inv-1", status: "dispatched", pdf_available: true, total_incl_vat: 1050, period: "June 2026" }],
      }) as never,
    );
    renderReceipt(<UploadReceipt docId="D1" />);

    // the visible cursor is paced (~600ms/step) toward the terminal backend
    // stage, so give the headline time to catch up.
    expect(
      await screen.findByText(/Auto-dispatched · invoice sent/, undefined, { timeout: 4000 }),
    ).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Open tax invoice/ });
    expect(link).toHaveAttribute("href", "http://127.0.0.1:8000/invoices/inv-1/pdf");
  });
});

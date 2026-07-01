import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../src/api", () => ({
  api: {
    listDocs: vi.fn(),
    listInvoices: vi.fn(),
  },
}));

// DocFocus drags in the whole review UI (framer-motion, contract panel, SAP
// drawer, etc.) and its own API surface. The Console test only cares about the
// queue/stage/selection logic, so stub the detail pane.
vi.mock("../../src/components/DocFocus", () => ({
  DocFocus: ({ docId }: { docId: string }) => <div data-testid="docfocus">DocFocus:{docId}</div>,
}));

import { api } from "../../src/api";
import { Console } from "../../src/pages/Console";
import type { DocSummary, Invoice } from "../../src/types";

function renderPage(node: ReactElement, entry = "/console") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const doc = (over: Partial<DocSummary> = {}): DocSummary => ({
  doc_id: "d-x",
  channel: "portal",
  mime: "text/plain",
  uploaded_at: "2026-06-01T10:00:00Z",
  uploaded_by: "client",
  timesheet_id: null,
  status: "validated",
  routing: "auto",
  confidence: 0.9,
  client_code: "C-X",
  period: "2026-06",
  ...over,
});

const invoice = (over: Partial<Invoice>): Invoice => ({
  id: "inv", timesheet_id: "t", client_code: "C", period: "2026-06", amount: 1,
  currency: "AED", status: "generated", line_items: [], pdf_available: false, dispatched_at: null, ...over,
});

// One dataset that exercises every stageOf branch when filtered.
const ALL_DOCS: DocSummary[] = [
  doc({ doc_id: "d1", client_code: "C-INTAKE", status: "ingested", uploaded_at: "2026-06-07T00:00:00Z" }),
  doc({ doc_id: "d2", client_code: "C-REVIEW", status: "awaiting_review", uploaded_at: "2026-06-06T00:00:00Z" }),
  doc({ doc_id: "d3", client_code: "C-REJ", status: "rejected", uploaded_at: "2026-06-05T00:00:00Z" }),
  doc({ doc_id: "d4", client_code: "C-DISP", status: "invoice_generated", timesheet_id: "tD", uploaded_at: "2026-06-04T00:00:00Z" }),
  doc({ doc_id: "d5", client_code: "C-INVG", status: "processing", timesheet_id: "tG", uploaded_at: "2026-06-03T00:00:00Z" }),
  doc({ doc_id: "d6", client_code: "C-INVA", status: "approved", uploaded_at: "2026-06-02T00:00:00Z" }),
  doc({ doc_id: "d7", client_code: "C-VAL", status: "validated", confidence: null, uploaded_at: "2026-06-01T00:00:00Z" }),
];
const ALL_INVOICES: Invoice[] = [
  invoice({ id: "iD", timesheet_id: "tD", status: "dispatched" }),
  invoice({ id: "iG", timesheet_id: "tG", status: "generated" }),
];

beforeEach(() => {
  vi.mocked(api.listInvoices).mockResolvedValue([]);
});
afterEach(() => vi.clearAllMocks());

describe("Console page", () => {
  it("shows the loading state while docs are fetched", async () => {
    vi.mocked(api.listDocs).mockReturnValue(new Promise<DocSummary[]>(() => {}));
    renderPage(<Console />);
    expect(await screen.findByText("Loading…")).toBeInTheDocument();
  });

  it("shows empty queue + select prompt when there are no documents", async () => {
    vi.mocked(api.listDocs).mockResolvedValue([]);
    renderPage(<Console />);
    expect(await screen.findByText("No documents")).toBeInTheDocument();
    expect(screen.getByText("Select a document")).toBeInTheDocument();
    expect(screen.queryByTestId("docfocus")).not.toBeInTheDocument();
  });

  it("shows a stage-scoped empty message when the filter matches nothing", async () => {
    vi.mocked(api.listDocs).mockResolvedValue([]);
    renderPage(<Console />, "/console?stage=review");
    expect(await screen.findByText("Nothing in 'review'")).toBeInTheDocument();
  });

  it("renders the full queue newest-first and auto-selects the first doc", async () => {
    vi.mocked(api.listDocs).mockResolvedValue(ALL_DOCS);
    vi.mocked(api.listInvoices).mockResolvedValue(ALL_INVOICES);
    renderPage(<Console />);

    // Every client code renders a queue row.
    expect(await screen.findByText("C-INTAKE")).toBeInTheDocument();
    expect(screen.getByText("C-VAL")).toBeInTheDocument();
    // Newest uploaded_at (d1) is auto-selected.
    expect(screen.getByTestId("docfocus")).toHaveTextContent("DocFocus:d1");
    // Six docs carry confidence → six badges; d7 (null confidence) renders none.
    expect(screen.getAllByText("90.0%")).toHaveLength(6);
  });

  it("selects a document from the queue on click", async () => {
    vi.mocked(api.listDocs).mockResolvedValue(ALL_DOCS);
    vi.mocked(api.listInvoices).mockResolvedValue(ALL_INVOICES);
    const user = userEvent.setup();
    renderPage(<Console />);

    await user.click(await screen.findByRole("button", { name: /C-VAL/ }));
    await waitFor(() => expect(screen.getByTestId("docfocus")).toHaveTextContent("DocFocus:d7"));
  });

  it("clears the selection via the mobile Queue back button", async () => {
    vi.mocked(api.listDocs).mockResolvedValue(ALL_DOCS);
    vi.mocked(api.listInvoices).mockResolvedValue(ALL_INVOICES);
    const user = userEvent.setup();
    renderPage(<Console />, "/console?doc=d7");

    expect(await screen.findByTestId("docfocus")).toHaveTextContent("DocFocus:d7");
    await user.click(screen.getByRole("button", { name: /Queue/ }));
    // With the doc param cleared, selection falls back to the newest doc (d1).
    await waitFor(() => expect(screen.getByTestId("docfocus")).toHaveTextContent("DocFocus:d1"));
  });

  it.each([
    ["intake", "C-INTAKE", "C-REVIEW"],
    ["review", "C-REVIEW", "C-INTAKE"],
    ["dispatch", "C-DISP", "C-INTAKE"],
    ["validate", "C-VAL", "C-INTAKE"],
  ])("filters the queue to the '%s' stage", async (stage, present, absent) => {
    vi.mocked(api.listDocs).mockResolvedValue(ALL_DOCS);
    vi.mocked(api.listInvoices).mockResolvedValue(ALL_INVOICES);
    renderPage(<Console />, `/console?stage=${stage}`);

    expect(await screen.findByText(present)).toBeInTheDocument();
    expect(screen.queryByText(absent)).not.toBeInTheDocument();
  });

  it("maps both invoice-stage sources into the 'invoice' filter", async () => {
    vi.mocked(api.listDocs).mockResolvedValue(ALL_DOCS);
    vi.mocked(api.listInvoices).mockResolvedValue(ALL_INVOICES);
    renderPage(<Console />, "/console?stage=invoice");

    // d5 → invoice (its timesheet maps to a 'generated' invoice)
    // d6 → invoice (doc status 'approved')
    expect(await screen.findByText("C-INVG")).toBeInTheDocument();
    expect(screen.getByText("C-INVA")).toBeInTheDocument();
    expect(screen.queryByText("C-INTAKE")).not.toBeInTheDocument();
  });
});

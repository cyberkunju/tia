import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../src/api", () => ({
  api: { listDocs: vi.fn(), listInvoices: vi.fn() },
  API_BASE: "http://127.0.0.1:8000",
}));
// DocFocus is exercised by its own suite; stub it here to isolate Console.
vi.mock("../../src/components/DocFocus", () => ({ DocFocus: ({ docId }: { docId: string }) => <div>docfocus:{docId}</div> }));

import { api } from "../../src/api";
import { Console } from "../../src/pages/Console";

function renderPage(node: ReactElement, entry = "/console") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(api.listInvoices).mockReset().mockResolvedValue([]);
  vi.mocked(api.listDocs).mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("Console — queue rendering with missing fields", () => {
  it("renders a doc row with client/period/uploaded_at fallbacks and selects it", async () => {
    vi.mocked(api.listDocs).mockResolvedValue([
      { doc_id: "D1", client_code: null, period: null, channel: "email", status: "ingested", uploaded_at: null, confidence: null },
      { doc_id: "D2", client_code: "CL001", period: "2026-06", channel: "upload", status: "dispatched", uploaded_at: "2026-06-01T10:00:00Z", confidence: 0.9 },
    ] as never);
    renderPage(<Console />);
    // client_code ?? "Unknown client"
    expect(await screen.findByText("Unknown client")).toBeInTheDocument();
    // first doc auto-selected → stubbed DocFocus
    expect(screen.getByText(/docfocus:/)).toBeInTheDocument();
  });

  it("filters by ?stage and shows the empty state for an empty stage", async () => {
    vi.mocked(api.listDocs).mockResolvedValue([
      { doc_id: "D1", client_code: "CL001", period: "2026-06", channel: "upload", status: "ingested", uploaded_at: "2026-06-01T10:00:00Z", confidence: 0.9 },
    ] as never);
    renderPage(<Console />, "/console?stage=review");
    expect(await screen.findByText(/Nothing in 'review'/)).toBeInTheDocument();
  });
});

describe("Console — invoice-by-timesheet map", () => {
  it("indexes invoices that have a timesheet_id and skips those without", async () => {
    vi.mocked(api.listInvoices).mockResolvedValue([
      { id: "i1", timesheet_id: "ts1", status: "dispatched" },
      { id: "i2", timesheet_id: null, status: "generated" }, // no timesheet_id → skipped
    ] as never);
    vi.mocked(api.listDocs).mockResolvedValue([
      { doc_id: "D1", client_code: "CL001", period: "2026-06", channel: "upload", status: "invoice_generated", timesheet_id: "ts1", uploaded_at: "2026-06-01T10:00:00Z", confidence: 0.9 },
    ] as never);
    renderPage(<Console />, "/console?stage=dispatch");
    // D1's timesheet maps to the dispatched invoice → stage "dispatch" keeps it
    expect(await screen.findByText(/docfocus:/)).toBeInTheDocument();
  });
});

describe("Console — sort with both timestamps missing", () => {
  it("sorts docs when both uploaded_at values are null (`?? ''` on both sides)", async () => {
    vi.mocked(api.listInvoices).mockResolvedValue([] as never);
    vi.mocked(api.listDocs).mockResolvedValue([
      { doc_id: "D1", client_code: "CL001", period: "2026-06", channel: "email", status: "ingested", uploaded_at: null, confidence: null },
      { doc_id: "D2", client_code: "CL002", period: "2026-06", channel: "upload", status: "ingested", uploaded_at: null, confidence: null },
    ] as never);
    renderPage(<Console />);
    // both rendered; the comparator exercised `(b.uploaded_at ?? "")` and `(a.uploaded_at ?? "")`
    expect(await screen.findByText("CL001")).toBeInTheDocument();
    expect(screen.getByText("CL002")).toBeInTheDocument();
  });
});

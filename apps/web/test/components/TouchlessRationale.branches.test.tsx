import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../src/api", () => ({ api: { listEvents: vi.fn() } }));

import { api } from "../../src/api";
import { TouchlessRationale } from "../../src/components/TouchlessRationale";
import type { EventRow, Invoice } from "../../src/types";

function renderModal(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: "abcdef12-3456-7890-aaaa-bbbbbbbbbbbb", timesheet_id: "ts1", client_code: "CL001",
  period: "2026-06", amount: 9000, currency: "AED", status: "dispatched", line_items: [],
  pdf_available: true, dispatched_at: null, invoice_sequence_no: "INV-7", ...over,
});

beforeEach(() => vi.mocked(api.listEvents).mockReset());
afterEach(() => vi.clearAllMocks());

describe("TouchlessRationale — default/fallback branches", () => {
  it("uses invoice.amount, the default threshold/engine, event.id and '-' time when the payload is bare", async () => {
    // Auto event with an (almost) empty payload and no timestamp → every `??`
    // default and the `event.at ? ... : "-"` false branch fire.
    const bareEvent: EventRow = {
      id: "evt-bare-id", at: "", actor: "system", kind: "invoice", entity_id: "abcdef12",
      action: "auto_dispatched_within_tolerance", payload: {}, idempotency_key: null,
    };
    vi.mocked(api.listEvents).mockResolvedValue([bareEvent]);
    // invoice without total_incl_vat → header uses `?? invoice.amount`
    renderModal(<TouchlessRationale invoice={invoice({ total_incl_vat: undefined })} onClose={() => {}} />);

    expect(await screen.findByText("Auto-dispatched within tolerance")).toBeInTheDocument();
    // p.amount ?? invoice.amount (9000) and default threshold 50000
    expect(screen.getByText("AED 9,000")).toBeInTheDocument();
    expect(screen.getByText("AED 50,000")).toBeInTheDocument();
    // default engine
    expect(screen.getByText("in_process")).toBeInTheDocument();
    // event.at is empty → decision time renders the "-" fallback
    expect(screen.getByText("-")).toBeInTheDocument();
    // hash falls back to event.id when idempotency_key is absent
    expect(screen.getByText(/evt-bare-id…/)).toBeInTheDocument();
  });
});

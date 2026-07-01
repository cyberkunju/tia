import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

vi.mock("../../src/api", () => ({ api: { submitEmail: vi.fn(), getDoc: vi.fn() } }));
vi.mock("framer-motion", () => ({ useInView: () => true }));

import { api } from "../../src/api";
import { EmailDemo } from "../../src/components/EmailDemo";

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api.submitEmail).mockReset();
  vi.mocked(api.getDoc).mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

async function drain(ms = 20000) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe("EmailDemo — invoice field fallbacks + polling retry", () => {
  it("retries a failed poll then fills missing invoice fields from fallbacks", async () => {
    vi.mocked(api.submitEmail).mockResolvedValue({
      doc_id: "D1", timesheet_id: "ts1", status: "invoice_generated", routing: "auto", confidence: 0.9,
    });
    // First poll throws (catch → keep polling); second returns an invoice with
    // only `amount` set → total_incl_vat/seq/period all take their fallbacks.
    vi.mocked(api.getDoc)
      .mockRejectedValueOnce(new Error("still processing"))
      .mockResolvedValue({
        doc: { id: "D1", channel: "email", mime: "txt", filename: "e.txt", uploaded_at: "", uploaded_by: "client" },
        timesheet: null,
        invoices: [{ id: "i1", amount: 1000 }],
      } as never);

    render(<EmailDemo />);
    await drain();

    // seq fallback "TIA-INV" → filename; total from amount; period fallback.
    expect(screen.getByText("Invoice_TIA-INV.pdf")).toBeInTheDocument();
    expect(screen.getByText(/AED 1,000.00 · incl. 5% VAT/)).toBeInTheDocument();
  });
});

describe("EmailDemo — processing indicator", () => {
  it("shows the 'TIA is reading' indicator while billing is in flight", async () => {
    vi.mocked(api.submitEmail).mockReturnValue(new Promise(() => {}) as never); // hangs in bill()
    render(<EmailDemo />);
    // ~900ms in, processing flips true → the reading indicator renders
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText(/TIA is reading the timesheet/)).toBeInTheDocument();
  });
});

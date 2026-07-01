import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

vi.mock("../../src/api", () => ({ api: { submitEmail: vi.fn(), getDoc: vi.fn(), qa: vi.fn() } }));
vi.mock("framer-motion", () => ({ useInView: () => true }));

import { api } from "../../src/api";
import { WhatsAppDemo } from "../../src/components/WhatsAppDemo";

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api.submitEmail).mockReset();
  vi.mocked(api.getDoc).mockReset();
  vi.mocked(api.qa).mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

async function drain(ms = 40000) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe("WhatsAppDemo — fallbacks + canned answer on a bad agent reply", () => {
  it("uses field fallbacks and falls back to canned answers when /qa is misconfigured", async () => {
    vi.mocked(api.submitEmail).mockResolvedValue({
      doc_id: "D1", timesheet_id: "ts1", status: "invoice_generated", routing: "auto", confidence: 0.9,
    });
    // Invoice has an id (so the agent /qa path runs) but no total/seq/period
    // → field fallbacks fire on line 65.
    vi.mocked(api.getDoc).mockResolvedValue({
      doc: { id: "D1", channel: "whatsapp", mime: "txt", filename: "w.txt", uploaded_at: "", uploaded_by: "client" },
      timesheet: null,
      invoices: [{ id: "i1", amount: 1000 }],
    } as never);
    // A "bad" agent answer → the component discards it and shows the canned reply.
    vi.mocked(api.qa).mockResolvedValue({ answer: "OPENAI_API_KEY not configured", citations: [], model: "x" } as never);

    render(<WhatsAppDemo />);
    await drain();

    expect(screen.getByText("Invoice_TIA-INV.pdf")).toBeInTheDocument();
    // canned VAT reply computed from the fallback total (1000): net≈952.38, VAT≈47.62
    expect(screen.getByText(/VAT is AED 47.62 at the UAE standard 5%/)).toBeInTheDocument();
    expect(vi.mocked(api.qa)).toHaveBeenCalled();
  });

  it("uses the /qa error fallback (thrown) → canned answers too", async () => {
    vi.mocked(api.submitEmail).mockResolvedValue({
      doc_id: "D2", timesheet_id: "ts2", status: "invoice_generated", routing: "auto", confidence: 0.9,
    });
    vi.mocked(api.getDoc).mockResolvedValue({
      doc: { id: "D2", channel: "whatsapp", mime: "txt", filename: "w.txt", uploaded_at: "", uploaded_by: "client" },
      timesheet: null,
      invoices: [{ id: "i2", total_incl_vat: 48720, invoice_sequence_no: "TIA-INV-2026-0001", period: "June 2026" }],
    } as never);
    vi.mocked(api.qa).mockRejectedValue(new Error("network"));

    render(<WhatsAppDemo />);
    await drain();
    expect(screen.getByText(/VAT is AED 2,320.00 at the UAE standard 5%/)).toBeInTheDocument();
  });
});

describe("WhatsAppDemo — polling retry + transient composer/typing states", () => {
  it("keeps polling when a doc has no invoice yet", async () => {
    vi.mocked(api.submitEmail).mockResolvedValue({ doc_id: "D1", timesheet_id: "t", status: "ok", routing: "auto", confidence: 0.9 } as never);
    vi.mocked(api.getDoc)
      .mockResolvedValueOnce({ doc: { id: "D1", channel: "whatsapp", mime: "txt", filename: "w", uploaded_at: "", uploaded_by: "c" }, timesheet: null, invoices: [] } as never) // no invoice → loop continues
      .mockResolvedValue({ doc: { id: "D1", channel: "whatsapp", mime: "txt", filename: "w", uploaded_at: "", uploaded_by: "c" }, timesheet: null, invoices: [{ id: "i1", total_incl_vat: 48720, invoice_sequence_no: "TIA-INV-2026-0001", period: "June 2026" }] } as never);
    vi.mocked(api.qa).mockRejectedValue(new Error("x"));
    render(<WhatsAppDemo />);
    await drain();
    expect(screen.getByText("Invoice_TIA-INV-2026-0001.pdf")).toBeInTheDocument();
  });

  it("shows the composer text and the typing indicator while billing is in flight", async () => {
    vi.mocked(api.submitEmail).mockReturnValue(new Promise(() => {}) as never); // hang inside bill()
    render(<WhatsAppDemo />);
    // ~900ms in: the composer has the drafted message (composer-present branches)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText("June timesheet for Emirates Steel")).toBeInTheDocument();
    // ~2100ms in: status flips to "typing" and stays (bill hangs on submitEmail)
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.getByText("typing…")).toBeInTheDocument();
  });
});

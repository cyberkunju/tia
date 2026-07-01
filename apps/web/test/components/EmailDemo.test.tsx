import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../src/api", () => ({
  api: {
    submitEmail: vi.fn(),
    getDoc: vi.fn(),
  },
}));

// framer-motion's useInView relies on a real IntersectionObserver firing async;
// under fake timers it never flips. The component only reads inView to auto-play,
// so force it true and drive the rest with the fake clock.
vi.mock("framer-motion", () => ({ useInView: () => true }));

import { api } from "../../src/api";
import { EmailDemo } from "../../src/components/EmailDemo";

const SAMPLE_BODY =
  "Client: Emirates Steel Industries LLC (CL001)\nPeriod: June 2026\n\nEMP10001 Carlos Smith - 20 days\nEMP10002 Ahmed Khan - 20 days, 2 OT hours\n\nApproved by: Site Manager";

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
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("EmailDemo", () => {
  it("renders the inbound client email immediately", () => {
    vi.mocked(api.submitEmail).mockRejectedValue(new Error("offline"));
    render(<EmailDemo />);
    expect(screen.getByText(/Please raise the invoice/)).toBeInTheDocument();
    expect(screen.getByText("June 2026 timesheet · CL001")).toBeInTheDocument();
    expect(screen.getByText("Timesheet_June2026.xlsx")).toBeInTheDocument();
  });

  it("bills a real invoice from the backend and replies in-thread", async () => {
    vi.mocked(api.submitEmail).mockResolvedValue({
      doc_id: "D1", timesheet_id: "ts1", status: "invoice_generated", routing: "auto", confidence: 0.95,
    });
    vi.mocked(api.getDoc).mockResolvedValue({
      doc: { id: "D1", channel: "email", mime: "txt", filename: "e.txt", uploaded_at: "", uploaded_by: "client" },
      timesheet: null,
      invoices: [{ id: "i1", total_incl_vat: 50000, invoice_sequence_no: "TIA-INV-2026-0009", period: "June 2026" }],
    } as never);

    render(<EmailDemo />);
    await drain();

    expect(screen.getByText(/The invoice is attached/)).toBeInTheDocument();
    expect(screen.getByText("Invoice_TIA-INV-2026-0009.pdf")).toBeInTheDocument();
    expect(screen.getByText(/AED 50,000.00 · incl. 5% VAT/)).toBeInTheDocument();
    expect(screen.getByText(/R1 to R15 passed/)).toBeInTheDocument();
    expect(vi.mocked(api.submitEmail)).toHaveBeenCalledWith(SAMPLE_BODY, "June 2026 timesheet · CL001");
  });

  it("falls back to a demo invoice when the backend is offline and replays", async () => {
    vi.mocked(api.submitEmail).mockRejectedValue(new Error("network down"));
    render(<EmailDemo />);
    await drain();

    expect(screen.getByText("Invoice_TIA-INV-2026-0001.pdf")).toBeInTheDocument();
    expect(screen.getByText(/AED 48,720.00 · incl. 5% VAT/)).toBeInTheDocument();

    const replay = screen.getByRole("button", { name: /Replay/ });
    fireEvent.click(replay);
    await drain();
    // after replay the invoice is regenerated
    expect(screen.getByText("Invoice_TIA-INV-2026-0001.pdf")).toBeInTheDocument();
  });
});

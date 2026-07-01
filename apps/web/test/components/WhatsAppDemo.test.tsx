import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../src/api", () => ({
  api: {
    submitEmail: vi.fn(),
    getDoc: vi.fn(),
    qa: vi.fn(),
  },
}));

// See EmailDemo test: force useInView true so playback runs under fake timers.
vi.mock("framer-motion", () => ({ useInView: () => true }));

import { api } from "../../src/api";
import { WhatsAppDemo } from "../../src/components/WhatsAppDemo";

const SAMPLE_BODY =
  "Client: Emirates Steel Industries LLC (CL001)\nPeriod: June 2026\n\nEMP10001 Carlos Smith - 20 days\nEMP10002 Ahmed Khan - 20 days, 2 OT hours\n\nApproved by: Site Manager";

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
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("WhatsAppDemo", () => {
  it("renders the phone chrome and greeting before playback", () => {
    vi.mocked(api.submitEmail).mockRejectedValue(new Error("offline"));
    render(<WhatsAppDemo />);
    expect(screen.getByText("TIA")).toBeInTheDocument();
    expect(screen.getByText(/Send me a timesheet and I'll bill it/)).toBeInTheDocument();
    expect(screen.getByText(/Messages are end-to-end encrypted/)).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
  });

  it("uses canned answers offline and shows the invoice bubble", async () => {
    vi.mocked(api.submitEmail).mockRejectedValue(new Error("network down"));
    render(<WhatsAppDemo />);
    await drain();

    expect(screen.getByText("Invoice_TIA-INV-2026-0001.pdf")).toBeInTheDocument();
    expect(screen.getByText(/Dispatched to Finance/)).toBeInTheDocument();
    // canned VAT answer (net 46,400 → VAT 2,320)
    expect(screen.getByText(/VAT is AED 2,320.00 at the UAE standard 5%/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Replay/ })).toBeInTheDocument();
    // offline invoice has no id → the agent /qa endpoint is never called
    expect(vi.mocked(api.qa)).not.toHaveBeenCalled();
  });

  it("asks the agent when a real invoice id exists", async () => {
    vi.mocked(api.submitEmail).mockResolvedValue({
      doc_id: "D1", timesheet_id: "ts1", status: "invoice_generated", routing: "auto", confidence: 0.95,
    });
    vi.mocked(api.getDoc).mockResolvedValue({
      doc: { id: "D1", channel: "whatsapp", mime: "txt", filename: "w.txt", uploaded_at: "", uploaded_by: "client" },
      timesheet: null,
      invoices: [{ id: "i1", total_incl_vat: 50000, invoice_sequence_no: "TIA-INV-2026-0009", period: "June 2026" }],
    } as never);
    vi.mocked(api.qa).mockResolvedValue({ answer: "Custom answer from the agent", citations: [], model: "test" } as never);

    render(<WhatsAppDemo />);
    await drain();

    expect(screen.getByText("Invoice_TIA-INV-2026-0009.pdf")).toBeInTheDocument();
    expect(screen.getAllByText("Custom answer from the agent").length).toBeGreaterThan(0);
    expect(vi.mocked(api.submitEmail)).toHaveBeenCalledWith(SAMPLE_BODY, "CL001 June 2026 timesheet");
    expect(vi.mocked(api.qa)).toHaveBeenCalledWith("What's the VAT on this?", { kind: "invoice", id: "i1" });
  });

  it("replays the conversation from the greeting", async () => {
    vi.mocked(api.submitEmail).mockRejectedValue(new Error("offline"));
    render(<WhatsAppDemo />);
    await drain();
    fireEvent.click(screen.getByRole("button", { name: /Replay/ }));
    await drain();
    expect(screen.getByText("Invoice_TIA-INV-2026-0001.pdf")).toBeInTheDocument();
  });
});

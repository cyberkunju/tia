import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../src/api", () => ({
  api: {
    clawbackEligibility: vi.fn(),
    clawback: vi.fn(),
  },
}));

import { api } from "../../src/api";
import { ClawbackModal } from "../../src/components/ClawbackModal";
import type { ClawbackEligibility, Invoice } from "../../src/types";

function renderModal(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const invoice = {
  id: "inv-12345678-abcd",
  timesheet_id: "ts1",
  client_code: "CL001",
  period: "June 2026",
  amount: 1000,
  currency: "AED",
  status: "dispatched",
  line_items: [],
  pdf_available: true,
  dispatched_at: "2026-06-01T00:00:00Z",
  invoice_sequence_no: "TIA-INV-2026-0007",
  total_incl_vat: 1050,
} as Invoice;

const voidElig: ClawbackEligibility = {
  current_state: "generated",
  action_when_clawed_back: "void",
  explanation: "Not yet dispatched — safe to void.",
  valid_reason_codes: ["PRICING_ERROR", "OTHER"],
};

const creditElig: ClawbackEligibility = {
  current_state: "dispatched",
  action_when_clawed_back: "credit_note",
  days_remaining: 9,
  urgency: "warning",
  explanation: "Dispatched — a credit note is required.",
  valid_reason_codes: ["GOODS_RETURNED", "DISCOUNT", "OTHER"],
  valid_adjustment_types: ["CREDIT_TO_CLIENT", "DEDUCT_FROM_NEXT_INVOICE"],
  adjustment_type_labels: {
    CREDIT_TO_CLIENT: "Credit to client",
    DEDUCT_FROM_NEXT_INVOICE: "Deduct from next invoice",
    DEDUCT_FROM_PAYROLL: "Deduct from payroll",
    INTERNAL_WRITE_OFF: "Internal write-off",
    MANUAL_REVIEW: "Manual review",
  },
};

beforeEach(() => {
  vi.mocked(api.clawbackEligibility).mockReset();
  vi.mocked(api.clawback).mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("ClawbackModal", () => {
  it("shows a loading state while eligibility is being fetched", () => {
    vi.mocked(api.clawbackEligibility).mockReturnValue(new Promise(() => {}));
    renderModal(<ClawbackModal invoice={invoice} onClose={() => {}} onDone={() => {}} />);
    expect(screen.getByText(/Checking eligibility/)).toBeInTheDocument();
    // invoice header prose renders regardless of eligibility
    expect(screen.getByText("TIA-INV-2026-0007")).toBeInTheDocument();
    expect(screen.getByText(/AED 1,050.00/)).toBeInTheDocument();
  });

  it("renders the already-settled state when clawback is not valid", async () => {
    vi.mocked(api.clawbackEligibility).mockResolvedValue({
      current_state: "credit_noted",
      action_when_clawed_back: null,
      reason: "Already credit-noted.",
    });
    renderModal(<ClawbackModal invoice={invoice} onClose={() => {}} onDone={() => {}} />);
    expect(await screen.findByText(/Already settled/)).toBeInTheDocument();
    expect(screen.getByText(/Already credit-noted/)).toBeInTheDocument();
  });

  it("renders the void path and submits with the default reason", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    vi.mocked(api.clawbackEligibility).mockResolvedValue(voidElig);
    vi.mocked(api.clawback).mockResolvedValue({
      action_taken: "voided", status: "voided", invoice_id: invoice.id,
    });
    renderModal(<ClawbackModal invoice={invoice} onClose={() => {}} onDone={onDone} />);

    expect(await screen.findByText("Void this invoice")).toBeInTheDocument();
    expect(screen.getByText(/Pre-dispatch void/)).toBeInTheDocument();
    // credit-note-only controls are absent on the void path
    expect(screen.queryByText(/Partial clawback/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Void invoice/ }));

    await waitFor(() =>
      expect(vi.mocked(api.clawback)).toHaveBeenCalledWith(invoice.id, {
        by_user: "finops",
        reason_code: "PRICING_ERROR",
        reason_text: undefined,
        adjustment_type: "CREDIT_TO_CLIENT",
        partial_amount: undefined,
        disputed_hours: undefined,
      }),
    );
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it("renders the credit-note path, captures a partial clawback and submits", async () => {
    const user = userEvent.setup();
    vi.mocked(api.clawbackEligibility).mockResolvedValue(creditElig);
    vi.mocked(api.clawback).mockResolvedValue({
      action_taken: "credit_note_issued", status: "credit_noted", invoice_id: invoice.id,
    });
    renderModal(<ClawbackModal invoice={invoice} onClose={() => {}} onDone={() => {}} />);

    expect(await screen.findByText("Issue a Tax Credit Note")).toBeInTheDocument();
    expect(screen.getByText(/9 days remaining/)).toBeInTheDocument();

    const combos = screen.getAllByRole("combobox");
    await user.selectOptions(combos[0], "DISCOUNT"); // reason
    await user.type(screen.getByPlaceholderText(/Explain the adjustment/), "explain");
    await user.click(screen.getByRole("checkbox"));
    await user.type(screen.getByPlaceholderText("e.g. 200"), "200");
    await user.type(screen.getByPlaceholderText("e.g. 4"), "4");
    await user.selectOptions(combos[1], "DEDUCT_FROM_NEXT_INVOICE"); // adjustment

    await user.click(screen.getByRole("button", { name: /Issue credit note/ }));

    await waitFor(() =>
      expect(vi.mocked(api.clawback)).toHaveBeenCalledWith(invoice.id, {
        by_user: "finops",
        reason_code: "DISCOUNT",
        reason_text: "explain",
        adjustment_type: "DEDUCT_FROM_NEXT_INVOICE",
        partial_amount: 200,
        disputed_hours: 4,
      }),
    );
  });

  it("shows the refund warning on the credit_note_with_refund_pending path", async () => {
    vi.mocked(api.clawbackEligibility).mockResolvedValue({
      ...creditElig,
      action_when_clawed_back: "credit_note_with_refund_pending",
      urgency: "urgent",
      days_remaining: 1,
    });
    renderModal(<ClawbackModal invoice={invoice} onClose={() => {}} onDone={() => {}} />);
    expect(await screen.findByText(/Issue a Tax Credit Note \+ flag for refund/)).toBeInTheDocument();
    expect(screen.getByText(/A refund will be required/)).toBeInTheDocument();
    // singular "day remaining" when only one day is left
    expect(screen.getByText(/1 day remaining/)).toBeInTheDocument();
  });

  it("surfaces a mutation error", async () => {
    const user = userEvent.setup();
    vi.mocked(api.clawbackEligibility).mockResolvedValue(voidElig);
    vi.mocked(api.clawback).mockRejectedValue(new Error("backend exploded"));
    renderModal(<ClawbackModal invoice={invoice} onClose={() => {}} onDone={() => {}} />);

    await user.click(await screen.findByRole("button", { name: /Void invoice/ }));
    expect(await screen.findByText(/backend exploded/)).toBeInTheDocument();
  });

  it("closes via the close button and the backdrop", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    vi.mocked(api.clawbackEligibility).mockResolvedValue(voidElig);
    renderModal(<ClawbackModal invoice={invoice} onClose={onClose} onDone={() => {}} />);

    await user.click(await screen.findByRole("button", { name: /Cancel/ }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

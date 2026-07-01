import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../src/api", () => ({ api: { clawbackEligibility: vi.fn(), clawback: vi.fn() } }));

import { api } from "../../src/api";
import { ClawbackModal } from "../../src/components/ClawbackModal";
import type { ClawbackEligibility, Invoice } from "../../src/types";

function renderModal(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const invoice = {
  id: "inv-1", invoice_sequence_no: "INV-1", amount: 1000, total_incl_vat: 1050,
  currency: "AED", status: "dispatched", client_code: "CL001", period: "2026-06",
  timesheet_id: "t1", line_items: [], pdf_available: false, dispatched_at: null,
} as unknown as Invoice;

const elig = (over: Partial<ClawbackEligibility> = {}): ClawbackEligibility => ({
  current_state: "dispatched",
  action_when_clawed_back: "credit_note",
  valid_reason_codes: ["PRICING_ERROR", "DUPLICATE"],
  valid_adjustment_types: ["CREDIT_TO_CLIENT", "INTERNAL_WRITE_OFF"],
  ...over,
}) as ClawbackEligibility;

beforeEach(() => {
  vi.mocked(api.clawbackEligibility).mockReset();
  vi.mocked(api.clawback).mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("ClawbackModal — eligibility-driven variants", () => {
  it("renders the void path and submits", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    vi.mocked(api.clawbackEligibility).mockResolvedValue(
      elig({ action_when_clawed_back: "void", explanation: "Not yet dispatched, so it can be voided cleanly.", valid_reason_codes: ["PRICING_ERROR"] }),
    );
    vi.mocked(api.clawback).mockResolvedValue({ status: "voided" } as never);
    renderModal(<ClawbackModal invoice={invoice} onClose={() => {}} onDone={onDone} />);

    expect(await screen.findByText("Void this invoice")).toBeInTheDocument();
    expect(screen.getByText(/Not yet dispatched, so it can be voided/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Void invoice/ }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("shows the 'already settled' message when clawback is not valid", async () => {
    vi.mocked(api.clawbackEligibility).mockResolvedValue(
      elig({ action_when_clawed_back: null as never, reason: "Invoice already paid." }),
    );
    renderModal(<ClawbackModal invoice={invoice} onClose={() => {}} onDone={() => {}} />);
    expect(await screen.findByText(/Already settled/)).toBeInTheDocument();
    expect(screen.getByText(/Invoice already paid/)).toBeInTheDocument();
  });

  it("renders an urgent credit-note banner with singular day + partial inputs, and surfaces a mutation error", async () => {
    const user = userEvent.setup();
    vi.mocked(api.clawbackEligibility).mockResolvedValue(
      elig({ urgency: "urgent", days_remaining: 1 }),
    );
    vi.mocked(api.clawback).mockRejectedValue(new Error("backend refused"));
    renderModal(<ClawbackModal invoice={invoice} onClose={() => {}} onDone={() => {}} />);

    expect(await screen.findByText(/1 day remaining/)).toBeInTheDocument();
    // toggle partial → disputed inputs appear
    await user.click(screen.getByRole("checkbox"));
    expect(screen.getByPlaceholderText("e.g. 200")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("e.g. 200"), "150");
    await user.type(screen.getByPlaceholderText("e.g. 4"), "3");

    await user.click(screen.getByRole("button", { name: /Issue credit note/ }));
    expect(await screen.findByText(/backend refused/)).toBeInTheDocument();
  });

  it("renders the warning-tone banner", async () => {
    vi.mocked(api.clawbackEligibility).mockResolvedValue(elig({ urgency: "warning", days_remaining: 5 }));
    renderModal(<ClawbackModal invoice={invoice} onClose={() => {}} onDone={() => {}} />);
    expect(await screen.findByText(/5 days remaining/)).toBeInTheDocument();
  });

  it("renders the normal tone (default 14 days) and the refund-pending chip", async () => {
    vi.mocked(api.clawbackEligibility).mockResolvedValue(
      elig({ action_when_clawed_back: "credit_note_with_refund_pending", urgency: undefined, days_remaining: undefined }),
    );
    renderModal(<ClawbackModal invoice={invoice} onClose={() => {}} onDone={() => {}} />);
    expect(await screen.findByText(/14 days remaining/)).toBeInTheDocument();
    expect(screen.getByText(/A refund will be required/)).toBeInTheDocument();
  });
});

const invoiceNoSeq = {
  id: "abcdef1234567890", amount: 800, currency: "AED", status: "generated",
  line_items: [], pdf_available: false, timesheet_id: "t1", dispatched_at: null,
} as unknown as Invoice;

describe("ClawbackModal — invoice/eligibility fallbacks + pending", () => {
  it("falls back to id slice + amount when seq/total are missing, and defaults the reason codes", async () => {
    vi.mocked(api.clawbackEligibility).mockResolvedValue({
      current_state: "generated", action_when_clawed_back: "credit_note",
      // no valid_reason_codes → Object.keys(REASON_LABELS); no valid_adjustment_types → defaults
    } as never);
    renderModal(<ClawbackModal invoice={invoiceNoSeq} onClose={() => {}} onDone={() => {}} />);
    // id.slice(0,8) shown in the header
    expect(await screen.findByText("abcdef12")).toBeInTheDocument();
    // default reason options include "Pricing error"
    expect(await screen.findByRole("option", { name: "Pricing error" })).toBeInTheDocument();
  });

  it("renders a reason code that has no label (falls back to the raw code)", async () => {
    vi.mocked(api.clawbackEligibility).mockResolvedValue({
      current_state: "generated", action_when_clawed_back: "credit_note",
      valid_reason_codes: ["WEIRD_CODE"], valid_adjustment_types: ["INTERNAL_WRITE_OFF"],
    } as never);
    renderModal(<ClawbackModal invoice={invoiceNoSeq} onClose={() => {}} onDone={() => {}} />);
    expect(await screen.findByRole("option", { name: "WEIRD_CODE" })).toBeInTheDocument();
  });

  it("shows the generic 'not valid' message when settled without a reason", async () => {
    vi.mocked(api.clawbackEligibility).mockResolvedValue({
      current_state: "paid", action_when_clawed_back: null,
    } as never);
    renderModal(<ClawbackModal invoice={invoiceNoSeq} onClose={() => {}} onDone={() => {}} />);
    expect(await screen.findByText(/Clawback not valid from this state/)).toBeInTheDocument();
  });

  it("disables the submit button while the mutation is pending", async () => {
    const user = userEvent.setup();
    vi.mocked(api.clawbackEligibility).mockResolvedValue({
      current_state: "dispatched", action_when_clawed_back: "void", valid_reason_codes: ["DUPLICATE"], valid_adjustment_types: ["INTERNAL_WRITE_OFF"], explanation: "ok",
    } as never);
    vi.mocked(api.clawback).mockReturnValue(new Promise(() => {}) as never); // never resolves → pending
    renderModal(<ClawbackModal invoice={invoiceNoSeq} onClose={() => {}} onDone={() => {}} />);
    const btn = await screen.findByRole("button", { name: /Void invoice/ });
    await user.click(btn);
    await waitFor(() => expect(btn).toBeDisabled());
  });
});

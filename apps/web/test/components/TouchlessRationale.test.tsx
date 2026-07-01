import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";

vi.mock("../../src/api", () => ({
  api: { listEvents: vi.fn() },
}));

import { api } from "../../src/api";
import { TouchlessRationale } from "../../src/components/TouchlessRationale";
import type { EventRow, Invoice } from "../../src/types";

function renderModal(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: "abcdef12-3456-7890-aaaa-bbbbbbbbbbbb",
  timesheet_id: "ts1",
  client_code: "CL001",
  period: "2026-06",
  amount: 12000,
  currency: "AED",
  status: "dispatched",
  line_items: [],
  pdf_available: true,
  dispatched_at: null,
  invoice_sequence_no: "INV-2026-0042",
  total_incl_vat: 12600,
  ...over,
});

const autoEvent = (over: Partial<EventRow> = {}): EventRow => ({
  id: "evt-1",
  at: "2026-06-01T09:15:30Z",
  actor: "system",
  kind: "invoice",
  entity_id: "abcdef12",
  action: "auto_dispatched_within_tolerance",
  payload: {
    amount: 12000,
    threshold: 50000,
    rules_passed: ["VAT_01", "OT_CAP"],
    engine: "in_process",
    idempotency_key: "idem-key-1234567890abcdefghij",
  },
  idempotency_key: null,
  ...over,
});

beforeEach(() => {
  vi.mocked(api.listEvents).mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("TouchlessRationale", () => {
  it("shows a loading state and the invoice header while events load", () => {
    vi.mocked(api.listEvents).mockReturnValue(new Promise(() => {}) as Promise<EventRow[]>);
    renderModal(<TouchlessRationale invoice={invoice()} onClose={() => {}} />);

    expect(screen.getByText("Why was this touchless?")).toBeInTheDocument();
    expect(screen.getByText("INV-2026-0042")).toBeInTheDocument();
    expect(screen.getByText(/AED 12,600.00/)).toBeInTheDocument();
    expect(screen.getByText(/Loading audit trail/)).toBeInTheDocument();
  });

  it("explains that a non-auto invoice went through manual review", async () => {
    vi.mocked(api.listEvents).mockResolvedValue([
      autoEvent({ action: "finance_approved" }),
    ]);
    renderModal(<TouchlessRationale invoice={invoice()} onClose={() => {}} />);
    expect(
      await screen.findByText(/wasn't auto-dispatched - it went through manual review/),
    ).toBeInTheDocument();
  });

  it("renders the auto-dispatch rationale with amounts, rule chips, engine and audit hash", async () => {
    vi.mocked(api.listEvents).mockResolvedValue([autoEvent()]);
    renderModal(<TouchlessRationale invoice={invoice()} onClose={() => {}} />);

    expect(await screen.findByText("Auto-dispatched within tolerance")).toBeInTheDocument();
    // amount + threshold formatted with AED and grouping
    expect(screen.getByText("AED 12,000")).toBeInTheDocument();
    expect(screen.getByText("AED 50,000")).toBeInTheDocument();
    // rule chips
    expect(screen.getByText("Rules that passed (2)")).toBeInTheDocument();
    expect(screen.getByText("VAT_01")).toBeInTheDocument();
    expect(screen.getByText("OT_CAP")).toBeInTheDocument();
    // engine + decision time
    expect(screen.getByText("in_process")).toBeInTheDocument();
    expect(screen.getByText("09:15:30")).toBeInTheDocument();
    // audit hash: idempotency_key sliced to 32 chars + ellipsis
    expect(screen.getByText(/idem-key-1234567890abcdefghij…/)).toBeInTheDocument();
  });

  it("shows 'No rule IDs recorded.' when the auto event has no passed rules", async () => {
    vi.mocked(api.listEvents).mockResolvedValue([
      autoEvent({ payload: { amount: 100, threshold: 50000, engine: "in_process" } }),
    ]);
    renderModal(<TouchlessRationale invoice={invoice()} onClose={() => {}} />);

    expect(await screen.findByText("Rules that passed (0)")).toBeInTheDocument();
    expect(screen.getByText("No rule IDs recorded.")).toBeInTheDocument();
  });

  it("falls back to the truncated invoice id when there is no sequence number", () => {
    vi.mocked(api.listEvents).mockReturnValue(new Promise(() => {}) as Promise<EventRow[]>);
    renderModal(<TouchlessRationale invoice={invoice({ invoice_sequence_no: null })} onClose={() => {}} />);
    // id.slice(0, 8)
    expect(screen.getByText("abcdef12")).toBeInTheDocument();
  });

  it("calls onClose from the close buttons and the backdrop", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listEvents).mockResolvedValue([]);

    const onClose = vi.fn();
    const { container } = renderModal(<TouchlessRationale invoice={invoice()} onClose={onClose} />);

    // Two "Close" controls: the icon-only X (aria-label) and the footer button.
    const closeButtons = screen.getAllByRole("button", { name: "Close" });
    expect(closeButtons.length).toBe(2);
    await user.click(closeButtons[0]);
    await user.click(closeButtons[1]);
    expect(onClose.mock.calls.length).toBeGreaterThanOrEqual(2);

    // backdrop click (the absolute-inset overlay div)
    const backdrop = container.querySelector(".bg-ink-950\\/55") as HTMLElement;
    await user.click(backdrop);
    expect(onClose.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

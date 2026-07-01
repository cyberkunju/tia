import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../src/api", () => ({
  api: {
    sapB1Payload: vi.fn(),
  },
}));

import { api } from "../../src/api";
import { SapB1Drawer } from "../../src/components/SapB1Drawer";
import type { SapB1PayloadResponse } from "../../src/types";

function renderDrawer(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const payload: SapB1PayloadResponse = {
  invoice_id: "inv-1",
  invoice_sequence_no: "TIA-INV-2026-0007",
  endpoint: "/b1s/v2/Invoices",
  payload: {
    CardCode: "CL001",
    CardName: "Emirates Steel",
    DocDate: "2026-06-01",
    DocDueDate: "2026-07-01",
    DocCurrency: "AED",
    NumAtCard: "TIA-INV-2026-0007",
    Comments: "TIA generated",
    U_TIA_AuditHash: "deadbeef",
    U_TIA_InvoiceId: "inv-1",
    U_TIA_Period: "June 2026",
    DocTotal: 1050,
    VatSum: 50,
    DocumentLines: [],
  },
};

// react-query v5 quirk: an `enabled`-gated query whose fetch *rejects* leaks a
// fire-and-forget rejection that Vitest flags as unhandled (the component still
// renders the error state correctly, but the suite fails). To exercise the
// error branch without that leak, we drive react-query's own internal error —
// returning `undefined` from the queryFn makes it error with
// "Query data cannot be undefined", which it handles internally. That lands in
// the component's generic error branch.
beforeEach(() => vi.mocked(api.sapB1Payload).mockReset());
afterEach(() => vi.clearAllMocks());

describe("SapB1Drawer", () => {
  it("is collapsed initially and does not fetch until expanded", () => {
    renderDrawer(<SapB1Drawer invoiceId="inv-1" />);
    expect(screen.getByText("SAP Business One payload")).toBeInTheDocument();
    expect(screen.getByText("POST /b1s/v2/Invoices")).toBeInTheDocument();
    expect(vi.mocked(api.sapB1Payload)).not.toHaveBeenCalled();
  });

  it("shows a loading state while generating the payload", async () => {
    const user = userEvent.setup();
    let resolve!: (v: SapB1PayloadResponse) => void;
    vi.mocked(api.sapB1Payload).mockReturnValue(new Promise((r) => { resolve = r; }));
    renderDrawer(<SapB1Drawer invoiceId="inv-1" />);
    await user.click(screen.getByRole("button", { name: /SAP Business One payload/ }));
    expect(await screen.findByText(/Generating payload/)).toBeInTheDocument();
    expect(vi.mocked(api.sapB1Payload)).toHaveBeenCalledWith("inv-1");
    // settle so the pending promise never dangles into the next test
    resolve(payload);
    await screen.findByText("TIA-INV-2026-0007");
  });

  it("renders the payload JSON and copies it to the clipboard", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    vi.mocked(api.sapB1Payload).mockResolvedValue(payload);
    renderDrawer(<SapB1Drawer invoiceId="inv-1" />);

    await user.click(screen.getByRole("button", { name: /SAP Business One payload/ }));
    expect(await screen.findByText("TIA-INV-2026-0007")).toBeInTheDocument();
    expect(screen.getByText(/"CardCode": "CL001"/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Copy JSON/ }));
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(payload.payload, null, 2));
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("shows a generic error message when the payload cannot be generated", async () => {
    const user = userEvent.setup();
    // queryFn resolving `undefined` makes react-query error internally (handled,
    // no unhandled rejection) → the component's generic error branch.
    vi.mocked(api.sapB1Payload).mockResolvedValue(undefined as never);
    renderDrawer(<SapB1Drawer invoiceId="inv-1" />);
    await user.click(screen.getByRole("button", { name: /SAP Business One payload/ }));
    expect(await screen.findByText(/Couldn't generate the SAP payload/)).toBeInTheDocument();
  });

  it("falls back to the invoice id when there is no sequence number", async () => {
    const user = userEvent.setup();
    vi.mocked(api.sapB1Payload).mockResolvedValue({ ...payload, invoice_sequence_no: null });
    renderDrawer(<SapB1Drawer invoiceId="inv-1" />);
    await user.click(screen.getByRole("button", { name: /SAP Business One payload/ }));
    // header echoes invoice_id when the sequence number is absent
    await waitFor(() => expect(screen.getAllByText("inv-1").length).toBeGreaterThan(0));
  });

  it("collapses again when toggled twice", async () => {
    const user = userEvent.setup();
    vi.mocked(api.sapB1Payload).mockResolvedValue(payload);
    renderDrawer(<SapB1Drawer invoiceId="inv-1" />);
    const toggle = screen.getByRole("button", { name: /SAP Business One payload/ });
    await user.click(toggle);
    expect(await screen.findByText("TIA-INV-2026-0007")).toBeInTheDocument();
    await user.click(toggle);
    expect(screen.queryByText(/"CardCode"/)).not.toBeInTheDocument();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../src/api", () => ({ api: { sapB1Payload: vi.fn() } }));

import { api } from "../../src/api";
import { SapB1Drawer } from "../../src/components/SapB1Drawer";

function renderDrawer(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  vi.mocked(api.sapB1Payload).mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("SapB1Drawer", () => {
  it("lazy-fetches on expand, renders the payload, and copies JSON", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    vi.mocked(api.sapB1Payload).mockResolvedValue({
      invoice_id: "inv-1",
      invoice_sequence_no: "TIA-INV-2026-0007",
      payload: { CardCode: "CL001", DocTotal: 1050 },
    } as never);

    renderDrawer(<SapB1Drawer invoiceId="inv-1" />);
    // Collapsed → no fetch yet.
    expect(vi.mocked(api.sapB1Payload)).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /SAP Business One payload/ }));
    await waitFor(() => expect(vi.mocked(api.sapB1Payload)).toHaveBeenCalledWith("inv-1"));
    expect(await screen.findByText("TIA-INV-2026-0007")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Copy JSON/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("shows the demo-reset hint for a 404 error", async () => {
    const user = userEvent.setup();
    vi.mocked(api.sapB1Payload).mockRejectedValue(new Error("404 Not Found on /invoices/x/sap-b1-payload"));
    renderDrawer(<SapB1Drawer invoiceId="inv-x" />);
    await user.click(screen.getByRole("button", { name: /SAP Business One payload/ }));
    expect(await screen.findByText(/no longer in the database/)).toBeInTheDocument();
  });

  it("shows a generic error message for a non-404 failure", async () => {
    const user = userEvent.setup();
    vi.mocked(api.sapB1Payload).mockRejectedValue(new Error("500 boom"));
    renderDrawer(<SapB1Drawer invoiceId="inv-y" />);
    await user.click(screen.getByRole("button", { name: /SAP Business One payload/ }));
    expect(await screen.findByText(/Couldn't generate the SAP payload/)).toBeInTheDocument();
  });

  it("falls back to invoice_id when there is no sequence number", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
    vi.mocked(api.sapB1Payload).mockResolvedValue({
      invoice_id: "inv-noseq",
      invoice_sequence_no: null,
      payload: { CardCode: "CL002" },
    } as never);
    renderDrawer(<SapB1Drawer invoiceId="inv-noseq" />);
    await user.click(screen.getByRole("button", { name: /SAP Business One payload/ }));
    expect(await screen.findByText("inv-noseq")).toBeInTheDocument();
  });
});

describe("SapB1Drawer — copy reset timer + empty payload", () => {
  it("resets the Copied state after the timeout", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    vi.mocked(api.sapB1Payload).mockResolvedValue({ invoice_id: "inv-1", invoice_sequence_no: "INV-1", payload: { a: 1 } } as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><SapB1Drawer invoiceId="inv-1" /></QueryClientProvider>);

    fireEvent.click(screen.getByRole("button", { name: /SAP Business One payload/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); // flush query
    fireEvent.click(screen.getByRole("button", { name: /Copy JSON/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); // flush clipboard promise
    expect(screen.getByText("Copied")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); }); // reset timer fires
    expect(screen.getByText("Copy JSON")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("renders nothing in the body when the payload resolves empty", async () => {
    const user = userEvent.setup();
    vi.mocked(api.sapB1Payload).mockResolvedValue(null as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><SapB1Drawer invoiceId="inv-2" /></QueryClientProvider>);
    await user.click(screen.getByRole("button", { name: /SAP Business One payload/ }));
    // no payload → neither loading, error, nor data → the `: null` branch
    expect(screen.queryByText(/Copy JSON/)).not.toBeInTheDocument();
  });
});

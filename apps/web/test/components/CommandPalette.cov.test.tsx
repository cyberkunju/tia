import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../src/api", () => ({
  api: { listDocs: vi.fn(), listClients: vi.fn(), demoReset: vi.fn() },
  API_BASE: "http://127.0.0.1:8000",
}));

import { api } from "../../src/api";
import { CommandPalette } from "../../src/components/CommandPalette";

function renderPalette(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(api.listDocs).mockReset().mockResolvedValue([
    { doc_id: "D1", client_code: null, period: null, channel: "email", status: "ingested" },
    { doc_id: "D2", client_code: "CL001", period: "2026-06", channel: "upload", status: "dispatched" },
  ] as never);
  vi.mocked(api.listClients).mockReset().mockResolvedValue([
    { code: "CL001", name: "Emirates Steel", industry: "Steel", settings: {} },
  ] as never);
  vi.mocked(api.demoReset).mockReset().mockResolvedValue({ status: "ok", wiped: {} });
});
afterEach(() => vi.clearAllMocks());

describe("CommandPalette — docs/clients search + run action", () => {
  it("matches documents (with null client/period) and clients on a query", async () => {
    const user = userEvent.setup();
    renderPalette(<CommandPalette open onClose={() => {}} />);
    // search "email" → the email doc (with null client_code/period → fallbacks) surfaces
    await user.type(await screen.findByPlaceholderText(/Search documents/), "email");
    expect(await screen.findByText(/Unknown ·/)).toBeInTheDocument();
  });

  it("surfaces clients on a name query", async () => {
    const user = userEvent.setup();
    renderPalette(<CommandPalette open onClose={() => {}} />);
    await user.type(await screen.findByPlaceholderText(/Search documents/), "Emirates");
    expect(await screen.findByText(/CL001 · Emirates Steel/)).toBeInTheDocument();
  });

  it("runs the Reset demo action (api.demoReset + reload) and closes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, reload },
      configurable: true,
      writable: true,
    });
    renderPalette(<CommandPalette open onClose={onClose} />);
    await user.click(await screen.findByRole("button", { name: /Reset demo data/ }));
    await waitFor(() => expect(vi.mocked(api.demoReset)).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("CommandPalette — pending queries + empty results", () => {
  it("uses the `?? []` fallbacks while docs/clients are still loading", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listDocs).mockReturnValue(new Promise(() => {}) as never);
    vi.mocked(api.listClients).mockReturnValue(new Promise(() => {}) as never);
    renderPalette(<CommandPalette open onClose={() => {}} />);
    // typing while docs/clients are undefined → (docs ?? []) / (clients ?? []) run
    await user.type(await screen.findByPlaceholderText(/Search documents/), "review");
    // still matches an ACTION (no crash)
    expect(screen.getByText("Review")).toBeInTheDocument();
  });

  it("Enter on a no-match query calls go(undefined) safely", async () => {
    const user = userEvent.setup();
    renderPalette(<CommandPalette open onClose={() => {}} />);
    const input = await screen.findByPlaceholderText(/Search documents/);
    await user.type(input, "zzzznomatchzzzz");
    expect(await screen.findByText("No matches.")).toBeInTheDocument();
    await user.type(input, "{Enter}"); // go(results[0]) === go(undefined) → early return
    expect(screen.getByText("No matches.")).toBeInTheDocument();
  });
});

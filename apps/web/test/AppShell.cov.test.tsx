import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("../src/api", () => ({
  api: {
    listClients: vi.fn(),
    listDocs: vi.fn(),
    demoReset: vi.fn(),
    qaStream: vi.fn(),
    status: vi.fn(),
  },
  API_BASE: "http://127.0.0.1:8000",
}));

import { api } from "../src/api";
import { AppShell } from "../src/AppShell";
import { usePersona } from "../src/store";

function renderShell(node: ReactElement, entry = "/portal") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route element={node}>
            <Route path="/console" element={<div>console-outlet</div>} />
            <Route path="/portal" element={<div>portal-outlet</div>} />
            <Route path="/finance" element={<div>finance-outlet</div>} />
          </Route>
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  usePersona.setState({ persona: "finops", currentClientCode: null, aidaOpen: false, resetTick: 0, focusedEntity: null });
  vi.mocked(api.listClients).mockReset().mockResolvedValue([
    { code: "CL001", name: "Emirates Steel", city: "AUH", industry: "Steel", settings: {} },
    { code: "CL002", name: "Dubai Co", city: "DXB", industry: "Logistics", settings: {} },
  ]);
  vi.mocked(api.listDocs).mockReset().mockResolvedValue([]);
  vi.mocked(api.demoReset).mockReset().mockResolvedValue({ status: "ok", wiped: {} });
  vi.mocked(api.qaStream).mockReset().mockImplementation((async function* () {
    /* no events */
  }) as unknown as typeof api.qaStream);
});
afterEach(() => vi.clearAllMocks());

describe("AppShell — ActingAsPicker", () => {
  it("loads clients into the picker (null current code) and commits a selection", async () => {
    const user = userEvent.setup();
    usePersona.setState({ persona: "client", currentClientCode: null });
    renderShell(<AppShell />, "/portal");

    // Placeholder flips from "Loading…" to "Select client" once clients load.
    const picker = await screen.findByLabelText(/acting on behalf/i);
    await waitFor(() => expect(picker).toHaveTextContent("Select client"));

    // Open the picker and choose CL002 → onChange → setCurrentClientCode.
    await user.click(picker);
    await user.click(await screen.findByRole("option", { name: /CL002 · Dubai Co/ }));
    await waitFor(() => expect(usePersona.getState().currentClientCode).toBe("CL002"));
  });

  it("resets the current client to null when an empty-code option is chosen", async () => {
    const user = userEvent.setup();
    usePersona.setState({ persona: "client", currentClientCode: "CL001" });
    vi.mocked(api.listClients).mockResolvedValue([
      { code: "", name: "Unassigned", city: "", industry: "", settings: {} },
      { code: "CL001", name: "Emirates Steel", city: "AUH", industry: "Steel", settings: {} },
    ] as never);
    renderShell(<AppShell />, "/portal");
    const picker = await screen.findByLabelText(/acting on behalf/i);
    await user.click(picker);
    // choosing the empty-code option → onChange("") → `"" || null` → null
    await user.click(await screen.findByRole("option", { name: /Unassigned/ }));
    await waitFor(() => expect(usePersona.getState().currentClientCode).toBeNull());
  });
});

describe("AppShell — palette + chat close paths", () => {
  it("closes the command palette when Escape is pressed at the window", async () => {
    const user = userEvent.setup();
    renderShell(<AppShell />, "/console");
    await user.keyboard("{Control>}k{/Control}");
    expect(await screen.findByPlaceholderText(/Search documents, clients/)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/Search documents, clients/)).not.toBeInTheDocument(),
    );
  });

  it("invokes the palette's onClose when its backdrop is clicked", async () => {
    const user = userEvent.setup();
    renderShell(<AppShell />, "/console");
    await user.click(screen.getByRole("button", { name: /Search documents, clients/ }));
    const input = await screen.findByPlaceholderText(/Search documents, clients/);
    // The palette overlay carries onMouseDown={onClose} (AppShell's setPaletteOpen(false)).
    const overlay = input.closest(".fixed") as HTMLElement;
    fireEvent.mouseDown(overlay);
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/Search documents, clients/)).not.toBeInTheDocument(),
    );
  });

  it("invokes the Assistant's onClose from its close button", async () => {
    const user = userEvent.setup();
    usePersona.setState({ aidaOpen: true });
    renderShell(<AppShell />, "/console");
    await user.click(await screen.findByRole("button", { name: "Close chat" }));
    await waitFor(() => expect(usePersona.getState().aidaOpen).toBe(false));
  });
});

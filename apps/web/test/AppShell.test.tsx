import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

vi.mock("../src/api", () => ({
  api: {
    listClients: vi.fn(),
    listDocs: vi.fn(),
    demoReset: vi.fn(),
    qaStream: vi.fn(),
  },
  API_BASE: "http://127.0.0.1:8000",
}));

import { api } from "../src/api";
import { AppShell } from "../src/AppShell";
import { usePersona } from "../src/store";

const loc = { value: "" };
function LocationProbe() {
  loc.value = useLocation().pathname;
  return null;
}

function renderShell(node: ReactElement, entry = "/console") {
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
        <LocationProbe />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  loc.value = "";
  usePersona.setState({ persona: "finops", currentClientCode: "CL001", aidaOpen: false, resetTick: 0, focusedEntity: null });
  vi.mocked(api.listClients).mockReset().mockResolvedValue([{ code: "CL001", name: "Emirates Steel", city: "AUH", industry: "Steel", settings: {} }]);
  vi.mocked(api.listDocs).mockReset().mockResolvedValue([]);
  vi.mocked(api.demoReset).mockReset().mockResolvedValue({ status: "ok", wiped: {} });
});
afterEach(() => vi.clearAllMocks());

describe("AppShell", () => {
  it("renders the header chrome, persona toggles and the routed outlet", () => {
    renderShell(<AppShell />);
    expect(screen.getByText("console-outlet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "FinOps" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Client" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finance" })).toBeInTheDocument();
    // FinOps persona → no acting-as picker
    expect(screen.queryByLabelText(/acting on behalf/i)).not.toBeInTheDocument();
  });

  it("switches persona and navigates to that persona's home", async () => {
    const user = userEvent.setup();
    renderShell(<AppShell />);
    await user.click(screen.getByRole("button", { name: "Finance" }));
    await waitFor(() => expect(loc.value).toBe("/finance"));
  });

  it("shows the acting-as client picker for the client persona", async () => {
    usePersona.setState({ persona: "client", currentClientCode: "CL001" });
    renderShell(<AppShell />, "/portal");
    expect(await screen.findByLabelText(/acting on behalf/i)).toBeInTheDocument();
  });

  it("opens the command palette with Ctrl+K", async () => {
    const user = userEvent.setup();
    renderShell(<AppShell />);
    await user.keyboard("{Control>}k{/Control}");
    expect(await screen.findByPlaceholderText(/Search documents, clients/)).toBeInTheDocument();
  });

  it("opens the command palette by clicking the search bar", async () => {
    const user = userEvent.setup();
    renderShell(<AppShell />);
    await user.click(screen.getByRole("button", { name: /Search documents, clients/ }));
    expect(await screen.findByPlaceholderText(/Search documents, clients/)).toBeInTheDocument();
  });

  it("opens the AIDA chat via the floating launcher", async () => {
    const user = userEvent.setup();
    renderShell(<AppShell />);
    await user.click(screen.getByRole("button", { name: "Open TIA chat" }));
    await waitFor(() => expect(usePersona.getState().aidaOpen).toBe(true));
  });

  it("resets the demo data and returns to the portal", async () => {
    const user = userEvent.setup();
    renderShell(<AppShell />);
    await user.click(screen.getByRole("button", { name: /Reset demo/ }));
    await waitFor(() => expect(vi.mocked(api.demoReset)).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(loc.value).toBe("/portal"));
  });
});

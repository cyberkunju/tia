import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../src/api", () => ({
  api: {
    listDocs: vi.fn(),
    listClients: vi.fn(),
    demoReset: vi.fn(),
  },
}));

import { api } from "../../src/api";
import { CommandPalette } from "../../src/components/CommandPalette";

const loc = { value: "" };
function LocationProbe() {
  const l = useLocation();
  loc.value = l.pathname + l.search;
  return null;
}

function renderPalette(open: boolean, onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={["/"]}>
      <QueryClientProvider client={qc}>
        <CommandPalette open={open} onClose={onClose} />
        <LocationProbe />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { onClose };
}

beforeEach(() => {
  loc.value = "";
  vi.mocked(api.listDocs).mockReset().mockResolvedValue([]);
  vi.mocked(api.listClients).mockReset().mockResolvedValue([]);
  vi.mocked(api.demoReset).mockReset().mockResolvedValue({ status: "ok", wiped: {} });
});
afterEach(() => vi.clearAllMocks());

describe("CommandPalette", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <CommandPalette open={false} onClose={() => {}} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();
    expect(vi.mocked(api.listDocs)).not.toHaveBeenCalled();
  });

  it("lists grouped actions when open", () => {
    renderPalette(true);
    expect(screen.getByText("Console")).toBeInTheDocument();
    expect(screen.getByText("Configure")).toBeInTheDocument();
    expect(screen.getByText("Portal")).toBeInTheDocument();
    expect(screen.getByText("Finance")).toBeInTheDocument();
    expect(screen.getByText("Reset demo data")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Search documents, clients/)).toBeInTheDocument();
  });

  it("filters actions by the typed query", async () => {
    const user = userEvent.setup();
    renderPalette(true);
    await user.type(screen.getByRole("textbox"), "validated");
    expect(screen.getByText("Validated")).toBeInTheDocument();
    expect(screen.queryByText("Intake")).not.toBeInTheDocument();
  });

  it("shows a no-matches message for an unknown query", async () => {
    const user = userEvent.setup();
    renderPalette(true);
    await user.type(screen.getByRole("textbox"), "zzzznomatch");
    expect(screen.getByText("No matches.")).toBeInTheDocument();
  });

  it("surfaces matching documents and clients from the API", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listDocs).mockResolvedValue([
      { doc_id: "DOC1", channel: "email", mime: null, uploaded_at: null, uploaded_by: null, timesheet_id: null, status: "ingested", routing: null, confidence: null, client_code: "CL001", period: "June 2026" },
    ]);
    vi.mocked(api.listClients).mockResolvedValue([
      { code: "CL001", name: "Emirates Steel", city: "Abu Dhabi", industry: "Steel", settings: {} },
    ]);
    renderPalette(true);
    // wait for the enabled queries to resolve
    await waitFor(() => expect(vi.mocked(api.listDocs)).toHaveBeenCalled());
    await user.type(screen.getByRole("textbox"), "cl001");

    expect(await screen.findByText("Documents")).toBeInTheDocument();
    expect(screen.getByText("Clients")).toBeInTheDocument();
    expect(screen.getByText("CL001 · Emirates Steel")).toBeInTheDocument();
  });

  it("navigates and closes when an item is clicked", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPalette(true);
    await user.click(screen.getByText("Intake"));
    expect(loc.value).toBe("/console?stage=intake");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("navigates via keyboard (arrow + enter)", async () => {
    const user = userEvent.setup();
    renderPalette(true);
    const input = screen.getByRole("textbox");
    input.focus();
    await user.keyboard("{ArrowDown}{Enter}");
    // second action in the list is "Review"
    expect(loc.value).toBe("/console?stage=review");
  });

  it("runs the reset-demo action", async () => {
    const user = userEvent.setup();
    const reloadSpy = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, reload: reloadSpy },
      configurable: true,
    });
    const { onClose } = renderPalette(true);
    await user.click(screen.getByText("Reset demo data"));
    expect(vi.mocked(api.demoReset)).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

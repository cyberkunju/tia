import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../src/api", () => ({
  api: { listDocs: vi.fn(), listClients: vi.fn(), demoReset: vi.fn() },
}));

import { api } from "../../src/api";
import { CommandPalette } from "../../src/components/CommandPalette";

const loc = { value: "" };
function LocationProbe() {
  const l = useLocation();
  loc.value = l.pathname + l.search;
  return null;
}

function renderPalette() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={["/"]}>
      <QueryClientProvider client={qc}>
        <CommandPalette open onClose={vi.fn()} />
        <LocationProbe />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  loc.value = "";
  vi.mocked(api.listDocs).mockReset().mockResolvedValue([]);
  vi.mocked(api.listClients).mockReset().mockResolvedValue([]);
});
afterEach(() => vi.clearAllMocks());

describe("CommandPalette — extra branches", () => {
  it("moves the active row back up with ArrowUp before Enter", async () => {
    const user = userEvent.setup();
    renderPalette();
    const input = screen.getByRole("textbox");
    input.focus();
    // down to index 1, back up to 0, enter → first action (Intake)
    await user.keyboard("{ArrowDown}{ArrowUp}{Enter}");
    expect(loc.value).toBe("/console?stage=intake");
  });

  it("labels a document with null client_code/period via the Unknown/- fallbacks", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listDocs).mockResolvedValue([
      { doc_id: "DOCX", channel: "email", mime: null, uploaded_at: null, uploaded_by: null, timesheet_id: null, status: "ingested", routing: null, confidence: null, client_code: null, period: null },
    ]);
    renderPalette();
    await waitFor(() => expect(vi.mocked(api.listDocs)).toHaveBeenCalled());
    // match on channel text ("email") since client_code/period are null
    await user.type(screen.getByRole("textbox"), "email");
    expect(await screen.findByText("Documents")).toBeInTheDocument();
    expect(screen.getByText("Unknown · -")).toBeInTheDocument();
  });
});

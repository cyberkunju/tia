import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../src/api", () => ({
  api: { listClients: vi.fn(), uploadFile: vi.fn(), submitEmail: vi.fn(), getDoc: vi.fn() },
  API_BASE: "http://127.0.0.1:8000",
}));

import { api } from "../../src/api";
import { ClientSubmit } from "../../src/pages/ClientSubmit";
import { usePersona } from "../../src/store";

function renderPage(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={["/portal/submit"]}>
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  usePersona.setState({ persona: "client", currentClientCode: "CL001", resetTick: 0, aidaOpen: false, focusedEntity: null });
  vi.mocked(api.listClients).mockReset().mockResolvedValue([{ code: "CL001", name: "Emirates Steel", settings: {} }] as never);
  vi.mocked(api.getDoc).mockReset().mockResolvedValue({
    doc: { id: "doc-1", channel: "portal", mime: "text/plain", filename: "t.txt", uploaded_at: "", uploaded_by: "client" },
    timesheet: null, invoices: [],
  } as never);
});
afterEach(() => vi.clearAllMocks());

describe("ClientSubmit — typed email + pending state", () => {
  it("types into the subject/body fields and shows the submitting indicator", async () => {
    const user = userEvent.setup();
    let resolve!: (v: unknown) => void;
    vi.mocked(api.submitEmail).mockReturnValue(new Promise((r) => { resolve = r; }) as never);

    renderPage(<ClientSubmit />);
    await screen.findByText(/Submit timesheet/);
    await user.click(screen.getByRole("button", { name: "Email body" }));

    // Type directly (exercises the subject input + body textarea onChange handlers).
    await user.type(screen.getByPlaceholderText("Optional"), "My subject");
    await user.type(screen.getByPlaceholderText(/Paste the email body/), "Some body content");

    const submit = screen.getByRole("button", { name: /Submit/ });
    await user.click(submit);
    // pending branch → "Submitting…"
    expect(await screen.findByText("Submitting…")).toBeInTheDocument();

    await act(async () => { resolve({ doc_id: "doc-1", timesheet_id: "t", status: "ok", routing: "auto", confidence: 0.9 }); });
  });
});

import { fireEvent } from "@testing-library/react";

describe("ClientSubmit — file input with no file selected", () => {
  it("does nothing when the file input change carries no file", async () => {
    const { container } = renderPage(<ClientSubmit />);
    await screen.findByText(/Submit timesheet/);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    // change event with an empty file list → `e.target.files?.[0]` is undefined → if (f) is false
    fireEvent.change(input, { target: { files: [] } });
    expect(vi.mocked(api.uploadFile)).not.toHaveBeenCalled();
  });
});

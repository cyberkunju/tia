import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// UploadReceipt (mounted on success) also imports API_BASE + api.getDoc, so the
// mock must cover it. All other methods are what ClientSubmit itself calls.
vi.mock("../../src/api", () => ({
  api: {
    listClients: vi.fn(),
    uploadFile: vi.fn(),
    submitEmail: vi.fn(),
    getDoc: vi.fn(),
  },
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

const okResult = { doc_id: "doc-1", timesheet_id: "ts-1", status: "invoice_generated", routing: "auto", confidence: 0.95 };

beforeEach(() => {
  usePersona.setState({ persona: "client", currentClientCode: "CL001", resetTick: 0, aidaOpen: false, focusedEntity: null });
  vi.mocked(api.listClients).mockResolvedValue([
    { code: "CL001", name: "Emirates Steel", city: "AUH", industry: "Steel", settings: {} },
  ]);
  // UploadReceipt's poll — a minimal doc keeps it in the "Working on it…" state.
  vi.mocked(api.getDoc).mockResolvedValue({
    doc: { id: "doc-1", channel: "portal", mime: "text/plain", filename: "t.txt", uploaded_at: "", uploaded_by: "client" },
    timesheet: null,
    invoices: [],
  });
});
afterEach(() => vi.clearAllMocks());

describe("ClientSubmit page", () => {
  it("renders the client-scoped header once clients load", async () => {
    renderPage(<ClientSubmit />);
    expect(await screen.findByText("Submit timesheet · Emirates Steel")).toBeInTheDocument();
    // On-behalf-of hint shows the client code.
    expect(screen.getByText("CL001")).toBeInTheDocument();
    // Pipeline explainer + channels render.
    expect(screen.getByText("How TIA processes this")).toBeInTheDocument();
    expect(screen.getByText("WhatsApp")).toBeInTheDocument();
  });

  it("falls back to a generic header when no client is selected", async () => {
    usePersona.setState({ currentClientCode: null });
    vi.mocked(api.listClients).mockResolvedValue([]);
    renderPage(<ClientSubmit />);
    expect(await screen.findByText("Submit timesheet")).toBeInTheDocument();
  });

  it("uploads a selected file and mounts the receipt", async () => {
    const user = userEvent.setup();
    vi.mocked(api.uploadFile).mockResolvedValue(okResult);
    const { container } = renderPage(<ClientSubmit />);
    await screen.findByText(/Submit timesheet/);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["hi"], "sheet.csv", { type: "text/csv" });
    await user.upload(input, file);

    await waitFor(() => expect(vi.mocked(api.uploadFile)).toHaveBeenCalledWith(file));
    // UploadReceipt mounted → shows its live headline.
    expect(await screen.findByText("Working on it…")).toBeInTheDocument();
  });

  it("shows a processing indicator while an upload is in flight", async () => {
    const user = userEvent.setup();
    let resolve!: (v: typeof okResult) => void;
    vi.mocked(api.uploadFile).mockReturnValue(new Promise((r) => { resolve = r; }));
    const { container } = renderPage(<ClientSubmit />);
    await screen.findByText(/Submit timesheet/);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(["x"], "a.csv", { type: "text/csv" }));

    expect(await screen.findByText("Processing…")).toBeInTheDocument();
    await act(async () => { resolve(okResult); });
    await screen.findByText("Working on it…");
  });

  it("submits an email body via a sample and clears the disabled state", async () => {
    const user = userEvent.setup();
    vi.mocked(api.submitEmail).mockResolvedValue({ ...okResult, intake_mode: "direct" });
    renderPage(<ClientSubmit />);
    await screen.findByText(/Submit timesheet/);

    await user.click(screen.getByRole("button", { name: "Email body" }));
    const submit = screen.getByRole("button", { name: /Submit/ });
    expect(submit).toBeDisabled();

    // A sample button fills subject + body.
    await user.click(screen.getByRole("button", { name: "Client roster" }));
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() => expect(vi.mocked(api.submitEmail)).toHaveBeenCalledTimes(1));
    const [body, subject] = vi.mocked(api.submitEmail).mock.calls[0];
    expect(subject).toBe("Client roster");
    expect(body).toContain("Emirates Steel Industries LLC");
    expect(await screen.findByText("Working on it…")).toBeInTheDocument();
  });

  it("wipes local state when Reset Demo bumps the reset tick", async () => {
    const user = userEvent.setup();
    renderPage(<ClientSubmit />);
    await screen.findByText(/Submit timesheet/);

    await user.click(screen.getByRole("button", { name: "Email body" }));
    await user.click(screen.getByRole("button", { name: "Leave + reimbursements" }));
    const bodyField = screen.getByPlaceholderText(/Paste the email body/) as HTMLTextAreaElement;
    expect(bodyField.value).not.toBe("");

    // Reset Demo increments resetTick; the effect clears body/subject/result and
    // flips back to the upload tab.
    act(() => usePersona.getState().bumpReset());

    await waitFor(() => expect(screen.queryByPlaceholderText(/Paste the email body/)).not.toBeInTheDocument());
    // Back on the upload tab.
    expect(screen.getByText("Click to select a file")).toBeInTheDocument();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../src/api", () => ({
  api: { listClients: vi.fn(), listQueries: vi.fn(), raiseQuery: vi.fn(), replyToQuery: vi.fn() },
}));

import { api } from "../../src/api";
import { ClientQueries } from "../../src/pages/ClientQueries";
import { usePersona } from "../../src/store";

function renderPage(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={["/portal/queries"]}>
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  usePersona.setState({ persona: "client", currentClientCode: "CL001" });
  vi.mocked(api.listClients).mockReset().mockResolvedValue([
    { code: "CL001", name: "Emirates Steel", industry: "Steel", settings: {} },
  ] as never);
  vi.mocked(api.replyToQuery).mockReset().mockResolvedValue({ id: "Q1", status: "answered", thread: [] } as never);
  vi.mocked(api.raiseQuery).mockReset().mockResolvedValue({ id: "Q2", status: "open", client_code: "CL001" } as never);
});
afterEach(() => vi.clearAllMocks());

describe("ClientQueries — thread rendering + reply", () => {
  it("renders a closed thread with a body and replies via Enter", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listQueries).mockResolvedValue([
      {
        id: "Q1", subject: "Overtime dispute", status: "closed", raised_by: "ops", raised_at: "2026-06-01T10:00:00Z",
        body: "Why the OT?", thread: [{ role: "finops", by: "alice", body: "Checked, it's correct." }],
      },
    ] as never);
    renderPage(<ClientQueries />);

    expect(await screen.findByText("Overtime dispute")).toBeInTheDocument();
    expect(screen.getByText("closed")).toBeInTheDocument();
    expect(screen.getByText("Why the OT?")).toBeInTheDocument();

    const reply = screen.getByPlaceholderText("Reply…");
    await user.type(reply, "thanks{Enter}");
    await waitFor(() => expect(vi.mocked(api.replyToQuery)).toHaveBeenCalledWith("Q1", { body: "thanks", by_user: "client" }));
  });

  it("raises a new query", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listQueries).mockResolvedValue([] as never);
    renderPage(<ClientQueries />);
    await screen.findByText("No queries yet");
    await user.type(screen.getByPlaceholderText(/Overtime on invoice/), "New question");
    await user.type(screen.getByPlaceholderText(/Describe the question/), "details here");
    await user.click(screen.getByRole("button", { name: /Submit/ }));
    await waitFor(() => expect(vi.mocked(api.raiseQuery)).toHaveBeenCalled());
  });
});

describe("ClientQueries — raised_by fallback + raise pending", () => {
  it("renders a body from a thread with no raised_by (falls back to 'client')", async () => {
    vi.mocked(api.listQueries).mockResolvedValue([
      { id: "Q1", subject: "Q", status: "open", raised_by: null, raised_at: "2026-06-01T10:00:00Z", body: "the body text", thread: [] },
    ] as never);
    renderPage(<ClientQueries />);
    expect(await screen.findByText("the body text")).toBeInTheDocument();
  });

  it("shows the spinner while a raise is in flight", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listQueries).mockResolvedValue([] as never);
    vi.mocked(api.raiseQuery).mockReturnValue(new Promise(() => {}) as never); // pending
    renderPage(<ClientQueries />);
    await screen.findByText("No queries yet");
    await user.type(screen.getByPlaceholderText(/Overtime on invoice/), "subject");
    await user.click(screen.getByRole("button", { name: /Submit/ }));
    // Submit button disabled while pending
    await waitFor(() => expect(screen.getByRole("button", { name: /Submit/ })).toBeDisabled());
  });
});

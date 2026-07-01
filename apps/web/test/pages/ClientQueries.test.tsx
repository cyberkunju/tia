import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../src/api", () => ({
  api: {
    listClients: vi.fn(),
    listQueries: vi.fn(),
    raiseQuery: vi.fn(),
    replyToQuery: vi.fn(),
  },
}));

import { api } from "../../src/api";
import { ClientQueries } from "../../src/pages/ClientQueries";
import { usePersona } from "../../src/store";
import type { QueryThread } from "../../src/types";

function renderPage(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const ISO = "2026-06-01T10:00:00Z";
const thread = (over: Partial<QueryThread> = {}): QueryThread => ({
  id: "q1",
  subject: "Overtime question",
  body: "Why was OT billed?",
  status: "open",
  invoice_id: null,
  raised_by: "client",
  raised_at: ISO,
  thread: [],
  ...over,
});

beforeEach(() => {
  usePersona.setState({ persona: "client", currentClientCode: "CL001", resetTick: 0, aidaOpen: false, focusedEntity: null });
  vi.mocked(api.listClients).mockResolvedValue([
    { code: "CL001", name: "Alpha", city: "AUH", industry: "x", settings: {} },
    { code: "CL002", name: "Beta", city: "DXB", industry: "y", settings: {} },
  ]);
  vi.mocked(api.raiseQuery).mockResolvedValue({ id: "new", status: "open", client_code: "CL001" });
  vi.mocked(api.replyToQuery).mockResolvedValue({ id: "q1", status: "answered", thread: [] });
});
afterEach(() => vi.clearAllMocks());

describe("ClientQueries page", () => {
  it("shows the loading spinner while threads are fetched", async () => {
    vi.mocked(api.listQueries).mockReturnValue(new Promise<QueryThread[]>(() => {}));
    renderPage(<ClientQueries />);
    expect(await screen.findByText("Loading…")).toBeInTheDocument();
  });

  it("shows the empty state when the client has no queries", async () => {
    vi.mocked(api.listQueries).mockResolvedValue([]);
    renderPage(<ClientQueries />);
    expect(await screen.findByText("No queries yet")).toBeInTheDocument();
    expect(vi.mocked(api.listQueries)).toHaveBeenCalledWith("CL001");
  });

  it("renders threads with status badges and both bubble roles", async () => {
    vi.mocked(api.listQueries).mockResolvedValue([
      thread({ id: "q1", subject: "Overtime", status: "open", body: "why OT?", thread: [{ by: "finops", role: "finops", body: "looking into it", at: ISO }] }),
      thread({ id: "q2", subject: "VAT check", status: "answered", body: null, thread: [] }),
      thread({ id: "q3", subject: "Old one", status: "closed", body: "done", thread: [] }),
    ]);
    renderPage(<ClientQueries />);

    expect(await screen.findByText("Overtime")).toBeInTheDocument();
    // Each status renders its own badge label.
    expect(screen.getByText("open")).toBeInTheDocument();
    expect(screen.getByText("answered")).toBeInTheDocument();
    expect(screen.getByText("closed")).toBeInTheDocument();
    // Client bubble (q.body) and finops reply bubble both render.
    expect(screen.getByText("why OT?")).toBeInTheDocument();
    expect(screen.getByText("looking into it")).toBeInTheDocument();
  });

  it("raises a query and clears the form on success", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listQueries).mockResolvedValue([]);
    renderPage(<ClientQueries />);
    await screen.findByText("No queries yet");

    const submit = screen.getByRole("button", { name: /Submit/ });
    expect(submit).toBeDisabled();

    const subject = screen.getByPlaceholderText(/Overtime on invoice/);
    await user.type(subject, "Billing question");
    await user.type(screen.getByPlaceholderText(/Describe the question/), "Please clarify");
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() =>
      expect(vi.mocked(api.raiseQuery)).toHaveBeenCalledWith("CL001", { subject: "Billing question", body: "Please clarify", raised_by: "client" }),
    );
    // Fields reset after the mutation resolves.
    await waitFor(() => expect((subject as HTMLInputElement).value).toBe(""));
  });

  it("replies to a thread when the send button is clicked", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listQueries).mockResolvedValue([thread({ id: "q1", subject: "Overtime" })]);
    renderPage(<ClientQueries />);

    const section = (await screen.findByText("Overtime")).closest("section")!;
    const replyInput = within(section).getByPlaceholderText("Reply…");
    await user.type(replyInput, "Thanks");
    await user.click(within(section).getByRole("button", { name: "" }));

    await waitFor(() =>
      expect(vi.mocked(api.replyToQuery)).toHaveBeenCalledWith("q1", { body: "Thanks", by_user: "client" }),
    );
  });

  it("submits a reply on Enter", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listQueries).mockResolvedValue([thread({ id: "q9", subject: "Enter thread" })]);
    renderPage(<ClientQueries />);

    const section = (await screen.findByText("Enter thread")).closest("section")!;
    await user.type(within(section).getByPlaceholderText("Reply…"), "via enter{Enter}");

    await waitFor(() =>
      expect(vi.mocked(api.replyToQuery)).toHaveBeenCalledWith("q9", { body: "via enter", by_user: "client" }),
    );
  });

  it("falls back to the first client's code when no persona client is set", async () => {
    usePersona.setState({ currentClientCode: null });
    vi.mocked(api.listQueries).mockResolvedValue([]);
    renderPage(<ClientQueries />);
    // code = clients?.[0]?.code === "CL001"
    await waitFor(() => expect(vi.mocked(api.listQueries)).toHaveBeenCalledWith("CL001"));
  });

  it("lets the user override the client via the picker", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listQueries).mockResolvedValue([]);
    renderPage(<ClientQueries />);
    await screen.findByText("No queries yet");

    await user.click(screen.getByRole("button", { name: "Select client" }));
    await user.click(await screen.findByText("CL002 · Beta"));

    await waitFor(() => expect(vi.mocked(api.listQueries)).toHaveBeenCalledWith("CL002"));
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../src/api", () => ({
  api: { qaStream: vi.fn() },
}));

import { api } from "../../src/api";
import { Assistant } from "../../src/components/Assistant";
import { usePersona } from "../../src/store";
import type { QaStreamEvent } from "../../src/types";

// Build an async generator that yields the given SSE-decoded events.
function streamOf(events: QaStreamEvent[]) {
  return async function* () {
    for (const e of events) yield e;
  };
}

function renderPanel(node: ReactElement, entry = "/console") {
  return render(<MemoryRouter initialEntries={[entry]}>{node}</MemoryRouter>);
}

beforeEach(() => {
  usePersona.setState({ persona: "finops", currentClientCode: null, aidaOpen: true, focusedEntity: null });
  vi.mocked(api.qaStream).mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("Assistant (AIDA panel)", () => {
  it("renders nothing when closed", () => {
    const { container } = renderPanel(<Assistant open={false} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the empty state with icebreaker cards when open", () => {
    renderPanel(<Assistant open onClose={() => {}} />);
    expect(screen.getByText("Ask TIA anything")).toBeInTheDocument();
    // FinOps route icebreaker
    expect(screen.getByRole("button", { name: /Awaiting review/ })).toBeInTheDocument();
  });

  it("streams a full answer: tool strip, tokens, citations and model", async () => {
    const user = userEvent.setup();
    vi.mocked(api.qaStream).mockImplementation(
      streamOf([
        { type: "tool", name: "verify_audit_chain", args: { limit: 5 }, status: "running" },
        { type: "tool", name: "verify_audit_chain", args: { limit: 5 }, status: "done", result_summary: "ok" },
        { type: "token", content: "Hello " },
        { type: "token", content: "world" },
        { type: "done", model: "gpt-x", citations: [{ kind: "invoice", id: "abcdef123456" }], tool_calls_summary: [] },
      ]) as unknown as typeof api.qaStream,
    );

    renderPanel(<Assistant open onClose={() => {}} />);
    await user.type(screen.getByPlaceholderText(/Ask TIA/), "verify chain");
    await user.keyboard("{Enter}");

    expect(await screen.findByText("Hello world")).toBeInTheDocument();
    expect(screen.getByText(/called 1 tool/)).toBeInTheDocument();
    expect(screen.getByText("verify_audit_chain")).toBeInTheDocument();
    expect(screen.getByText("gpt-x")).toBeInTheDocument();
    // citation chip
    expect(screen.getByText("abcdef12")).toBeInTheDocument();
    // The user's message bubble
    expect(screen.getByText("verify chain")).toBeInTheDocument();

    // qaStream called with the question and finops (no client scope)
    expect(vi.mocked(api.qaStream)).toHaveBeenCalledWith(
      "verify chain", undefined, null, expect.anything(), [],
    );
  });

  it("renders an error event verbatim", async () => {
    const user = userEvent.setup();
    vi.mocked(api.qaStream).mockImplementation(
      streamOf([{ type: "error", message: "model down" }]) as unknown as typeof api.qaStream,
    );
    renderPanel(<Assistant open onClose={() => {}} />);
    await user.type(screen.getByPlaceholderText(/Ask TIA/), "hi");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/TIA couldn't answer this one: model down/)).toBeInTheDocument();
  });

  it("surfaces a transport error when the stream throws", async () => {
    const user = userEvent.setup();
    vi.mocked(api.qaStream).mockImplementation(
      (async function* () {
        throw new Error("boom");
        // eslint-disable-next-line no-unreachable
        yield { type: "token", content: "" } as QaStreamEvent;
      }) as unknown as typeof api.qaStream,
    );
    renderPanel(<Assistant open onClose={() => {}} />);
    await user.type(screen.getByPlaceholderText(/Ask TIA/), "hi");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/Network error reaching TIA: boom/)).toBeInTheDocument();
  });

  it("sends an icebreaker prompt on click and clears the conversation with New chat", async () => {
    const user = userEvent.setup();
    vi.mocked(api.qaStream).mockImplementation(
      streamOf([{ type: "token", content: "answer" }, { type: "done", model: "m", citations: [], tool_calls_summary: [] }]) as unknown as typeof api.qaStream,
    );
    renderPanel(<Assistant open onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: /Awaiting review/ }));
    expect(await screen.findByText("answer")).toBeInTheDocument();
    expect(vi.mocked(api.qaStream)).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(screen.getByText("Ask TIA anything")).toBeInTheDocument());
  });

  it("scopes to the client and shows the isolation banner for the client persona", async () => {
    usePersona.setState({ persona: "client", currentClientCode: "CL001", aidaOpen: true });
    vi.mocked(api.qaStream).mockImplementation(
      streamOf([{ type: "done", model: "m", citations: [], tool_calls_summary: [] }]) as unknown as typeof api.qaStream,
    );
    renderPanel(<Assistant open onClose={() => {}} />, "/portal");
    expect(screen.getByText(/Data isolation active/)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/Ask TIA/), "hi");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(vi.mocked(api.qaStream)).toHaveBeenCalledWith("hi", undefined, "CL001", expect.anything(), []),
    );
  });

  it("shows the focused-entity pill from the ?aida= url param and clears it", async () => {
    const user = userEvent.setup();
    renderPanel(<Assistant open onClose={() => {}} />, "/console?aida=inv:abc123def456");
    expect(await screen.findByText("Focused")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear focused entity" }));
    await waitFor(() => expect(screen.queryByText("Focused")).not.toBeInTheDocument());
  });

  it("closes via the close button", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderPanel(<Assistant open onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Close chat" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("marks a tool as errored and renders its error text", async () => {
    const user = userEvent.setup();
    vi.mocked(api.qaStream).mockImplementation(
      streamOf([
        { type: "tool", name: "recover_leakage", args: {}, status: "running" },
        { type: "tool", name: "recover_leakage", args: {}, status: "error", error: "boom-tool" },
        { type: "done", model: "m", citations: [], tool_calls_summary: [] },
      ]) as unknown as typeof api.qaStream,
    );
    renderPanel(<Assistant open onClose={() => {}} />);
    await user.type(screen.getByPlaceholderText(/Ask TIA/), "recover");
    await user.keyboard("{Enter}");
    expect(await screen.findByText("boom-tool")).toBeInTheDocument();
  });

  it("renders a pipe-markdown table in the settled answer", async () => {
    const user = userEvent.setup();
    const table = "Here:\n| Emp | Days |\n| --- | --- |\n| Carlos | 20 |\nDone.";
    vi.mocked(api.qaStream).mockImplementation(
      streamOf([
        { type: "token", content: table },
        { type: "done", model: "m", citations: [], tool_calls_summary: [] },
      ]) as unknown as typeof api.qaStream,
    );
    renderPanel(<Assistant open onClose={() => {}} />);
    await user.type(screen.getByPlaceholderText(/Ask TIA/), "table");
    await user.keyboard("{Enter}");
    // Table header + cell rendered as a real <table>
    expect(await screen.findByText("Emp")).toBeInTheDocument();
    expect(screen.getByText("Carlos")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("carries prior turns as history on a follow-up question", async () => {
    const user = userEvent.setup();
    vi.mocked(api.qaStream).mockImplementation(
      streamOf([
        { type: "token", content: "first answer" },
        { type: "done", model: "m", citations: [], tool_calls_summary: [] },
      ]) as unknown as typeof api.qaStream,
    );
    renderPanel(<Assistant open onClose={() => {}} />);
    const box = screen.getByPlaceholderText(/Ask TIA/);
    await user.type(box, "first");
    await user.keyboard("{Enter}");
    await screen.findByText("first answer");

    await user.type(box, "second");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(vi.mocked(api.qaStream)).toHaveBeenCalledTimes(2));
    const secondCallHistory = vi.mocked(api.qaStream).mock.calls[1][4];
    expect(secondCallHistory).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "first answer" },
    ]);
  });

  it.each([
    ["/console?aida=doc:D123", "D123"],
    ["/console?aida=ts:T123", "T123"],
    ["/console?aida=bareInvoiceId", "bareInvoiceId"],
  ])("decodes the ?aida= entity variant %s", async (entry) => {
    renderPanel(<Assistant open onClose={() => {}} />, entry);
    expect(await screen.findByText("Focused")).toBeInTheDocument();
  });
});

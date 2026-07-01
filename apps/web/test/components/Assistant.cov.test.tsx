import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../src/api", () => ({ api: { qaStream: vi.fn() } }));

import { api } from "../../src/api";
import { Assistant } from "../../src/components/Assistant";
import { usePersona } from "../../src/store";
import type { QaStreamEvent } from "../../src/types";

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
  // happy-dom lacks pointer capture; the resize handle calls it.
  if (!("setPointerCapture" in Element.prototype)) {
    (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
  }
});
afterEach(() => vi.clearAllMocks());

describe("Assistant — localStorage rehydration", () => {
  it("loads a persisted history array and renders it (skipping the empty state)", () => {
    localStorage.setItem(
      "tia.chat.history.finops",
      JSON.stringify([{ role: "aida", text: "seeded answer", streaming: false }]),
    );
    localStorage.setItem("tia.chat.width", "500"); // valid width → loadWidth returns it
    renderPanel(<Assistant open onClose={() => {}} />);
    expect(screen.getByText("seeded answer")).toBeInTheDocument();
    expect(screen.queryByText("Ask TIA anything")).not.toBeInTheDocument();
  });

  it("ignores a persisted non-array payload and shows the empty state", () => {
    localStorage.setItem("tia.chat.history.finops", "{}");
    renderPanel(<Assistant open onClose={() => {}} />);
    expect(screen.getByText("Ask TIA anything")).toBeInTheDocument();
  });

  it("ignores malformed persisted JSON and shows the empty state", () => {
    localStorage.setItem("tia.chat.history.finops", "{not-json");
    renderPanel(<Assistant open onClose={() => {}} />);
    expect(screen.getByText("Ask TIA anything")).toBeInTheDocument();
  });

  it("swallows a saveHistory write failure without crashing", async () => {
    const user = userEvent.setup();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    vi.mocked(api.qaStream).mockImplementation(
      streamOf([{ type: "done", model: "m", citations: [], tool_calls_summary: [] }]) as unknown as typeof api.qaStream,
    );
    renderPanel(<Assistant open onClose={() => {}} />);
    await user.type(screen.getByPlaceholderText(/Ask TIA/), "hi");
    await user.keyboard("{Enter}");
    // Still renders — the persistence failure is caught and ignored.
    expect(await screen.findByText("hi")).toBeInTheDocument();
    setItem.mockRestore();
  });
});

describe("Assistant — entity + send edge branches", () => {
  it("treats an ?aida= value with an empty id as no focus", async () => {
    renderPanel(<Assistant open onClose={() => {}} />, "/console?aida=doc:");
    // decodeAida returns null for an empty id → no focused pill.
    await waitFor(() => expect(screen.queryByText("Focused")).not.toBeInTheDocument());
    expect(screen.getByText("Ask TIA anything")).toBeInTheDocument();
  });

  it("clears a pre-existing focused entity when the URL carries no ?aida=", async () => {
    usePersona.setState({ focusedEntity: { kind: "invoice", id: "I1" } });
    renderPanel(<Assistant open onClose={() => {}} />, "/console");
    await waitFor(() => expect(usePersona.getState().focusedEntity).toBeNull());
  });

  it("does nothing when Enter is pressed with an empty composer", async () => {
    const user = userEvent.setup();
    vi.mocked(api.qaStream).mockImplementation(streamOf([]) as unknown as typeof api.qaStream);
    renderPanel(<Assistant open onClose={() => {}} />);
    const box = screen.getByPlaceholderText(/Ask TIA/);
    box.focus();
    await user.keyboard("{Enter}"); // empty → send() early-returns
    expect(vi.mocked(api.qaStream)).not.toHaveBeenCalled();
  });

  it("pluralises the tool-call strip header for multiple tools", async () => {
    const user = userEvent.setup();
    vi.mocked(api.qaStream).mockImplementation(
      streamOf([
        { type: "tool", name: "verify_audit_chain", args: {}, status: "running" },
        { type: "tool", name: "verify_audit_chain", args: {}, status: "done", result_summary: "ok" },
        { type: "tool", name: "find_leakage", args: {}, status: "running" },
        { type: "tool", name: "find_leakage", args: {}, status: "done", result_summary: "none" },
        { type: "done", model: "m", citations: [], tool_calls_summary: [] },
      ]) as unknown as typeof api.qaStream,
    );
    renderPanel(<Assistant open onClose={() => {}} />);
    await user.type(screen.getByPlaceholderText(/Ask TIA/), "go");
    await user.keyboard("{Enter}");
    expect(await screen.findByText(/called 2 tools/)).toBeInTheDocument();
  });
});

describe("Assistant — streaming in progress + abort", () => {
  it("renders the mid-stream body while a message is still streaming", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.mocked(api.qaStream).mockImplementation((() =>
      (async function* () {
        yield { type: "token", content: "mid-stream text" } as QaStreamEvent;
        await gate;
        yield { type: "done", model: "m", citations: [], tool_calls_summary: [] } as QaStreamEvent;
      })()) as unknown as typeof api.qaStream);

    const user = userEvent.setup();
    renderPanel(<Assistant open onClose={() => {}} />);
    await user.type(screen.getByPlaceholderText(/Ask TIA/), "stream");
    await user.keyboard("{Enter}");
    // Body is rendered via renderBody(text, streaming=true) before "done" arrives.
    expect(await screen.findByText("mid-stream text")).toBeInTheDocument();
    await act(async () => { release(); });
  });

  it("cancels the in-flight stream on New chat (AbortError path)", async () => {
    vi.mocked(api.qaStream).mockImplementation(((_q, _c, _s, signal: AbortSignal) =>
      (async function* () {
        yield { type: "token", content: "partial" } as QaStreamEvent;
        await new Promise<void>((_res, reject) => {
          signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        });
      })()) as unknown as typeof api.qaStream);

    const user = userEvent.setup();
    renderPanel(<Assistant open onClose={() => {}} />);
    await user.type(screen.getByPlaceholderText(/Ask TIA/), "hang");
    await user.keyboard("{Enter}");
    await screen.findByText("partial");
    // New chat aborts the controller → generator throws AbortError → caught.
    await user.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(screen.getByText("Ask TIA anything")).toBeInTheDocument());
  });
});

describe("Assistant — resize handle drag", () => {
  it("drives the pointer drag handlers on the resize separator", async () => {
    renderPanel(<Assistant open onClose={() => {}} />);
    const sep = await screen.findByLabelText("Resize chat panel");
    // pointerMove before a drag starts → early return (dragRef null).
    fireEvent.pointerMove(sep, { clientX: 400, pointerId: 1 });
    // full drag: down → move (widen) → up.
    fireEvent.pointerDown(sep, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(sep, { clientX: 440, pointerId: 1 });
    fireEvent.pointerUp(sep, { pointerId: 1 });
    // Still mounted and interactive after the drag.
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });
});

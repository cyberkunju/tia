import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../src/api", () => ({ api: { qaStream: vi.fn() } }));

import { api } from "../../src/api";
import { Assistant } from "../../src/components/Assistant";
import { usePersona } from "../../src/store";
import type { QaStreamEvent } from "../../src/types";

function streamOf(events: QaStreamEvent[]) {
  return async function* () { for (const e of events) yield e; };
}
function renderPanel(node: ReactElement, entry = "/console") {
  return render(<MemoryRouter initialEntries={[entry]}>{node}</MemoryRouter>);
}

beforeEach(() => {
  usePersona.setState({ persona: "finops", currentClientCode: null, aidaOpen: true, focusedEntity: null });
  vi.mocked(api.qaStream).mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("Assistant — remaining decode/effect/stream branches", () => {
  it("treats an unknown ?aida= kind (with a colon) as a bare invoice id", async () => {
    renderPanel(<Assistant open onClose={() => {}} />, "/console?aida=xyz:abc123");
    // decodeAida: colon present, kind "xyz" matches none → falls through to bare invoice
    expect(await screen.findByText("Focused")).toBeInTheDocument();
    await waitFor(() => {
      const fe = usePersona.getState().focusedEntity;
      expect(fe?.kind).toBe("invoice");
      expect(fe?.id).toBe("xyz:abc123");
    });
  });

  it("replaces a focused entity when the URL points to a different id", async () => {
    usePersona.setState({ focusedEntity: { kind: "invoice", id: "OLD" } });
    renderPanel(<Assistant open onClose={() => {}} />, "/console?aida=inv:NEW");
    await waitFor(() => expect(usePersona.getState().focusedEntity?.id).toBe("NEW"));
  });

  it("replaces a focused entity when only the kind differs", async () => {
    usePersona.setState({ focusedEntity: { kind: "invoice", id: "SAME" } });
    renderPanel(<Assistant open onClose={() => {}} />, "/console?aida=doc:SAME");
    await waitFor(() => expect(usePersona.getState().focusedEntity?.kind).toBe("document"));
  });

  it("leaves the focused entity untouched when the URL already matches it", async () => {
    usePersona.setState({ focusedEntity: { kind: "invoice", id: "MATCH" } });
    const setSpy = vi.fn();
    renderPanel(<Assistant open onClose={() => {}} />, "/console?aida=inv:MATCH");
    // decoded === focusedEntity → the else-if condition is false → no setFocusedEntity churn
    await waitFor(() => expect(usePersona.getState().focusedEntity).toEqual({ kind: "invoice", id: "MATCH" }));
    void setSpy;
  });

  it("shows the fallback error text when the error event has no message", async () => {
    const user = userEvent.setup();
    vi.mocked(api.qaStream).mockImplementation(
      streamOf([{ type: "error", message: "" }]) as unknown as typeof api.qaStream,
    );
    renderPanel(<Assistant open onClose={() => {}} />);
    await user.type(screen.getByPlaceholderText(/Ask TIA/), "hi");
    await user.keyboard("{Enter}");
    expect(await screen.findByText(/TIA couldn't answer that\. Try again or rephrase\./)).toBeInTheDocument();
  });

  it("handles a non-Error thrown value in the transport catch", async () => {
    const user = userEvent.setup();
    vi.mocked(api.qaStream).mockImplementation((() =>
      (async function* () {
        // eslint-disable-next-line no-throw-literal
        throw "plain string failure";
        // eslint-disable-next-line no-unreachable
        yield { type: "token", content: "" } as QaStreamEvent;
      })()) as unknown as typeof api.qaStream);
    renderPanel(<Assistant open onClose={() => {}} />);
    await user.type(screen.getByPlaceholderText(/Ask TIA/), "hi");
    await user.keyboard("{Enter}");
    expect(await screen.findByText(/Network error reaching TIA/)).toBeInTheDocument();
  });

  it("marks concurrent tools independently (skips non-matching entries in the loop)", async () => {
    const user = userEvent.setup();
    vi.mocked(api.qaStream).mockImplementation(
      streamOf([
        { type: "tool", name: "tool_a", args: undefined as never, status: "running" },
        { type: "tool", name: "tool_b", args: {}, status: "running" },
        { type: "tool", name: "tool_c", args: {}, status: "running" },
        // a done → loop skips c, b (mismatch) then matches a
        { type: "tool", name: "tool_a", args: {}, status: "done", result_summary: "a-done" },
        // b error → loop skips c (mismatch) then matches b
        { type: "tool", name: "tool_b", args: {}, status: "error", error: "b-failed" },
        // unknown tool status → none of running/done/error match (no-op)
        { type: "tool", name: "tool_c", args: {}, status: "cancelled" as never },
        // unknown event type → not tool/token/done/error (no-op)
        { type: "heartbeat" } as never,
        { type: "done", model: "m", citations: [], tool_calls_summary: [] },
      ]) as unknown as typeof api.qaStream,
    );
    renderPanel(<Assistant open onClose={() => {}} />);
    await user.type(screen.getByPlaceholderText(/Ask TIA/), "go");
    await user.keyboard("{Enter}");
    expect(await screen.findByText("a-done")).toBeInTheDocument();
    expect(screen.getByText("b-failed")).toBeInTheDocument();
  });

  it("renders a running tool (spinner) mid-stream", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.mocked(api.qaStream).mockImplementation((() =>
      (async function* () {
        yield { type: "tool", name: "verify_audit_chain", args: {}, status: "running" } as QaStreamEvent;
        await gate;
        yield { type: "done", model: "m", citations: [], tool_calls_summary: [] } as QaStreamEvent;
      })()) as unknown as typeof api.qaStream);
    const user = userEvent.setup();
    renderPanel(<Assistant open onClose={() => {}} />);
    await user.type(screen.getByPlaceholderText(/Ask TIA/), "verify");
    await user.keyboard("{Enter}");
    // running tool row rendered (spinner state) before "done" arrives
    expect(await screen.findByText("verify_audit_chain")).toBeInTheDocument();
    await act(async () => { release(); });
  });
});

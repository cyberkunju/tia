import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
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
});
afterEach(() => vi.clearAllMocks());

describe("Assistant — remaining branches", () => {
  it("derives entity_context from the legacy ?doc= param when nothing is focused", async () => {
    const user = userEvent.setup();
    vi.mocked(api.qaStream).mockImplementation(
      streamOf([{ type: "done", model: "m", citations: [], tool_calls_summary: [] }]) as unknown as typeof api.qaStream,
    );
    // no ?aida= → focusedEntity stays null → entityContext falls back to ?doc=
    renderPanel(<Assistant open onClose={() => {}} />, "/console?doc=DOC-42");
    await user.type(screen.getByPlaceholderText(/Ask TIA/), "hello");
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(vi.mocked(api.qaStream)).toHaveBeenCalledWith(
        "hello",
        { kind: "document", id: "DOC-42" },
        null,
        expect.anything(),
        [],
      ),
    );
  });

  it("shows 'no response' when the stream finishes without emitting any tokens", async () => {
    const user = userEvent.setup();
    vi.mocked(api.qaStream).mockImplementation(
      streamOf([{ type: "done", model: "", citations: [], tool_calls_summary: [] }]) as unknown as typeof api.qaStream,
    );
    renderPanel(<Assistant open onClose={() => {}} />);
    await user.type(screen.getByPlaceholderText(/Ask TIA/), "silence");
    await user.keyboard("{Enter}");
    expect(await screen.findByText("no response")).toBeInTheDocument();
  });
});

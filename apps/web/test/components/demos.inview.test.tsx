import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../../src/api", () => ({ api: { submitEmail: vi.fn(), getDoc: vi.fn(), qa: vi.fn() } }));
// useInView false → the auto-play effect condition is false and playback never starts.
vi.mock("framer-motion", () => ({ useInView: () => false }));

import { api } from "../../src/api";
import { EmailDemo } from "../../src/components/EmailDemo";
import { WhatsAppDemo } from "../../src/components/WhatsAppDemo";

beforeEach(() => {
  vi.mocked(api.submitEmail).mockReset().mockResolvedValue({ doc_id: "D1", timesheet_id: "t", status: "ok", routing: "auto", confidence: 0.9 } as never);
  vi.mocked(api.getDoc).mockReset();
  vi.mocked(api.qa).mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("Demos — not in view (no auto-play)", () => {
  it("EmailDemo does not bill when it is out of view", () => {
    render(<EmailDemo />);
    expect(screen.getByText(/Please raise the invoice/)).toBeInTheDocument();
    expect(vi.mocked(api.submitEmail)).not.toHaveBeenCalled();
  });

  it("WhatsAppDemo does not play when it is out of view", () => {
    render(<WhatsAppDemo />);
    expect(screen.getByText(/Send me a timesheet and I'll bill it/)).toBeInTheDocument();
    expect(vi.mocked(api.submitEmail)).not.toHaveBeenCalled();
  });
});

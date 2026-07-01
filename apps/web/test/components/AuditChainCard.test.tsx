import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../src/api", () => ({
  api: { verifyAuditChain: vi.fn() },
}));

import { api } from "../../src/api";
import { AuditChainCard } from "../../src/components/AuditChainCard";
import type { AuditChainReport } from "../../src/types";

function renderCard(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  vi.mocked(api.verifyAuditChain).mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("AuditChainCard", () => {
  it("always renders the panel title and subtitle", () => {
    // never resolves -> stays in loading, but title/subtitle are static
    vi.mocked(api.verifyAuditChain).mockReturnValue(new Promise(() => {}));
    renderCard(<AuditChainCard />);
    expect(screen.getByText("Audit chain integrity")).toBeInTheDocument();
    expect(
      screen.getByText("Tamper-evident hash chain over every pipeline event."),
    ).toBeInTheDocument();
  });

  it("shows the verifying spinner state while the query is pending", () => {
    vi.mocked(api.verifyAuditChain).mockReturnValue(new Promise(() => {}));
    renderCard(<AuditChainCard />);
    expect(screen.getByText(/Verifying/)).toBeInTheDocument();
  });

  it("renders a red banner when the verify endpoint is unreachable", async () => {
    vi.mocked(api.verifyAuditChain).mockRejectedValue(new Error("boom"));
    renderCard(<AuditChainCard />);
    expect(await screen.findByText("Could not reach /audit/verify.")).toBeInTheDocument();
  });

  it("renders a valid chain with a pluralised event count and truncated head", async () => {
    const report: AuditChainReport = {
      ok: true,
      total: 47,
      errors: [],
      head: "a7d23bccdeadbeef",
    };
    vi.mocked(api.verifyAuditChain).mockResolvedValue(report);
    renderCard(<AuditChainCard />);

    expect(await screen.findByText("chain valid")).toBeInTheDocument();
    expect(screen.getByText("47")).toBeInTheDocument();
    // plural "events" (total !== 1) — text is split, so match the trailing "s"
    expect(screen.getByText(/events/)).toBeInTheDocument();
    // head is sliced to first 8 chars + ellipsis
    expect(screen.getByText("a7d23bcc…")).toBeInTheDocument();
  });

  it("uses the singular 'event' label when exactly one event exists and omits head when null", async () => {
    const report: AuditChainReport = { ok: true, total: 1, errors: [], head: null };
    vi.mocked(api.verifyAuditChain).mockResolvedValue(report);
    renderCard(<AuditChainCard />);

    expect(await screen.findByText("chain valid")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    // singular: rendered text is "event" (no trailing s). No "head" code chunk.
    expect(screen.queryByText(/head/)).not.toBeInTheDocument();
  });

  it("renders a BROKEN banner listing the first three integrity errors", async () => {
    const report: AuditChainReport = {
      ok: false,
      total: 5,
      head: "deadbeef",
      errors: [
        { event_id: "aaaa1111zzzz", at: "2026-01-02T03:04:05Z", kind: "hash_mismatch" },
        { event_id: "bbbb2222zzzz", at: null, kind: "prev_mismatch" },
        { event_id: "cccc3333zzzz", at: "2026-02-02T10:20:30Z", kind: "hash_mismatch" },
        { event_id: "dddd4444zzzz", at: null, kind: "hash_mismatch" },
      ],
    };
    vi.mocked(api.verifyAuditChain).mockResolvedValue(report);
    renderCard(<AuditChainCard />);

    expect(await screen.findByText(/chain BROKEN/)).toBeInTheDocument();
    expect(screen.getByText(/4 integrity errors/)).toBeInTheDocument();
    // first offender: id sliced to 8 chars + ellipsis
    expect(screen.getByText("aaaa1111…")).toBeInTheDocument();
    // date formatting: T replaced by space, sliced to 19 chars
    expect(screen.getByText(/2026-01-02 03:04:05/)).toBeInTheDocument();
    // only 3 shown, "…and 1 more" for the overflow
    expect(screen.getByText(/…and 1 more/)).toBeInTheDocument();
    expect(screen.queryByText("dddd4444…")).not.toBeInTheDocument();
  });

  it("uses singular 'integrity error' for a single broken error and no overflow line", async () => {
    const report: AuditChainReport = {
      ok: false,
      total: 3,
      head: "abc",
      errors: [{ event_id: "ffff9999zzzz", at: null, kind: "prev_mismatch" }],
    };
    vi.mocked(api.verifyAuditChain).mockResolvedValue(report);
    renderCard(<AuditChainCard />);

    expect(await screen.findByText(/1 integrity error/)).toBeInTheDocument();
    expect(screen.queryByText(/more/)).not.toBeInTheDocument();
  });
});

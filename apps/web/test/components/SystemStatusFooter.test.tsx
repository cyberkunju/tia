import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../src/api", () => ({
  api: { status: vi.fn() },
}));

import { api } from "../../src/api";
import { SystemStatusFooter } from "../../src/components/SystemStatusFooter";
import type { StatusResponse } from "../../src/types";

function renderFooter(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const status = (over: Partial<StatusResponse> = {}): StatusResponse => ({
  api: "ok",
  db: "ok",
  openai: "configured",
  modal_ocr: "configured",
  zoho_mail: "configured",
  rust_dispatch: "in_process",
  ...over,
});

beforeEach(() => {
  vi.mocked(api.status).mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("SystemStatusFooter", () => {
  it("renders all six service labels in the default (full) layout", async () => {
    vi.mocked(api.status).mockResolvedValue(status());
    renderFooter(<SystemStatusFooter />);

    for (const label of ["api", "db", "openai", "ocr", "mail", "dispatch"]) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
  });

  it("classifies healthy statuses as green dots", async () => {
    vi.mocked(api.status).mockResolvedValue(status());
    const { container } = renderFooter(<SystemStatusFooter />);
    // all six are ok/configured/in_process -> emerald (wait for the query to settle)
    await waitFor(() =>
      expect(container.querySelectorAll(".bg-emerald-400").length).toBe(6),
    );
    expect(container.querySelector(".bg-amber-400")).toBeNull();
    expect(container.querySelector(".bg-red-400")).toBeNull();
  });

  it("classifies a missing_* value as a warning (amber) and a down value as bad (red)", async () => {
    vi.mocked(api.status).mockResolvedValue(
      status({ openai: "missing_key", rust_dispatch: "unreachable" }),
    );
    const { container } = renderFooter(<SystemStatusFooter />);
    await waitFor(() =>
      expect(container.querySelector(".bg-amber-400")).toBeInTheDocument(),
    );
    expect(container.querySelector(".bg-red-400")).toBeInTheDocument();
  });

  it("treats missing data as all-bad (red) dots and shows a dash in the tooltip", async () => {
    // query returns undefined data initially / on failure -> classifyDot(undefined) = bad
    vi.mocked(api.status).mockRejectedValue(new Error("down"));
    const { container } = renderFooter(<SystemStatusFooter />);
    // labels are static so they render even without data
    await screen.findByText("api");
    expect(container.querySelectorAll(".bg-red-400").length).toBe(6);
    const apiDot = screen.getByTitle(/FastAPI backend: -/);
    expect(apiDot).toBeInTheDocument();
  });

  it("renders the compact layout with dots only (no text labels)", async () => {
    vi.mocked(api.status).mockResolvedValue(status());
    const { container } = renderFooter(<SystemStatusFooter compact />);
    await Promise.resolve();
    // compact = no visible service label text
    expect(screen.queryByText("dispatch")).not.toBeInTheDocument();
    // six dot spans still present
    expect(container.querySelectorAll("span.rounded-full").length).toBe(6);
    expect(container.querySelector(".text-white\\/85")).toBeInTheDocument();
  });

  it("applies the dark tone text colour when tone='dark'", async () => {
    vi.mocked(api.status).mockResolvedValue(status());
    const { container } = renderFooter(<SystemStatusFooter tone="dark" />);
    await screen.findByText("api");
    expect(container.querySelector(".text-teal-100")).toBeInTheDocument();
  });
});

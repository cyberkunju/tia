import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TextCard } from "../../src/components/TextCard";

function renderCard(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

function fakeResponse(text: string, ok = true, status = 200) {
  return { ok, status, text: () => Promise.resolve(text) } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("TextCard", () => {
  it("shows a loading state while fetching", () => {
    vi.mocked(fetch).mockReturnValue(new Promise(() => {}) as Promise<Response>);
    renderCard(<TextCard sourceUrl="/documents/1/source" />);
    expect(screen.getByText(/Loading text/)).toBeInTheDocument();
  });

  it("renders plain text with the 'Plain text' badge and filename", async () => {
    vi.mocked(fetch).mockResolvedValue(fakeResponse("just some notes here"));
    renderCard(<TextCard sourceUrl="/documents/1/source" filename="case_02.txt" />);

    expect(await screen.findByText("just some notes here")).toBeInTheDocument();
    expect(screen.getByText("Plain text")).toBeInTheDocument();
    expect(screen.getByText("case_02.txt")).toBeInTheDocument();
  });

  it("detects an online-form submission and shows that badge", async () => {
    const form = ["Client: CL001", "Period: 2026-06", "", "hours: 20"].join("\n");
    vi.mocked(fetch).mockResolvedValue(fakeResponse(form));
    renderCard(<TextCard sourceUrl="/documents/2/source" />);

    expect(await screen.findByText("Online form submission")).toBeInTheDocument();
    expect(screen.queryByText("Plain text")).not.toBeInTheDocument();
  });

  it("does not render a filename line when filename is omitted", async () => {
    vi.mocked(fetch).mockResolvedValue(fakeResponse("body"));
    renderCard(<TextCard sourceUrl="/documents/3/source" />);
    expect(await screen.findByText("body")).toBeInTheDocument();
    expect(screen.queryByText(/\.txt$/)).not.toBeInTheDocument();
  });

  it("shows an (empty file) placeholder for an empty but successful response", async () => {
    vi.mocked(fetch).mockResolvedValue(fakeResponse(""));
    renderCard(<TextCard sourceUrl="/documents/4/source" />);
    expect(await screen.findByText("(empty file)")).toBeInTheDocument();
  });

  it("renders an error state when the response is not ok", async () => {
    vi.mocked(fetch).mockResolvedValue(fakeResponse("", false, 500));
    renderCard(<TextCard sourceUrl="/documents/5/source" />);
    expect(await screen.findByText("Could not load source.")).toBeInTheDocument();
  });
});

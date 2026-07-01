import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { EmlCard } from "../../src/components/EmlCard";

function renderCard(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

/** Build a fetch Response-ish object. */
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

const SAMPLE_EML = [
  "From: payroll@acme.example",
  "To: invoices@tia.example",
  "Cc: cfo@acme.example",
  "Subject: June timesheet attached",
  "Date: Mon, 01 Jun 2026 09:00:00 +0400",
  "",
  "Hello team,",
  "Please find the June hours below.",
].join("\n");

describe("EmlCard", () => {
  it("shows a loading state while the source is being fetched", () => {
    vi.mocked(fetch).mockReturnValue(new Promise(() => {}) as Promise<Response>);
    renderCard(<EmlCard sourceUrl="/documents/1/source" />);
    expect(screen.getByText(/Loading email/)).toBeInTheDocument();
  });

  it("renders the parsed subject, headers and body on success", async () => {
    vi.mocked(fetch).mockResolvedValue(fakeResponse(SAMPLE_EML));
    renderCard(<EmlCard sourceUrl="/documents/1/source" />);

    expect(await screen.findByText("June timesheet attached")).toBeInTheDocument();
    expect(screen.getByText("From")).toBeInTheDocument();
    expect(screen.getByText("payroll@acme.example")).toBeInTheDocument();
    expect(screen.getByText("To")).toBeInTheDocument();
    expect(screen.getByText("invoices@tia.example")).toBeInTheDocument();
    expect(screen.getByText("Cc")).toBeInTheDocument();
    expect(screen.getByText("cfo@acme.example")).toBeInTheDocument();
    expect(screen.getByText("Date")).toBeInTheDocument();
    expect(screen.getByText(/Please find the June hours/)).toBeInTheDocument();
  });

  it("shows a (no subject) placeholder and omits absent optional headers", async () => {
    const eml = ["From: only@from.example", "", "body only"].join("\n");
    vi.mocked(fetch).mockResolvedValue(fakeResponse(eml));
    renderCard(<EmlCard sourceUrl="/documents/2/source" />);

    expect(await screen.findByText("(no subject)")).toBeInTheDocument();
    expect(screen.getByText("only@from.example")).toBeInTheDocument();
    // no To / Cc / Date rows for this minimal email
    expect(screen.queryByText("To")).not.toBeInTheDocument();
    expect(screen.queryByText("Cc")).not.toBeInTheDocument();
    expect(screen.queryByText("Date")).not.toBeInTheDocument();
  });

  it("shows an (empty body) placeholder when there is no body", async () => {
    const eml = ["From: x@x.example", "Subject: header only", ""].join("\n");
    vi.mocked(fetch).mockResolvedValue(fakeResponse(eml));
    renderCard(<EmlCard sourceUrl="/documents/3/source" />);

    expect(await screen.findByText("header only")).toBeInTheDocument();
    expect(screen.getByText("(empty body)")).toBeInTheDocument();
  });

  it("renders an error state when the fetch response is not ok", async () => {
    vi.mocked(fetch).mockResolvedValue(fakeResponse("", false, 404));
    renderCard(<EmlCard sourceUrl="/documents/4/source" />);
    expect(await screen.findByText("Could not load source.")).toBeInTheDocument();
  });
});

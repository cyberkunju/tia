import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../src/api", () => ({
  api: {
    metricsStp: vi.fn(),
    metricsTimeToInvoice: vi.fn(),
    metricsAccuracy: vi.fn(),
  },
}));

// The two demos run long, timer-driven animation loops against the backend.
// The Landing page test only cares about page structure/sections, so stub them
// (mirrors how the Console test stubs DocFocus).
vi.mock("../../src/components/WhatsAppDemo", () => ({
  WhatsAppDemo: () => <div data-testid="whatsapp-demo" />,
}));
vi.mock("../../src/components/EmailDemo", () => ({
  EmailDemo: () => <div data-testid="email-demo" />,
}));

import { api } from "../../src/api";
import { Landing } from "../../src/pages/Landing";
import type { AccuracyMetric, StpMetric, TimeMetric } from "../../src/types";

function renderPage(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(api.metricsStp).mockReset();
  vi.mocked(api.metricsTimeToInvoice).mockReset();
  vi.mocked(api.metricsAccuracy).mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("Landing page", () => {
  it("renders every marketing section and the stubbed channel demos", async () => {
    vi.mocked(api.metricsStp).mockResolvedValue({ total: 0, auto: 0, hitl: 0, escalate: 0, touchless_rate: 0, target: 0.9 } as StpMetric);
    vi.mocked(api.metricsTimeToInvoice).mockResolvedValue({ invoices: 0, samples: 0, mean_minutes: 0, target_max_minutes: 5 } as TimeMetric);
    vi.mocked(api.metricsAccuracy).mockResolvedValue({ target: 0.95, macro_f1: {}, overall_macro_f1: null, passed: null, runnable: null, ece: null } as AccuracyMetric);

    renderPage(<Landing />);

    // Hero headline + section headings
    expect(screen.getByText("from a chat.")).toBeInTheDocument();
    expect(screen.getByText(/Bill straight from a WhatsApp chat/)).toBeInTheDocument();
    expect(screen.getByText(/Forward a timesheet, get the invoice by return/)).toBeInTheDocument();
    expect(screen.getByText(/One path from a raw timesheet/)).toBeInTheDocument();
    expect(screen.getByText(/Built for real staffing operations/)).toBeInTheDocument();
    expect(screen.getByText("Three views, one source of truth.")).toBeInTheDocument();

    // Stubbed demos mounted
    expect(screen.getByTestId("whatsapp-demo")).toBeInTheDocument();
    expect(screen.getByTestId("email-demo")).toBeInTheDocument();

    // Metrics strip fallbacks (no data → target placeholders)
    expect(screen.getByText("Target 90%")).toBeInTheDocument();
    expect(screen.getByText("Under 5 min")).toBeInTheDocument();
    expect(screen.getByText("0.98+")).toBeInTheDocument();

    // Persona cards link into the app
    expect(screen.getByRole("link", { name: /Open portal/ })).toBeInTheDocument();
  });

  it("shows live metric values when the backend returns data", async () => {
    vi.mocked(api.metricsStp).mockResolvedValue({ total: 10, auto: 9, hitl: 1, escalate: 0, touchless_rate: 0.9, target: 0.9 } as StpMetric);
    vi.mocked(api.metricsTimeToInvoice).mockResolvedValue({ invoices: 10, samples: 8, mean_minutes: 4.2, target_max_minutes: 5 } as TimeMetric);
    vi.mocked(api.metricsAccuracy).mockResolvedValue({ target: 0.95, macro_f1: {}, overall_macro_f1: 0.97, passed: 8, runnable: 8, ece: 0.01 } as AccuracyMetric);

    renderPage(<Landing />);
    expect(await screen.findByText("90.0%")).toBeInTheDocument();
    expect(screen.getByText("4.2 min")).toBeInTheDocument();
    expect(screen.getByText("0.97")).toBeInTheDocument();
  });
});

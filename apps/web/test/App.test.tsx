import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// App builds its own QueryClient + browser router. Mock the network seam so the
// Landing page (default route "/") renders without hitting the backend, and stub
// the timer-driven channel demos.
vi.mock("../src/api", () => ({
  api: {
    metricsStp: vi.fn().mockResolvedValue({ total: 0, auto: 0, hitl: 0, escalate: 0, touchless_rate: 0, target: 0.9 }),
    metricsTimeToInvoice: vi.fn().mockResolvedValue({ invoices: 0, samples: 0, mean_minutes: 0, target_max_minutes: 5 }),
    metricsAccuracy: vi.fn().mockResolvedValue({ target: 0.95, macro_f1: {}, overall_macro_f1: null, passed: null, runnable: null, ece: null }),
  },
  API_BASE: "http://127.0.0.1:8000",
}));
vi.mock("../src/components/WhatsAppDemo", () => ({ WhatsAppDemo: () => <div data-testid="wa" /> }));
vi.mock("../src/components/EmailDemo", () => ({ EmailDemo: () => <div data-testid="em" /> }));

import { App } from "../src/App";

beforeEach(() => {
  window.history.pushState({}, "", "/");
});
afterEach(() => vi.clearAllMocks());

describe("App routing", () => {
  it("mounts the browser router and renders the public landing page at '/'", async () => {
    render(<App />);
    // Landing hero headline confirms the "/" route resolved.
    expect(await screen.findByText("from a chat.")).toBeInTheDocument();
    // Landing nav CTA
    expect(screen.getAllByRole("link", { name: /Open console/ }).length).toBeGreaterThan(0);
  });
});

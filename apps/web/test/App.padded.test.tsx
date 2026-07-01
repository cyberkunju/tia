import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// App owns its QueryClient + browser router. The router is built from
// window.location at module-eval time, so we set the URL to a *padded* sub-route
// and (re)import App fresh — this exercises the `Padded` layout wrapper (the
// SectionNav container the nested routes share) that App.test.tsx's "/" route
// never reaches.
vi.mock("../src/api", () => ({
  api: {
    listClients: vi.fn().mockResolvedValue([]),
    listDocs: vi.fn().mockResolvedValue([]),
    demoReset: vi.fn().mockResolvedValue({ status: "ok", wiped: {} }),
    qaStream: vi.fn(),
    evalSummary: vi.fn().mockResolvedValue({
      passed: 1,
      runnable: 1,
      ece: 0.12,
      macro_f1: { days_worked: 1, resolved: 1 },
      results: [],
    }),
    runEval: vi.fn(),
  },
  API_BASE: "http://127.0.0.1:8000",
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  window.history.pushState({}, "", "/");
});

describe("App padded routes", () => {
  it("wraps nested AppShell routes in the Padded/SectionNav layout", async () => {
    window.history.pushState({}, "", "/console/eval");
    vi.resetModules();
    const [{ App }, { usePersona }] = await Promise.all([
      import("../src/App"),
      import("../src/store"),
    ]);
    usePersona.setState({ persona: "finops", currentClientCode: null, aidaOpen: false });

    render(<App />);
    // FinOpsEval rendered inside the padded shell (route resolved past AppShell).
    expect(await screen.findByRole("heading", { name: "Evaluation" })).toBeInTheDocument();
    // SectionNav — rendered only by <Padded> — shows the FinOps section tabs.
    expect(await screen.findByRole("link", { name: "Pipeline" })).toBeInTheDocument();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const motionState = vi.hoisted(() => ({ reduce: false }));

vi.mock("framer-motion", async () => {
  const React = await import("react");
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) =>
        ({ children, ...rest }: Record<string, unknown>) => {
          const {
            initial, animate, exit, whileInView, viewport, transition, layout, ...dom
          } = rest;
          void initial; void animate; void exit; void whileInView; void viewport; void transition; void layout;
          return React.createElement(tag as string, dom, children as React.ReactNode);
        },
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    useReducedMotion: () => motionState.reduce,
    useInView: () => true,
  };
});

vi.mock("../../src/api", () => ({
  api: { metricsStp: vi.fn(), metricsTimeToInvoice: vi.fn(), metricsAccuracy: vi.fn() },
}));
vi.mock("../../src/components/WhatsAppDemo", () => ({ WhatsAppDemo: () => <div data-testid="wa" /> }));
vi.mock("../../src/components/EmailDemo", () => ({ EmailDemo: () => <div data-testid="em" /> }));

import { api } from "../../src/api";
import { Landing } from "../../src/pages/Landing";

function renderPage(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  motionState.reduce = false;
  vi.mocked(api.metricsStp).mockReset().mockResolvedValue({ total: 10, auto: 9, hitl: 1, escalate: 0, touchless_rate: 0.9, target: 0.9 } as never);
  vi.mocked(api.metricsTimeToInvoice).mockReset().mockResolvedValue({ invoices: 10, samples: 8, mean_minutes: 4.2, target_max_minutes: 5 } as never);
  vi.mocked(api.metricsAccuracy).mockReset().mockResolvedValue({ target: 0.95, macro_f1: {}, overall_macro_f1: 0.97, passed: 8, runnable: 8, ece: 0.01 } as never);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("Landing — animation + scroll branches", () => {
  it("drives the hero rAF loop through all stages and reacts to scroll", async () => {
    const cbs: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cbs.push(cb); return cbs.length; });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    renderPage(<Landing />);
    expect(await screen.findByText("from a chat.")).toBeInTheDocument();

    // Drive the loop: 0 (start), mid (<=DUR), post-DUR hold (<=DUR+HOLD), and beyond (reset).
    const tick = (ts: number) => {
      const cb = cbs[cbs.length - 1];
      if (cb) act(() => cb(ts));
    };
    tick(0);
    tick(50); // start latches here (initial start=0 is falsy)
    tick(2000); // e<=3600 → progress
    tick(4500); // 3600<e<=5100 → hold at 100
    tick(9000); // e>5100 → reset to 0

    // Scroll past the threshold → LandingNav flips to the solid style.
    act(() => {
      Object.defineProperty(window, "scrollY", { value: 50, configurable: true });
      fireEvent.scroll(window);
    });

    // live metrics rendered (cond-expr true branches)
    expect(await screen.findByText("90.0%")).toBeInTheDocument();
    expect(screen.getByText("4.2 min")).toBeInTheDocument();
    expect(screen.getByText("0.97")).toBeInTheDocument();
  });

  it("renders the reduced-motion path (Reveal + HeroFlow static)", async () => {
    motionState.reduce = true;
    renderPage(<Landing />);
    expect(await screen.findByText("from a chat.")).toBeInTheDocument();
    // reduced-motion Reveal renders children in a plain div; page still complete
    expect(screen.getByText("Three views, one source of truth.")).toBeInTheDocument();
  });

  it("falls back to placeholder metrics when there is no data", async () => {
    vi.mocked(api.metricsStp).mockResolvedValue({ total: 0, auto: 0, hitl: 0, escalate: 0, touchless_rate: 0, target: 0.9 } as never);
    vi.mocked(api.metricsTimeToInvoice).mockResolvedValue({ invoices: 0, samples: 0, mean_minutes: 0, target_max_minutes: 5 } as never);
    vi.mocked(api.metricsAccuracy).mockResolvedValue({ target: 0.95, macro_f1: {}, overall_macro_f1: null, passed: null, runnable: null, ece: null } as never);
    renderPage(<Landing />);
    expect(await screen.findByText("Target 90%")).toBeInTheDocument();
    expect(screen.getByText("Under 5 min")).toBeInTheDocument();
    expect(screen.getByText("0.98+")).toBeInTheDocument();
  });
});

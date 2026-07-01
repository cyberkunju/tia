// Vitest global setup. Runs once per test file before the tests.
// - jest-dom/vitest wires the DOM matchers (toBeInTheDocument, etc.) into
//   vitest's `expect`.
// - cleanup() unmounts any rendered tree after each test.
// - localStorage is wiped so the persisted Zustand store starts each test from
//   its coded defaults instead of leaking state across tests.
// - Browser APIs happy-dom doesn't implement (IntersectionObserver, matchMedia,
//   ResizeObserver, scroll helpers) are stubbed so framer-motion `whileInView`
//   animations and scroll-driven UI render deterministically under test without
//   touching any application source.
import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

class MockIntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds: ReadonlyArray<number> = [];
  constructor(private cb: IntersectionObserverCallback) {}
  observe(target: Element) {
    // Report the element as immediately, fully in view so whileInView fires.
    this.cb(
      [{ isIntersecting: true, target, intersectionRatio: 1 } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// happy-dom has no Server-Sent-Events. This inert stand-in lets any component
// that opens an EventSource (e.g. LiveActivityRail, and pages that embed it
// like FinanceDashboard) mount without throwing. Tests that actually drive SSE
// (LiveActivityRail.test) stub their own richer EventSource on top of this.
class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  url: string;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  onopen: ((e: unknown) => void) | null = null;
  constructor(url: string) { this.url = url; }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

if (!("IntersectionObserver" in globalThis)) {
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
}
if (!("ResizeObserver" in globalThis)) {
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
}
if (!("EventSource" in globalThis)) {
  vi.stubGlobal("EventSource", MockEventSource);
}

if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
  }
  // jsdom/happy-dom leave these unimplemented; several components call them.
  window.scrollTo = window.scrollTo ?? (() => {});
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
}

afterEach(() => {
  cleanup();
  try {
    window.localStorage.clear();
  } catch {
    /* no localStorage in this context — ignore */
  }
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { LiveActivityRail } from "../../src/components/LiveActivityRail";

// Controllable EventSource so we can drive hello/event/error frames.
class TestEventSource {
  static last: TestEventSource | null = null;
  url: string;
  listeners: Record<string, ((e: { data: string }) => void)[]> = {};
  onerror: ((e: unknown) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    TestEventSource.last = this;
  }
  addEventListener(type: string, cb: (e: { data: string }) => void) {
    (this.listeners[type] ||= []).push(cb);
  }
  removeEventListener() {}
  close() {}
  emit(type: string, data: string) {
    (this.listeners[type] ?? []).forEach((cb) => cb({ data }));
  }
}

beforeEach(() => {
  TestEventSource.last = null;
  vi.stubGlobal("EventSource", TestEventSource);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LiveActivityRail — SSE stream", () => {
  it("connects, renders known + unknown action rows, and tolerates malformed frames", () => {
    render(<LiveActivityRail max={25} />);
    expect(screen.getByText(/connecting/)).toBeInTheDocument();

    const es = TestEventSource.last!;
    act(() => es.emit("hello", ""));
    expect(screen.getByText("streaming")).toBeInTheDocument();

    act(() =>
      es.emit(
        "event",
        JSON.stringify({ id: "e1", kind: "invoice", entity_id: "iiii1111", action: "dispatched", actor: "system", at: "2026-06-01T10:00:00Z" }),
      ),
    );
    // Unknown action → the `?? "bg-ink-100"` tone fallback.
    act(() =>
      es.emit(
        "event",
        JSON.stringify({ id: "e2", kind: "invoice", entity_id: "jjjj2222", action: "totally_unknown", actor: null, at: "2026-06-01T10:01:00Z" }),
      ),
    );
    // Malformed JSON → swallowed by the catch.
    act(() => es.emit("event", "{not-json"));

    expect(screen.getByText("dispatched")).toBeInTheDocument();
    expect(screen.getByText("totally unknown")).toBeInTheDocument();

    // onerror flips back to connecting.
    act(() => es.onerror?.(new Event("error")));
    expect(screen.getByText(/connecting/)).toBeInTheDocument();
  });
});

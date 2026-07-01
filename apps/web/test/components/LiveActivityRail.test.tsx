import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { LiveActivityRail } from "../../src/components/LiveActivityRail";
import type { EventRow } from "../../src/types";

/**
 * Minimal EventSource stand-in. happy-dom has no SSE; we capture the live
 * instance so tests can drive `hello`, `event`, and `error` synchronously.
 */
type Listener = (e: unknown) => void;
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  listeners: Record<string, Listener[]> = {};
  onerror: ((e: unknown) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: Listener) {
    (this.listeners[type] ??= []).push(cb);
  }
  emit(type: string, data?: unknown) {
    for (const cb of this.listeners[type] ?? []) cb({ data });
  }
  fireError() {
    this.onerror?.({});
  }
  close() {
    this.closed = true;
  }
}

function latest() {
  return MockEventSource.instances[MockEventSource.instances.length - 1];
}

const ev = (over: Partial<EventRow> = {}): EventRow => ({
  id: "id-1",
  at: new Date().toISOString(),
  actor: "system",
  kind: "invoice",
  entity_id: "abcdef1234567890",
  action: "ingested",
  payload: {},
  idempotency_key: null,
  ...over,
});

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LiveActivityRail", () => {
  it("starts in the connecting state with an empty-events placeholder", () => {
    render(<LiveActivityRail />);
    expect(screen.getByText(/connecting/)).toBeInTheDocument();
    expect(screen.getByText("Waiting for events…")).toBeInTheDocument();
    expect(screen.getByText("Live activity")).toBeInTheDocument();
  });

  it("switches to 'streaming' after the hello handshake", () => {
    render(<LiveActivityRail />);
    act(() => latest().emit("hello"));
    expect(screen.getByText("streaming")).toBeInTheDocument();
    expect(screen.queryByText(/connecting/)).not.toBeInTheDocument();
  });

  it("renders an event row (action humanised, kind/entity slice, actor)", () => {
    render(<LiveActivityRail />);
    act(() => {
      latest().emit("hello");
      latest().emit("event", JSON.stringify(ev({ action: "rules_evaluated", actor: "finops" })));
    });
    expect(screen.getByText("rules evaluated")).toBeInTheDocument();
    // entity_id sliced to 8 chars, prefixed with kind
    expect(screen.getByText(/invoice\/abcdef12/)).toBeInTheDocument();
    expect(screen.getByText(/finops/)).toBeInTheDocument();
    expect(screen.queryByText("Waiting for events…")).not.toBeInTheDocument();
  });

  it("prepends newest events and caps the list at `max`", () => {
    render(<LiveActivityRail max={2} />);
    act(() => {
      latest().emit("hello");
      latest().emit("event", JSON.stringify(ev({ id: "a", action: "ingested" })));
      latest().emit("event", JSON.stringify(ev({ id: "b", action: "extracted" })));
      latest().emit("event", JSON.stringify(ev({ id: "c", action: "generated" })));
    });
    // max=2 keeps the two newest: generated + extracted; drops the oldest ingested
    expect(screen.getByText("generated")).toBeInTheDocument();
    expect(screen.getByText("extracted")).toBeInTheDocument();
    expect(screen.queryByText("ingested")).not.toBeInTheDocument();
  });

  it("ignores malformed JSON payloads without crashing", () => {
    render(<LiveActivityRail />);
    act(() => {
      latest().emit("hello");
      latest().emit("event", "{not valid json");
    });
    // still connected, still no rows
    expect(screen.getByText("streaming")).toBeInTheDocument();
    expect(screen.getByText("Waiting for events…")).toBeInTheDocument();
  });

  it("falls back to 'connecting' when the stream errors", () => {
    render(<LiveActivityRail />);
    act(() => latest().emit("hello"));
    expect(screen.getByText("streaming")).toBeInTheDocument();
    act(() => latest().fireError());
    expect(screen.getByText(/connecting/)).toBeInTheDocument();
  });

  it("closes the EventSource on unmount", () => {
    const { unmount } = render(<LiveActivityRail />);
    const es = latest();
    unmount();
    expect(es.closed).toBe(true);
  });

  it("falls back to 'system' actor when the event actor is null", () => {
    render(<LiveActivityRail />);
    act(() => {
      latest().emit("hello");
      latest().emit("event", JSON.stringify(ev({ actor: null })));
    });
    expect(screen.getByText(/system/)).toBeInTheDocument();
  });
});

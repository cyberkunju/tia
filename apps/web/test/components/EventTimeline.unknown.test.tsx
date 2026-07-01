import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { EventTimeline } from "../../src/components/EventTimeline";
import type { EventRow } from "../../src/types";

// EventTimeline.test.tsx exercises every *known* action tone. This pins the
// `ACTION_TONE[e.action] ?? fallback` branches (both the dot and the badge)
// for an action string that isn't in the tone map.
describe("EventTimeline unknown action", () => {
  it("falls back to the neutral tone and still humanises the action", () => {
    const e: EventRow = {
      id: "x1", at: "2026-06-01T09:15:30Z", actor: "system", kind: "invoice",
      entity_id: "e1", action: "some_brand_new_action", payload: {}, idempotency_key: null,
    };
    const { container } = render(<EventTimeline events={[e]} />);
    expect(screen.getByText("some brand new action")).toBeInTheDocument();
    // neutral badge fallback class present
    expect(container.querySelector(".bg-ink-100")).toBeInTheDocument();
    // neutral dot fallback class present
    expect(container.querySelector(".bg-ink-300")).toBeInTheDocument();
  });
});

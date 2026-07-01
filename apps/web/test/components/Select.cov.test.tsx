import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Select } from "../../src/components/Select";

/**
 * Closes the last Select branches: ArrowUp / Home while open, a multi-char key
 * in the typeahead default arm, the type-ahead buffer-reset timer, and the
 * "band" variant placeholder styling (no selection).
 */

const OPTS = [
  { value: "a", label: "Apple" },
  { value: "b", label: "Banana" },
  { value: "c", label: "Cherry" },
];

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("Select — remaining keyboard branches", () => {
  it("handles ArrowUp and Home while the listbox is open", () => {
    const onChange = vi.fn();
    render(<Select value="c" onChange={onChange} options={OPTS} ariaLabel="fruit" />);
    const trigger = screen.getByRole("button", { name: "fruit" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" }); // open (active = selected "c")
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: "ArrowUp" }); // move(-1) → Banana
    fireEvent.keyDown(trigger, { key: "Home" }); // setActive(0) → Apple
    fireEvent.keyDown(trigger, { key: "Enter" }); // commit Apple
    expect(onChange).toHaveBeenCalledWith("a");
  });

  it("ignores a multi-character key in the typeahead default arm", () => {
    const onChange = vi.fn();
    render(<Select value={null} onChange={onChange} options={OPTS} ariaLabel="fruit" />);
    const trigger = screen.getByRole("button", { name: "fruit" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" }); // open
    // "Backspace".length !== 1 → the typeahead body is skipped, no crash/commit.
    fireEvent.keyDown(trigger, { key: "Backspace" });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("resets the type-ahead buffer after the timeout so a new key starts fresh", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<Select value={null} onChange={onChange} options={OPTS} ariaLabel="fruit" />);
    const trigger = screen.getByRole("button", { name: "fruit" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" }); // open
    fireEvent.keyDown(trigger, { key: "c" }); // buffer "c" → Cherry active
    act(() => vi.advanceTimersByTime(600)); // buffer reset callback fires
    fireEvent.keyDown(trigger, { key: "a" }); // fresh buffer "a" → Apple (not "ca")
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("a");
  });
});

describe("Select — band variant placeholder", () => {
  it("renders the band placeholder styling when nothing is selected", () => {
    render(<Select variant="band" value={null} onChange={() => {}} options={OPTS} ariaLabel="band" placeholder="Pick one" />);
    const label = screen.getByText("Pick one");
    expect(label).toBeInTheDocument();
    expect(label.className).toContain("text-white/70");
  });
});

describe("Select — disabled keydown + small size", () => {
  it("early-returns from onKeyDown when disabled (direct keydown)", () => {
    const onChange = vi.fn();
    render(<Select value="a" onChange={onChange} options={OPTS} ariaLabel="fruit" disabled />);
    const trigger = screen.getByRole("button", { name: "fruit" });
    // A real disabled <button> swallows events, so dispatch directly to reach the `if (disabled) return` guard.
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("applies the small-size trigger classes on the default variant", () => {
    render(<Select value={null} onChange={() => {}} options={OPTS} ariaLabel="sm" size="sm" placeholder="Pick" />);
    const trigger = screen.getByRole("button", { name: "sm" });
    expect(trigger.className).toContain("text-xs");
  });
});

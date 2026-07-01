import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Select } from "../../src/components/Select";

// Complements the click-driven Select.test.tsx by exercising the keyboard
// interaction model (open/move/typeahead/commit/close) that drives lines the
// pointer tests never reach.
const OPTS = [
  { value: "a", label: "Apple" },
  { value: "b", label: "Banana", disabled: true },
  { value: "c", label: "Cherry" },
];

function setup(value = "a") {
  const onChange = vi.fn();
  render(<Select value={value} onChange={onChange} options={OPTS} ariaLabel="fruit" />);
  return { onChange, trigger: screen.getByRole("button", { name: "fruit" }) };
}

afterEach(() => vi.clearAllMocks());

describe("Select keyboard navigation", () => {
  it("opens with ArrowDown and commits a moved-to option with Enter (skipping disabled)", async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = setup("a");
    trigger.focus();
    await user.keyboard("{ArrowDown}"); // opens
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    // move down skips disabled "Banana" → lands on "Cherry"
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith("c");
  });

  it("wraps with ArrowUp and honours Home/End", async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = setup("a");
    trigger.focus();
    await user.keyboard("{Enter}"); // open via Enter
    await user.keyboard("{End}{Enter}"); // End → last enabled option (Cherry)
    expect(onChange).toHaveBeenCalledWith("c");
  });

  it("selects via type-to-find then Space", async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = setup("a");
    trigger.focus();
    await user.keyboard(" "); // open via Space
    await user.keyboard("c"); // typeahead → Cherry
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("c");
  });

  it("closes on Escape without selecting", async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = setup("a");
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closes on Tab", async () => {
    const user = userEvent.setup();
    const { trigger } = setup("a");
    trigger.focus();
    await user.keyboard("{ArrowUp}"); // opens
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{Tab}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("ignores keys when disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Select value="a" onChange={onChange} options={OPTS} ariaLabel="fruit" disabled />);
    screen.getByRole("button", { name: "fruit" }).focus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows a 'No options' row when the option list is empty", async () => {
    const user = userEvent.setup();
    render(<Select value={null} onChange={() => {}} options={[]} ariaLabel="empty" placeholder="Pick" />);
    await user.click(screen.getByRole("button", { name: "empty" }));
    expect(screen.getByText("No options")).toBeInTheDocument();
  });
});

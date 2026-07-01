import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Select } from "../../src/components/Select";

// Fills the last keyboard edge branches Select.test.tsx / Select.keyboard.test.tsx
// leave: a no-match typeahead, an all-disabled option set, and a non-navigational
// key pressed while the listbox is closed.
afterEach(() => vi.clearAllMocks());

const OPTS = [
  { value: "a", label: "Apple" },
  { value: "b", label: "Banana" },
  { value: "c", label: "Cherry" },
];

describe("Select — edge branches", () => {
  it("ignores a typeahead key that matches no option", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Select value="a" onChange={onChange} options={OPTS} ariaLabel="fruit" />);
    const trigger = screen.getByRole("button", { name: "fruit" });
    trigger.focus();
    await user.keyboard("{ArrowDown}"); // open
    await user.keyboard("z"); // no option starts with "z"
    await user.keyboard("{Enter}"); // commits whatever stayed active (Apple, index 0)
    expect(onChange).toHaveBeenCalledWith("a");
  });

  it("does not commit when every option is disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Select
        value={null}
        onChange={onChange}
        options={[{ value: "a", label: "A", disabled: true }, { value: "b", label: "B", disabled: true }]}
        ariaLabel="all-off"
      />,
    );
    await user.click(screen.getByRole("button", { name: "all-off" }));
    await user.keyboard("{ArrowDown}{Enter}"); // move() finds nothing enabled; commit no-ops
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores a non-navigational key while closed (stays closed)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Select value="a" onChange={onChange} options={OPTS} ariaLabel="fruit" />);
    screen.getByRole("button", { name: "fruit" }).focus();
    await user.keyboard("x"); // not Arrow/Enter/Space → early return, no open
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});

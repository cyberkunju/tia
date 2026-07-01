import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Select, type SelectOption } from "../../src/components/Select";

const OPTS: SelectOption[] = [
  { value: "a", label: "Apple" },
  { value: "b", label: "Banana" },
  { value: "c", label: "Cherry" },
];

function setup(props: Partial<React.ComponentProps<typeof Select>> = {}) {
  const onChange = vi.fn();
  render(
    <Select value={null} onChange={onChange} options={OPTS} ariaLabel="Fruit" {...props} />,
  );
  const trigger = screen.getByRole("button", { name: "Fruit" });
  return { onChange, trigger };
}

describe("Select", () => {
  it("shows the placeholder when nothing is selected", () => {
    setup({ placeholder: "Pick a fruit" });
    expect(screen.getByText("Pick a fruit")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fruit" })).toHaveAttribute("aria-expanded", "false");
  });

  it("shows the label of the selected value", () => {
    setup({ value: "b" });
    expect(screen.getByText("Banana")).toBeInTheDocument();
  });

  it("opens the listbox on click and lists all options", async () => {
    const user = userEvent.setup();
    const { trigger } = setup();
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("commits a value and closes when an option is clicked", async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = setup();
    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "Cherry" }));
    expect(onChange).toHaveBeenCalledWith("c");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("opens with ArrowDown and selects via keyboard navigation", async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = setup();
    trigger.focus();
    // 1st ArrowDown opens (active=0), 2nd moves to index 1, Enter commits it
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("closes on Escape without selecting", async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = setup();
    await user.click(trigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("is a disabled button that will not open", () => {
    const { trigger } = setup({ disabled: true });
    expect(trigger).toBeDisabled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("renders a 'No options' row when the option list is empty", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Select value={null} onChange={onChange} options={[]} ariaLabel="Empty" />);
    await user.click(screen.getByRole("button", { name: "Empty" }));
    expect(screen.getByText("No options")).toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("does not select a disabled option (Enter is a no-op on it)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Select
        value={null}
        onChange={onChange}
        options={[{ value: "a", label: "Apple", disabled: true }, { value: "b", label: "Banana" }]}
        ariaLabel="Fruit"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Fruit" });
    await user.click(trigger); // active starts at index 0 (the disabled Apple)
    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();

    // navigating past the disabled option lands on Banana and selects it
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("closes when clicking outside", async () => {
    const user = userEvent.setup();
    const { trigger } = setup();
    await user.click(trigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Logo } from "../src/components/Logo";

// Proves the happy-dom + testing-library + jest-dom pipeline is wired correctly
// under vitest. The exhaustive component tests live in test/components/.
describe("test harness", () => {
  it("renders a React component into happy-dom and finds it via a11y role", () => {
    render(<Logo className="h-5" />);
    expect(screen.getByRole("img", { name: "TIA" })).toBeInTheDocument();
  });
});

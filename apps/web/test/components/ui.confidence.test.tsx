import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConfidenceBadge } from "../../src/ui";

// ui.test.tsx already pins the green (>=0.85) and amber (0.4–0.6) bands of
// `confidenceTone`. These fill the two remaining bands so every branch of the
// confidence-tone ladder is exercised.
describe("ConfidenceBadge tone bands (remaining)", () => {
  it("uses blue for the 0.6–0.85 band", () => {
    const { container } = render(<ConfidenceBadge value={0.7} />);
    expect(container.querySelector(".badge-blue")).toBeInTheDocument();
    expect(screen.getByText("70.0%")).toBeInTheDocument();
  });

  it("uses red for a low (<0.4) confidence", () => {
    const { container } = render(<ConfidenceBadge value={0.2} />);
    expect(container.querySelector(".badge-red")).toBeInTheDocument();
    expect(screen.getByText("20.0%")).toBeInTheDocument();
  });
});

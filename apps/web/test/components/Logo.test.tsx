import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Logo } from "../../src/components/Logo";

describe("Logo", () => {
  it("renders an accessible SVG wordmark labelled TIA", () => {
    render(<Logo />);
    const svg = screen.getByRole("img", { name: "TIA" });
    expect(svg).toBeInTheDocument();
    expect(svg.tagName.toLowerCase()).toBe("svg");
  });

  it("draws the three glyph paths", () => {
    const { container } = render(<Logo />);
    expect(container.querySelectorAll("path")).toHaveLength(3);
  });

  it("applies the default brand accent to the centre stroke", () => {
    const { container } = render(<Logo />);
    const paths = container.querySelectorAll("path");
    expect(paths[1].getAttribute("class")).toBe("fill-brand-500");
  });

  it("overrides the accent class when provided", () => {
    const { container } = render(<Logo accent="fill-white" />);
    const paths = container.querySelectorAll("path");
    expect(paths[1].getAttribute("class")).toBe("fill-white");
  });

  it("merges a custom className onto the base svg classes", () => {
    render(<Logo className="h-5" />);
    const svg = screen.getByRole("img", { name: "TIA" });
    expect(svg).toHaveClass("h-5", "w-auto", "block");
  });
});

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { InvoiceFSMStrip } from "../../src/components/InvoiceFSMStrip";

describe("InvoiceFSMStrip", () => {
  it("always renders the three canonical lifecycle stages", () => {
    render(<InvoiceFSMStrip status="generated" />);
    expect(screen.getByText("Generated")).toBeInTheDocument();
    expect(screen.getByText("Finance approved")).toBeInTheDocument();
    expect(screen.getByText("Dispatched")).toBeInTheDocument();
  });

  it("marks the current stage node for a known status", () => {
    const { container } = render(<InvoiceFSMStrip status="finance_approved" />);
    // the current node carries the brand fill highlight
    expect(container.querySelector(".bg-brand-500")).toBeInTheDocument();
  });

  it("shows the VOIDED fork for void/voided statuses", () => {
    render(<InvoiceFSMStrip status="void" />);
    expect(screen.getByText("VOIDED")).toBeInTheDocument();

    render(<InvoiceFSMStrip status="voided" />);
    expect(screen.getAllByText("VOIDED").length).toBeGreaterThanOrEqual(1);
  });

  it("shows the CREDIT NOTE fork for credit_note statuses", () => {
    render(<InvoiceFSMStrip status="credit_note_issued" />);
    expect(screen.getByText("CREDIT NOTE ISSUED")).toBeInTheDocument();

    render(<InvoiceFSMStrip status="credit_noted" />);
    expect(screen.getAllByText("CREDIT NOTE ISSUED").length).toBeGreaterThanOrEqual(1);
  });

  it("does not render a fork chip for a normal in-flight status", () => {
    render(<InvoiceFSMStrip status="dispatched" />);
    expect(screen.queryByText("VOIDED")).not.toBeInTheDocument();
    expect(screen.queryByText("CREDIT NOTE ISSUED")).not.toBeInTheDocument();
  });

  it("treats an unknown status as the first stage without crashing", () => {
    render(<InvoiceFSMStrip status="totally_unknown" />);
    expect(screen.getByText("Generated")).toBeInTheDocument();
    expect(screen.queryByText("VOIDED")).not.toBeInTheDocument();
  });
});

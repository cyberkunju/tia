import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DispatchPillars } from "../../src/components/DispatchPillars";
import type { StpMetricFull } from "../../src/types";

const stp = (over: Partial<StpMetricFull["dispatched_breakdown"]> | null): StpMetricFull => ({
  total: 0,
  auto: 0,
  hitl: 0,
  escalate: 0,
  touchless_rate: 0,
  target: 0.8,
  dispatched_breakdown: over === null ? undefined : {
    auto_dispatched: 0,
    hitl_dispatched: 0,
    finance_dispatched: 0,
    total_dispatched: 0,
    ...over,
  },
});

describe("DispatchPillars", () => {
  it("shows the empty state when nothing has been dispatched", () => {
    render(<DispatchPillars stp={stp({})} />);
    expect(screen.getByText("No invoices dispatched yet.")).toBeInTheDocument();
    expect(screen.getByText("0 dispatched · brief target 80%+ auto")).toBeInTheDocument();
  });

  it("shows the empty state when stp is undefined", () => {
    render(<DispatchPillars stp={undefined} />);
    expect(screen.getByText("No invoices dispatched yet.")).toBeInTheDocument();
  });

  it("shows the empty state when the breakdown is missing", () => {
    render(<DispatchPillars stp={stp(null)} />);
    expect(screen.getByText("No invoices dispatched yet.")).toBeInTheDocument();
  });

  it("renders three pillar tiles with counts and rounded percentages", () => {
    render(
      <DispatchPillars
        stp={stp({
          total_dispatched: 10,
          auto_dispatched: 8,
          hitl_dispatched: 1,
          finance_dispatched: 1,
        })}
      />,
    );
    expect(screen.getByText("10 dispatched · brief target 80%+ auto")).toBeInTheDocument();
    expect(screen.getByText("Auto-dispatched")).toBeInTheDocument();
    expect(screen.getByText("FinOps reviewed")).toBeInTheDocument();
    expect(screen.getByText("Finance approved")).toBeInTheDocument();
    // counts
    expect(screen.getByText("8")).toBeInTheDocument();
    // percentages: 80% auto, 10% hitl, 10% finance
    expect(screen.getByText("80%")).toBeInTheDocument();
    expect(screen.getAllByText("10%").length).toBe(2);
    // sublabels
    expect(screen.getByText("touchless")).toBeInTheDocument();
    expect(screen.getByText("manual review")).toBeInTheDocument();
    expect(screen.getByText("over threshold")).toBeInTheDocument();
    expect(screen.queryByText("No invoices dispatched yet.")).not.toBeInTheDocument();
  });

  it("computes percentages against the dispatched total (rounding)", () => {
    render(
      <DispatchPillars
        stp={stp({
          total_dispatched: 3,
          auto_dispatched: 2,
          hitl_dispatched: 1,
          finance_dispatched: 0,
        })}
      />,
    );
    // 2/3 -> 67%, 1/3 -> 33%, 0/3 -> 0%
    expect(screen.getByText("67%")).toBeInTheDocument();
    expect(screen.getByText("33%")).toBeInTheDocument();
    expect(screen.getByText("0%")).toBeInTheDocument();
  });
});

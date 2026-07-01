import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { EventTimeline } from "../../src/components/EventTimeline";
import { RuleChip, RuleSummary } from "../../src/components/RuleChip";
import { DispatchPillars } from "../../src/components/DispatchPillars";
import type { EventRow, ValidationResult } from "../../src/types";

const ev = (over: Partial<EventRow> = {}): EventRow => ({
  id: "e1", kind: "invoice", entity_id: "i1", action: "generated", actor: "system",
  at: "2026-06-01T10:00:00Z", payload: {}, ...over,
});

describe("EventTimeline — summarisePayload branches", () => {
  it("summarises a rich payload and tolerates a null payload / unknown action", () => {
    render(
      <EventTimeline
        events={[
          ev({
            id: "rich",
            action: "totally_unknown_action",
            payload: {
              amount: 1000, client: "CL001", sequence_no: "SEQ1", credit_note_sequence_no: "CN1",
              rule_id: "R1", engine: "rust", intake_mode: "email", rules_run: 15,
              rules_passed_count: 15, is_partial: true, credit_note_amount: 200,
              adjustment_type: "INTERNAL_WRITE_OFF", threshold: 50000, consolidated_excel: true, friendly: "all good",
            },
          }),
          // is_partial + credit_note_amount but no invoice_amount → "?" fallback
          ev({ id: "partial", action: "invoice.credit_note_issued", payload: { is_partial: true, credit_note_amount: 50 } }),
          // rules_run present, blocking_failures absent → `?? 0`
          ev({ id: "rr", payload: { rules_run: 3 } }),
          // null payload → summarisePayload returns "" (no detail line)
          ev({ id: "nopayload", payload: null as unknown as Record<string, unknown> }),
        ]}
      />,
    );
    expect(screen.getByText(/AED 1000.00/)).toBeInTheDocument();
    expect(screen.getByText(/partial - AED 50.00 of AED \?/)).toBeInTheDocument();
    expect(screen.getByText(/3 rules · 0 failed/)).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it("renders the empty state for no events and for undefined events", () => {
    const { rerender } = render(<EventTimeline events={[]} />);
    expect(screen.getByText("No events yet.")).toBeInTheDocument();
    rerender(<EventTimeline events={undefined as unknown as EventRow[]} />);
    expect(screen.getByText("No events yet.")).toBeInTheDocument();
  });
});

const vr = (over: Partial<ValidationResult> = {}): ValidationResult => ({
  rule: "r1", rule_id: "R1", rule_name: "Rate check", passed: true, severity: "error", ...over,
} as ValidationResult);

describe("RuleChip / RuleSummary — remaining branches", () => {
  it("renders a warning chip with a rule id and message", () => {
    render(<RuleChip result={vr({ passed: false, severity: "warning", message: "soft warn", rule_id: "R7" })} />);
    expect(screen.getByText("R7")).toBeInTheDocument();
    expect(screen.getByText("soft warn")).toBeInTheDocument();
  });

  it("renders a failing chip with expected/actual and an emp id", () => {
    render(<RuleChip result={vr({ passed: false, severity: "error", message: "mismatch", expected: 100, actual: 90, emp_id: "E1" })} />);
    expect(screen.getByText("Expected:")).toBeInTheDocument();
    expect(screen.getByText("Actual:")).toBeInTheDocument();
    expect(screen.getByText("E1")).toBeInTheDocument();
  });

  it("summarises pass/warn/fail counts and lists failing rule ids", () => {
    render(
      <RuleSummary
        results={[
          vr({ passed: true }),
          vr({ passed: false, severity: "warning", rule_id: "R9" }),
          vr({ passed: false, severity: "error", rule_id: "R2", rule_name: "OT cap" }),
        ]}
      />,
    );
    expect(screen.getByText(/1 pass/)).toBeInTheDocument();
    expect(screen.getByText(/1 warn/)).toBeInTheDocument();
    expect(screen.getByText(/1 FAIL/)).toBeInTheDocument();
    // failIds appended
    expect(screen.getByText(/R2/)).toBeInTheDocument();
  });
});

describe("DispatchPillars — undefined stp", () => {
  it("renders the empty state when no stp/breakdown is supplied", () => {
    render(<DispatchPillars stp={undefined} />);
    expect(screen.getByText("No invoices dispatched yet.")).toBeInTheDocument();
  });
});

describe("RuleChip / RuleSummary — extra branch coverage", () => {
  it("renders a failing chip that only has an actual value", () => {
    render(<RuleChip result={vr({ passed: false, severity: "error", actual: 42 })} />);
    expect(screen.getByText("Actual:")).toBeInTheDocument();
    expect(screen.queryByText("Expected:")).not.toBeInTheDocument();
  });

  it("summarises a failure with no rule id (empty failIds)", () => {
    render(<RuleSummary results={[vr({ passed: false, severity: "error", rule_id: undefined, rule: undefined as unknown as string })]} />);
    expect(screen.getByText(/1 FAIL/)).toBeInTheDocument();
  });
});

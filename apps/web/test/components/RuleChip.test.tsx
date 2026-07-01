import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RuleChip, RuleSummary } from "../../src/components/RuleChip";
import type { ValidationResult } from "../../src/types";

const pass = (over: Partial<ValidationResult> = {}): ValidationResult => ({
  rule: "R_pass",
  passed: true,
  message: "",
  severity: "info",
  ...over,
});

describe("RuleChip", () => {
  it("renders a passing rule with its id + name and no message/deltas", () => {
    const { container } = render(
      <RuleChip result={pass({ rule_id: "R1", rule_name: "First rule", message: "should be hidden" })} />,
    );
    expect(screen.getByText("R1")).toBeInTheDocument();
    expect(screen.getByText("First rule")).toBeInTheDocument();
    // message + expected/actual only render on fail/warn
    expect(screen.queryByText("should be hidden")).not.toBeInTheDocument();
    expect(screen.queryByText(/Expected:/)).not.toBeInTheDocument();
    expect(container.querySelector(".bg-emerald-50")).toBeInTheDocument();
  });

  it("prefers rule_id and rule_name over the raw rule field", () => {
    render(<RuleChip result={pass({ rule: "raw", rule_id: "VAT_01", rule_name: "VAT present" })} />);
    expect(screen.getByText("VAT_01")).toBeInTheDocument();
    expect(screen.getByText("VAT present")).toBeInTheDocument();
  });

  it("renders a failing rule in red with message and expected/actual deltas", () => {
    const { container } = render(
      <RuleChip
        result={{
          rule: "R2",
          rule_id: "R2",
          passed: false,
          severity: "error",
          message: "rate mismatch",
          expected: 150,
          actual: 120,
        }}
      />,
    );
    expect(screen.getByText("rate mismatch")).toBeInTheDocument();
    expect(screen.getByText(/Expected:/)).toBeInTheDocument();
    expect(screen.getByText("150")).toBeInTheDocument();
    expect(screen.getByText(/Actual:/)).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    expect(container.querySelector(".bg-red-50")).toBeInTheDocument();
  });

  it("renders a warning in amber with its message but no expected/actual block", () => {
    const { container } = render(
      <RuleChip
        result={{
          rule: "R3",
          passed: false,
          severity: "warning",
          message: "soft anomaly",
          expected: 1,
          actual: 2,
        }}
      />,
    );
    expect(screen.getByText("soft anomaly")).toBeInTheDocument();
    expect(screen.queryByText(/Expected:/)).not.toBeInTheDocument();
    expect(container.querySelector(".bg-amber-50")).toBeInTheDocument();
  });

  it("shows only the provided delta when just one of expected/actual is set", () => {
    render(
      <RuleChip
        result={{ rule: "R4", passed: false, severity: "error", message: "m", expected: 42 }}
      />,
    );
    expect(screen.getByText(/Expected:/)).toBeInTheDocument();
    expect(screen.queryByText(/Actual:/)).not.toBeInTheDocument();
  });

  it("surfaces the employee id when present", () => {
    render(<RuleChip result={pass({ rule: "R5", emp_id: "E-100" })} />);
    expect(screen.getByText(/for emp/)).toBeInTheDocument();
    expect(screen.getByText("E-100")).toBeInTheDocument();
  });
});

describe("RuleSummary", () => {
  const results: ValidationResult[] = [
    { rule: "A", passed: true, message: "" },
    { rule: "B", passed: true, message: "" },
    { rule: "C", passed: false, severity: "warning", message: "warn" },
    { rule: "D", rule_id: "D_FAIL", passed: false, severity: "error", message: "fail" },
  ];

  it("counts pass / warn / fail and lists failing rule ids", () => {
    render(<RuleSummary results={results} />);
    expect(screen.getByText("2 pass")).toBeInTheDocument();
    expect(screen.getByText("1 warn")).toBeInTheDocument();
    // fail chip renders "1 FAIL" plus the joined failing ids
    expect(screen.getByText(/1 FAIL/)).toBeInTheDocument();
    expect(screen.getByText(/D_FAIL/)).toBeInTheDocument();
  });

  it("omits the warn and fail chips when everything passes", () => {
    render(<RuleSummary results={[{ rule: "A", passed: true, message: "" }]} />);
    expect(screen.getByText("1 pass")).toBeInTheDocument();
    expect(screen.queryByText(/warn/)).not.toBeInTheDocument();
    expect(screen.queryByText(/FAIL/)).not.toBeInTheDocument();
  });

  it("renders nothing countable for an empty result set", () => {
    render(<RuleSummary results={[]} />);
    expect(screen.queryByText(/pass/)).not.toBeInTheDocument();
    expect(screen.queryByText(/FAIL/)).not.toBeInTheDocument();
  });
});

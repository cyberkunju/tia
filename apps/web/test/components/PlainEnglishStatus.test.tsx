import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PlainEnglishStatus } from "../../src/components/PlainEnglishStatus";
import type { RuleCatalogue, ValidationResult } from "../../src/types";

// Render with the ["rules"] query primed, so the component reads the friendly
// table from cache and never issues a network request (staleTime is 1h).
function renderPrimed(node: ReactElement, friendly: Record<string, string>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rules: RuleCatalogue = {
    count: Object.keys(friendly).length,
    rules: [],
    friendly_message_table: friendly,
  };
  qc.setQueryData(["rules"], rules);
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

describe("PlainEnglishStatus", () => {
  it("shows the all-clear message when there are no hard failures", () => {
    const results: ValidationResult[] = [{ rule: "R1", passed: true, message: "" }];
    renderPrimed(<PlainEnglishStatus results={results} />, {});
    expect(screen.getByText(/All checks passed/)).toBeInTheDocument();
    expect(screen.queryByText("Needs review")).not.toBeInTheDocument();
  });

  it("ignores soft warnings and still reports all-clear", () => {
    const results: ValidationResult[] = [
      { rule: "R1", passed: true, message: "" },
      { rule: "R2", passed: false, severity: "warning", message: "soft" },
    ];
    renderPrimed(<PlainEnglishStatus results={results} />, {});
    expect(screen.getByText(/All checks passed/)).toBeInTheDocument();
  });

  it("renders the friendly message for a failing rule", () => {
    const results: ValidationResult[] = [
      { rule: "R_RATE", rule_id: "R_RATE", passed: false, severity: "error", message: "raw" },
    ];
    renderPrimed(<PlainEnglishStatus results={results} />, {
      R_RATE: "Rate does not match the contract.",
    });
    expect(screen.getByText("Needs review")).toBeInTheDocument();
    expect(screen.getByText("Rate does not match the contract.")).toBeInTheDocument();
  });

  it("falls back to the raw message when no friendly text exists", () => {
    const results: ValidationResult[] = [
      { rule: "R9", passed: false, severity: "error", message: "custom failure text" },
    ];
    renderPrimed(<PlainEnglishStatus results={results} />, {});
    expect(screen.getByText("custom failure text")).toBeInTheDocument();
  });

  it("collapses multiple failures that share one friendly message into a single line", () => {
    const results: ValidationResult[] = [
      { rule: "R_RATE", rule_id: "R_RATE", passed: false, severity: "error", message: "a" },
      { rule: "R_RATE", rule_id: "R_RATE", passed: false, severity: "error", message: "b", emp_id: "E2" },
    ];
    renderPrimed(<PlainEnglishStatus results={results} />, {
      R_RATE: "Rate does not match the contract.",
    });
    expect(screen.getAllByText("Rate does not match the contract.")).toHaveLength(1);
  });
});

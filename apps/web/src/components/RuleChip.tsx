import { CheckCircle2, AlertOctagon, AlertTriangle, Info } from "lucide-react";
import type { ValidationResult } from "../types";
import { cn } from "../lib";

/** A single validation/rule chip — PASS/FAIL with rule_id + delta. */
export function RuleChip({ result }: { result: ValidationResult }) {
  const isFail = !result.passed && result.severity !== "warning";
  const isWarn = result.severity === "warning";
  const ruleId = result.rule_id ?? result.rule;
  const name = result.rule_name ?? result.rule;

  return (
    <div className={cn(
      "rounded-md border px-2.5 py-2 text-xs leading-relaxed",
      isFail && "bg-red-50 border-red-300 text-red-900",
      isWarn && "bg-amber-50 border-amber-300 text-amber-900",
      !isFail && !isWarn && "bg-emerald-50 border-emerald-200 text-emerald-900",
    )}>
      <div className="flex items-start gap-2">
        <span className="shrink-0 mt-0.5">
          {isFail ? <AlertOctagon size={14} /> : isWarn ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {ruleId && (
              <span className={cn(
                "font-mono text-2xs px-1 rounded font-semibold",
                isFail && "bg-red-200/70 text-red-900",
                isWarn && "bg-amber-200/70 text-amber-900",
                !isFail && !isWarn && "bg-emerald-200/70 text-emerald-900",
              )}>{ruleId}</span>
            )}
            <span className="font-medium truncate">{name}</span>
          </div>
          {(isFail || isWarn) && result.message && (
            <p className="mt-0.5 opacity-90">{result.message}</p>
          )}
          {isFail && (result.expected !== undefined || result.actual !== undefined) && (
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs opacity-80">
              {result.expected !== undefined && (
                <span>Expected: <span className="font-mono">{String(result.expected)}</span></span>
              )}
              {result.actual !== undefined && (
                <span>Actual: <span className="font-mono">{String(result.actual)}</span></span>
              )}
            </div>
          )}
          {result.emp_id && (
            <div className="mt-0.5 text-2xs opacity-70">
              <Info size={9} className="inline" /> for emp <span className="font-mono">{result.emp_id}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** A summary strip showing PASS/FAIL counts and the failing rule IDs. */
export function RuleSummary({ results }: { results: ValidationResult[] }) {
  const fail = results.filter((r) => !r.passed && r.severity !== "warning");
  const warn = results.filter((r) => r.severity === "warning");
  const pass = results.length - fail.length - warn.length;
  const failIds = Array.from(new Set(fail.map((r) => r.rule_id ?? r.rule).filter(Boolean))).join(" · ");

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {pass > 0 && (
        <span className="inline-flex items-center gap-1 rounded-md bg-emerald-100 text-emerald-800 border border-emerald-200 px-2 py-0.5 font-medium">
          <CheckCircle2 size={12} /> {pass} pass
        </span>
      )}
      {warn.length > 0 && (
        <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 text-amber-900 border border-amber-200 px-2 py-0.5 font-medium">
          <AlertTriangle size={12} /> {warn.length} warn
        </span>
      )}
      {fail.length > 0 && (
        <span className="inline-flex items-center gap-1 rounded-md bg-red-100 text-red-900 border border-red-300 px-2 py-0.5 font-semibold">
          <AlertOctagon size={12} /> {fail.length} FAIL{failIds && <> · {failIds}</>}
        </span>
      )}
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, AlertOctagon, AlertTriangle } from "lucide-react";
import { api } from "../api";
import type { ValidationResult } from "../types";

/**
 * PlainEnglishStatus - a plain-language summary of the BTP rule outcomes for
 * the active timesheet. No rule IDs (R0/R1/R5…), no internal jargon -
 * judges and clients see the human-readable friendly_message for each
 * failure, or a single "all checks passed" line.
 *
 * The friendly prose comes from /rules so the wording stays in sync with
 * the engine (FRIENDLY_RULE_MESSAGES in the backend).
 */
export function PlainEnglishStatus({ results }: { results: ValidationResult[] }) {
  const { data } = useQuery({ queryKey: ["rules"], queryFn: api.listRules, staleTime: 60 * 60 * 1000 });
  const friendly = data?.friendly_message_table ?? {};

  const fails = results.filter((r) => !r.passed && r.severity !== "warning");
  const warns = results.filter((r) => r.severity === "warning");

  const friendlyFor = (r: ValidationResult): string => {
    const fid = r.rule_id ?? r.rule;
    return friendly[fid] || r.message || r.rule_name || "An issue was found.";
  };

  // Happy path - everything green.
  if (fails.length === 0 && warns.length === 0) {
    return (
      <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 inline-flex items-center gap-2">
        <CheckCircle2 size={15} className="shrink-0" />
        All checks passed - this timesheet matches the contract.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {fails.length > 0 && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2.5 text-sm text-red-900">
          <div className="font-semibold inline-flex items-center gap-2 mb-1.5">
            <AlertOctagon size={15} /> Needs review
          </div>
          <ul className="space-y-1 ml-1">
            {dedupeByFriendly(fails, friendlyFor).map((r, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <span className="text-red-700 mt-0.5">•</span>
                <span className="leading-snug">{friendlyFor(r)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {warns.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
          <div className="font-semibold inline-flex items-center gap-2 mb-1.5">
            <AlertTriangle size={15} /> Heads-up
          </div>
          <ul className="space-y-1 ml-1">
            {dedupeByFriendly(warns, friendlyFor).map((r, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <span className="text-amber-700 mt-0.5">•</span>
                <span className="leading-snug">{friendlyFor(r)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Collapse multiple failures that share the same friendly_message into one line. */
function dedupeByFriendly(rows: ValidationResult[], friendlyFor: (r: ValidationResult) => string): ValidationResult[] {
  const seen = new Set<string>();
  const out: ValidationResult[] = [];
  for (const r of rows) {
    const k = friendlyFor(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

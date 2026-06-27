import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { cn } from "../lib";
import { PageHeader, Panel, Badge } from "../ui";

// Mirrors the deterministic engine in workers/ai (validate/rules.py + rules_v2).
// Per-client profiles + persistence wire to the backend next; toggles are local for now.
const RULES = [
  { id: "math_gross", name: "Gross composition", sev: "error", desc: "Gross = Basic + Housing + Transport + Food + Phone." },
  { id: "math_net", name: "Net reconciliation", sev: "error", desc: "Net = Gross + OT − Deductions." },
  { id: "ot_amount", name: "OT-amount reconciler", sev: "error", desc: "OT amount matches OT hours × basic-derived rate (1.25/1.5)." },
  { id: "working_days_bounds", name: "Working-days bounds", sev: "error", desc: "Working days within [20, 26] for the period." },
  { id: "attendance_bounds", name: "Attendance bounds", sev: "warning", desc: "Days worked cannot exceed the month's working days (+1 grace)." },
  { id: "currency_aed", name: "Currency is AED", sev: "error", desc: "All amounts denominated in AED." },
  { id: "vat_present", name: "VAT 5% present", sev: "error", desc: "Tax invoice carries a 5% VAT line and totals in AED." },
  { id: "trn_present", name: "Supplier TRN present", sev: "error", desc: "Tax invoice shows the TASC billing entity TRN." },
  { id: "threshold_approval", name: "Finance threshold", sev: "warning", desc: "Amount at/above the client threshold requires Finance approval." },
  { id: "entity_resolved", name: "Entity resolved", sev: "error", desc: "Every billed row resolves to a unique associate (no ambiguity)." },
];

export function RulesConfig() {
  const [on, setOn] = useState<Record<string, boolean>>(Object.fromEntries(RULES.map((r) => [r.id, true])));
  const enabled = Object.values(on).filter(Boolean).length;

  return (
    <div>
      <PageHeader icon={SlidersHorizontal} title="Validation rules"
        description="The configurable “BTP-style” rule set every generated invoice is checked against. Failures route to human review."
        actions={<Badge tone="brand">{enabled}/{RULES.length} enabled</Badge>} />
      <Panel bodyClassName="p-0">
        <ul className="divide-y divide-ink-100">
          {RULES.map((r) => (
            <li key={r.id} className="flex items-center gap-4 px-4 py-3">
              <button onClick={() => setOn((s) => ({ ...s, [r.id]: !s[r.id] }))}
                className={cn("relative h-5 w-9 rounded-full transition-colors shrink-0", on[r.id] ? "bg-brand-600" : "bg-ink-300")}>
                <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all", on[r.id] ? "left-4" : "left-0.5")} />
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-ink-900">{r.name}</span>
                  <span className="font-mono text-2xs text-ink-400">{r.id}</span>
                  <Badge tone={r.sev === "error" ? "red" : "amber"} dot={false}>{r.sev}</Badge>
                </div>
                <div className="text-xs text-ink-500 mt-0.5">{r.desc}</div>
              </div>
            </li>
          ))}
        </ul>
      </Panel>
      <p className="text-xs text-ink-400 mt-3">Rules execute deterministically server-side on every extraction path (Excel, email, GLM-OCR). Per-client profiles and persistence connect to the backend rule engine next.</p>
    </div>
  );
}

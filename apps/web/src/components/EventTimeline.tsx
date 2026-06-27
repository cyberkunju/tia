import { Activity } from "lucide-react";
import type { EventRow } from "../types";
import { cn } from "../lib";

const ACTION_TONE: Record<string, string> = {
  ingested: "bg-ink-100 text-ink-700",
  extracted: "bg-sky-50 text-sky-700",
  resolved: "bg-sky-50 text-sky-700",
  rules_evaluated: "bg-teal-50 text-teal-700",
  payroll_processed_by_sap: "bg-brand-50 text-brand-800",
  routed: "bg-amber-50 text-amber-700",
  generated: "bg-emerald-50 text-emerald-700",
  dispatched: "bg-emerald-50 text-emerald-700",
  auto_dispatched_within_tolerance: "bg-brand-100 text-brand-900",
  client_approved: "bg-brand-50 text-brand-800",
  client_rejected: "bg-red-50 text-red-700",
  finance_approved: "bg-brand-50 text-brand-800",
  finance_rejected: "bg-red-50 text-red-700",
  "invoice.voided": "bg-red-50 text-red-700",
  "invoice.credit_note_issued": "bg-amber-50 text-amber-900",
  "timesheet.needs_review_after_clawback": "bg-amber-50 text-amber-800",
  "query.auto_opened_credit_note": "bg-amber-50 text-amber-800",
  payment_refund_required: "bg-red-50 text-red-700",
};

export function EventTimeline({ events, max = 12 }: { events: EventRow[]; max?: number }) {
  if (!events || events.length === 0) {
    return <p className="text-xs text-ink-400">No events yet.</p>;
  }
  const items = [...events].sort((a, b) => a.at.localeCompare(b.at)).slice(-max);

  return (
    <ol className="space-y-2 relative ml-1">
      {/* spine */}
      <span className="absolute left-1.5 top-1 bottom-1 w-px bg-ink-200" />
      {items.map((e) => (
        <li key={e.id} className="pl-6 relative">
          <span className={cn(
            "absolute left-0 top-1 grid place-items-center h-3 w-3 rounded-full border-2 border-white shadow-xs",
            ACTION_TONE[e.action] ?? "bg-ink-300",
          )} />
          <div className="flex items-center gap-2 text-xs">
            <span className="font-mono text-2xs text-ink-400 tnum">{e.at.slice(11, 19)}</span>
            <span className={cn(
              "rounded px-1.5 py-0.5 text-2xs font-medium border",
              ACTION_TONE[e.action] ?? "bg-ink-100 text-ink-700 border-ink-200",
            )}>{e.action.replace(/_/g, " ")}</span>
            <span className="text-2xs text-ink-500">by {e.actor ?? "system"}</span>
          </div>
          {summarisePayload(e.payload) && (
            <div className="mt-0.5 text-2xs text-ink-500 truncate">{summarisePayload(e.payload)}</div>
          )}
        </li>
      ))}
      <li className="pl-6 relative">
        <span className="absolute left-0 top-1 grid place-items-center h-3 w-3 rounded-full bg-ink-200 border-2 border-white" />
        <div className="flex items-center gap-2 text-2xs text-ink-400">
          <Activity size={11} /> Live
        </div>
      </li>
    </ol>
  );
}

function summarisePayload(p: Record<string, unknown>): string {
  if (!p) return "";
  const out: string[] = [];
  if (p.amount) out.push(`AED ${Number(p.amount).toFixed(2)}`);
  if (p.client) out.push(String(p.client));
  if (p.sequence_no) out.push(String(p.sequence_no));
  if (p.credit_note_sequence_no) out.push(`CN ${p.credit_note_sequence_no}`);
  if (p.rule_id) out.push(`rule ${p.rule_id}`);
  if (p.engine) out.push(`engine: ${p.engine}`);
  if (p.intake_mode) out.push(`mode: ${p.intake_mode}`);
  if (p.rules_run) out.push(`${p.rules_run} rules · ${p.blocking_failures ?? 0} failed`);
  if (p.rules_passed_count !== undefined) {
    out.push(`${p.rules_passed_count} rules passed`);
  }
  if (p.is_partial && p.credit_note_amount) {
    out.push(
      `partial - AED ${Number(p.credit_note_amount).toFixed(2)} of AED ${
        p.invoice_amount ? Number(p.invoice_amount).toFixed(2) : "?"
      }`,
    );
  }
  if (p.adjustment_type) out.push(String(p.adjustment_type).toLowerCase().replace(/_/g, " "));
  if (p.threshold) out.push(`threshold AED ${Number(p.threshold).toFixed(0)}`);
  if (p.consolidated_excel) out.push("consolidated.xlsx + WPS.sif written");
  if (p.friendly) out.push(`(${p.friendly})`);
  return out.join(" · ");
}

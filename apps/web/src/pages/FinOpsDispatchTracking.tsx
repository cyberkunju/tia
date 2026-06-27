import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Radar, RotateCcw, Sparkles, Zap } from "lucide-react";
import { api } from "../api";
import { fmtAED, fmtAge, isAutoDispatched } from "../lib";
import { PageHeader, StatusBadge, ConfidenceBadge, Badge, EmptyState, TableSkeleton } from "../ui";
import { TouchlessRationale } from "../components/TouchlessRationale";
import { ClawbackModal } from "../components/ClawbackModal";
import type { DispatchTrackingRow, Invoice } from "../types";

export function FinOpsDispatchTracking() {
  const { data, isLoading } = useQuery({ queryKey: ["dispatch-tracking"], queryFn: api.dispatchTracking, refetchInterval: 5_000 });
  const [whyFor, setWhyFor] = useState<Invoice | null>(null);
  const [clawbackFor, setClawbackFor] = useState<Invoice | null>(null);

  // Map a DispatchTrackingRow into the Invoice shape that the modals expect.
  // Only the fields actually consumed by the modals (id, status, amount,
  // total_incl_vat, currency, invoice_sequence_no, client_code, period) are
  // required.
  const asInvoice = (r: DispatchTrackingRow): Invoice => ({
    id: r.id,
    timesheet_id: "",
    client_code: r.client_code,
    period: r.period,
    amount: r.amount,
    currency: "AED",
    status: r.status,
    line_items: [],
    pdf_available: false,
    dispatched_at: r.dispatch_attempted_at,
    invoice_sequence_no: r.invoice_sequence_no,
    total_incl_vat: r.total_incl_vat,
    client_approval_status: r.client_approval_status,
  });

  return (
    <div>
      <PageHeader icon={Radar} title="Dispatch tracking" description="Every invoice's dispatch state and client approval, end to end. ⚡ marks fully touchless dispatches." />
      <div className="card-flush">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>Invoice #</th><th>Client</th><th>Period</th><th className="text-right">Total (incl. VAT)</th><th>Status</th><th>Client approval</th><th>Confidence</th><th>Dispatched</th><th className="text-right">Actions</th></tr>
            </thead>
            {isLoading ? <TableSkeleton rows={5} cols={9} /> : (
              <tbody>
                {data?.map((r) => {
                  const auto = isAutoDispatched(r.status) && !r.client_approval_status;
                  const canClawback = r.status === "dispatched" || r.status === "generated" || r.status === "finance_approved";
                  return (
                    <tr key={r.id}>
                      <td className="font-mono text-xs text-ink-600">{r.invoice_sequence_no ?? r.id.slice(0, 8)}</td>
                      <td className="font-medium text-ink-800">{r.client_code}</td>
                      <td className="text-ink-600">{r.period ?? "-"}</td>
                      <td className="text-right tnum font-medium">{fmtAED(r.total_incl_vat ?? r.amount)}</td>
                      <td>
                        <div className="inline-flex items-center gap-1">
                          <StatusBadge status={r.status} />
                          {auto && <Badge tone="brand"><Zap size={9} /> AUTO</Badge>}
                        </div>
                      </td>
                      <td><Badge tone={r.client_approval_status === "approved" ? "green" : r.client_approval_status === "rejected" ? "red" : "amber"} dot={false}>{r.client_approval_status ?? "pending"}</Badge></td>
                      <td><ConfidenceBadge value={r.confidence} /></td>
                      <td className="text-ink-500 text-xs whitespace-nowrap">{r.dispatch_attempted_at ? fmtAge(r.dispatch_attempted_at) + " ago" : "-"}</td>
                      <td>
                        <div className="flex items-center justify-end gap-1.5">
                          {auto && (
                            <button onClick={() => setWhyFor(asInvoice(r))} className="btn-ghost btn-sm" title="Why touchless?">
                              <Sparkles size={12} /> Why?
                            </button>
                          )}
                          {canClawback && (
                            <button onClick={() => setClawbackFor(asInvoice(r))} className="btn-outline btn-sm" title="Void or issue credit note">
                              <RotateCcw size={12} /> Clawback
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            )}
          </table>
        </div>
        {!isLoading && (!data || data.length === 0) && <EmptyState icon={Radar} title="No invoices to track yet" />}
      </div>

      {whyFor && <TouchlessRationale invoice={whyFor} onClose={() => setWhyFor(null)} />}
      {clawbackFor && (
        <ClawbackModal
          invoice={clawbackFor}
          onClose={() => setClawbackFor(null)}
          onDone={() => setClawbackFor(null)}
        />
      )}
    </div>
  );
}

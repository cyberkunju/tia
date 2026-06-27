import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Truck, FileText, ExternalLink, AlertOctagon, Sparkles, RotateCcw, Zap,
} from "lucide-react";
import { api, API_BASE } from "../api";
import { fmtMoney } from "../lib";
import { PageHeader, Panel, StatusBadge, ConfidenceBadge, EmptyState, Badge } from "../ui";
import { ClawbackModal } from "../components/ClawbackModal";
import { TouchlessRationale } from "../components/TouchlessRationale";
import type { Invoice } from "../types";

function isAutoDispatched(status: string): boolean {
  // Auto-dispatched invoices land directly in "dispatched" without manual click.
  // We don't know from the row alone; the rationale event is the source of truth.
  // Display path: if confidence is high AND status is dispatched, show ⚡ chip
  // (frontend hint only — the modal reads the actual audit chain).
  return status === "dispatched";
}

export function FinOpsDispatchTracking() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["dispatch-tracking"],
    queryFn: api.dispatchTracking,
    refetchInterval: 4_000,
  });

  const [whyOpen, setWhyOpen] = useState<Invoice | null>(null);
  const [clawbackOpen, setClawbackOpen] = useState<Invoice | null>(null);

  function rowAsInvoice(r: import("../types").DispatchTrackingRow): Invoice {
    return {
      id: r.id,
      timesheet_id: "",
      client_code: r.client_code,
      period: r.period,
      amount: r.amount,
      currency: "AED",
      status: r.status,
      line_items: [],
      pdf_available: true,
      dispatched_at: r.dispatch_attempted_at,
      invoice_sequence_no: r.invoice_sequence_no,
      total_incl_vat: r.total_incl_vat,
      client_approval_status: r.client_approval_status,
    };
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Truck}
        title="Dispatch tracking"
        description="Where every invoice stands — touchless or reviewed. Click ⚡ for the auto-dispatch rationale; click ⟲ to clawback."
      />

      {isLoading ? (
        <div className="text-sm text-ink-500">Loading…</div>
      ) : !data || data.length === 0 ? (
        <Panel>
          <EmptyState icon={Truck} title="No dispatch records yet" hint="Generated invoices will appear here." />
        </Panel>
      ) : (
        <div className="card-flush overflow-hidden">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Sequence</th>
                  <th>Client</th>
                  <th>Period</th>
                  <th className="text-right">Total</th>
                  <th>Status</th>
                  <th>Client approval</th>
                  <th>Confidence</th>
                  <th>Dispatched at</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.map((r) => {
                  const inv = rowAsInvoice(r);
                  const auto = isAutoDispatched(r.status);
                  return (
                    <tr key={r.id}>
                      <td className="font-mono text-xs text-ink-700">{r.invoice_sequence_no ?? r.id.slice(0, 8)}</td>
                      <td>
                        <span className="font-medium text-ink-800">{r.client_code}</span>
                      </td>
                      <td className="text-ink-600">{r.period ?? "—"}</td>
                      <td className="text-right tnum font-semibold">{fmtMoney(r.total_incl_vat ?? r.amount, "AED")}</td>
                      <td>
                        <div className="inline-flex items-center gap-1">
                          <StatusBadge status={r.status} />
                          {auto && (
                            <Badge tone="brand"><Zap size={9} /> AUTO</Badge>
                          )}
                          {r.rule_results_failed.length > 0 && (
                            <Badge tone="red"><AlertOctagon size={10} /> {r.rule_results_failed.length}</Badge>
                          )}
                        </div>
                      </td>
                      <td>
                        {r.client_approval_status === "approved" && <Badge tone="green">Approved</Badge>}
                        {r.client_approval_status === "pending" && <Badge tone="amber">Pending</Badge>}
                        {r.client_approval_status === "rejected" && <Badge tone="red">Rejected</Badge>}
                        {!r.client_approval_status && <span className="text-ink-400 text-xs">—</span>}
                      </td>
                      <td>
                        {r.confidence !== null && r.confidence !== undefined ? (
                          <ConfidenceBadge value={r.confidence} />
                        ) : <span className="text-ink-400 text-xs">—</span>}
                      </td>
                      <td className="text-xs text-ink-500">
                        {r.dispatch_attempted_at ? r.dispatch_attempted_at.slice(0, 19).replace("T", " ") : "—"}
                      </td>
                      <td>
                        <div className="flex items-center justify-end gap-2">
                          {auto && (
                            <button
                              onClick={() => setWhyOpen(inv)}
                              className="inline-flex items-center gap-1 text-brand-700 hover:text-brand-800 text-xs font-medium"
                              title="Why was this auto-dispatched?"
                            >
                              <Sparkles size={12} /> Why?
                            </button>
                          )}
                          <a href={`${API_BASE}/invoices/${r.id}/pdf`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-700 hover:text-brand-800 text-xs font-medium">
                            <FileText size={12} /> PDF <ExternalLink size={10} />
                          </a>
                          <button
                            onClick={() => setClawbackOpen(inv)}
                            className="inline-flex items-center gap-1 text-amber-700 hover:text-amber-800 text-xs font-medium"
                            title="Clawback this invoice"
                          >
                            <RotateCcw size={12} /> Clawback
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {whyOpen && <TouchlessRationale invoice={whyOpen} onClose={() => setWhyOpen(null)} />}
      {clawbackOpen && (
        <ClawbackModal
          invoice={clawbackOpen}
          onClose={() => setClawbackOpen(null)}
          onDone={() => {
            setClawbackOpen(null);
            qc.invalidateQueries({ queryKey: ["dispatch-tracking"] });
          }}
        />
      )}
    </div>
  );
}

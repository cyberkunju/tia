import { useQuery } from "@tanstack/react-query";
import { Truck, FileText, ExternalLink, AlertOctagon } from "lucide-react";
import { api, API_BASE } from "../api";
import { fmtMoney } from "../lib";
import { PageHeader, Panel, StatusBadge, ConfidenceBadge, EmptyState, Badge } from "../ui";

export function FinOpsDispatchTracking() {
  const { data, isLoading } = useQuery({
    queryKey: ["dispatch-tracking"],
    queryFn: api.dispatchTracking,
    refetchInterval: 4_000,
  });

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Truck}
        title="Dispatch tracking"
        description="Where every invoice stands — ready, awaiting approval, dispatched, rejected. AI confidence shown per dispatch."
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
                  <th className="text-right">PDF</th>
                </tr>
              </thead>
              <tbody>
                {data.map((r) => (
                  <tr key={r.id}>
                    <td className="font-mono text-xs text-ink-700">{r.invoice_sequence_no ?? r.id.slice(0, 8)}</td>
                    <td>
                      <span className="font-medium text-ink-800">{r.client_code}</span>
                    </td>
                    <td className="text-ink-600">{r.period ?? "—"}</td>
                    <td className="text-right tnum font-semibold">{fmtMoney(r.total_incl_vat ?? r.amount, "AED")}</td>
                    <td>
                      <StatusBadge status={r.status} />
                      {r.rule_results_failed.length > 0 && (
                        <Badge tone="red"><AlertOctagon size={10} /> {r.rule_results_failed.length}</Badge>
                      )}
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
                    <td className="text-right">
                      <a href={`${API_BASE}/invoices/${r.id}/pdf`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-700 hover:text-brand-800 text-xs font-medium">
                        <FileText size={12} /> Open <ExternalLink size={10} />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

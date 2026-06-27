import { useQuery } from "@tanstack/react-query";
import { Radar, Zap } from "lucide-react";
import { api } from "../api";
import { fmtAED, fmtAge, isAutoDispatched } from "../lib";
import { PageHeader, StatusBadge, ConfidenceBadge, Badge, EmptyState, TableSkeleton } from "../ui";

export function FinOpsDispatchTracking() {
  const { data, isLoading } = useQuery({ queryKey: ["dispatch-tracking"], queryFn: api.dispatchTracking, refetchInterval: 5_000 });

  return (
    <div>
      <PageHeader icon={Radar} title="Dispatch tracking" description="Every invoice's dispatch state and client approval, end to end. ⚡ marks fully touchless dispatches." />
      <div className="card-flush">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>Invoice #</th><th>Client</th><th>Period</th><th className="text-right">Total (incl. VAT)</th><th>Status</th><th>Client approval</th><th>Confidence</th><th>Dispatched</th></tr>
            </thead>
            {isLoading ? <TableSkeleton rows={5} cols={8} /> : (
              <tbody>
                {data?.map((r) => {
                  const auto = isAutoDispatched(r.status) && !r.client_approval_status;
                  return (
                    <tr key={r.id}>
                      <td className="font-mono text-xs text-ink-600">{r.invoice_sequence_no ?? r.id.slice(0, 8)}</td>
                      <td className="font-medium text-ink-800">{r.client_code}</td>
                      <td className="text-ink-600">{r.period ?? "—"}</td>
                      <td className="text-right tnum font-medium">{fmtAED(r.total_incl_vat ?? r.amount)}</td>
                      <td>
                        <div className="inline-flex items-center gap-1">
                          <StatusBadge status={r.status} />
                          {auto && <Badge tone="brand"><Zap size={9} /> AUTO</Badge>}
                        </div>
                      </td>
                      <td><Badge tone={r.client_approval_status === "approved" ? "green" : r.client_approval_status === "rejected" ? "red" : "amber"} dot={false}>{r.client_approval_status ?? "pending"}</Badge></td>
                      <td><ConfidenceBadge value={r.confidence} /></td>
                      <td className="text-ink-500 text-xs whitespace-nowrap">{r.dispatch_attempted_at ? fmtAge(r.dispatch_attempted_at) + " ago" : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            )}
          </table>
        </div>
        {!isLoading && (!data || data.length === 0) && <EmptyState icon={Radar} title="No invoices to track yet" />}
      </div>
    </div>
  );
}

import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Send, ArrowLeft } from "lucide-react";
import { api } from "../api";
import { fmtAED } from "../lib";
import { PageHeader, Panel, Badge, EmptyState, TableSkeleton, StatusBadge } from "../ui";

/**
 * Per-client dispatch ordering queue — surfaces /dispatch/{client}/queue
 * which applies the client's `dispatch_order_rule` (asc_by_amount, by_emp_id,
 * etc.) to the order invoices will be sent. Lets ops see the queue exactly
 * as the dispatcher will work it.
 */
export function FinOpsDispatchQueue() {
  const { clientCode } = useParams<{ clientCode: string }>();
  const code = clientCode ?? "";

  const { data, isLoading } = useQuery({
    queryKey: ["dispatch-queue", code],
    queryFn: () => api.dispatchQueue(code),
    enabled: !!code,
    refetchInterval: 5_000,
  });

  return (
    <div>
      <PageHeader
        icon={Send}
        title={`Dispatch queue · ${code}`}
        description={data?.rule
          ? <span>Ordered by <span className="font-mono">{data.rule}</span> per this client's settings.</span>
          : "Per-client dispatch ordering — applies the client's dispatch_order_rule."
        }
        actions={
          <Link to="/console/dispatch/tracking" className="btn-outline btn-sm">
            <ArrowLeft size={13} /> All dispatched
          </Link>
        }
      />
      <Panel bodyClassName="p-0">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th><th>Invoice #</th><th>Period</th>
                <th className="text-right">Total (incl. VAT)</th>
                <th>Status</th>
              </tr>
            </thead>
            {isLoading ? <TableSkeleton rows={5} cols={5} /> : (
              <tbody>
                {data?.entries?.map((r, i) => (
                  <tr key={r.id}>
                    <td className="text-2xs text-ink-400 tnum">{r.dispatch_order_rank ?? i + 1}</td>
                    <td className="font-mono text-xs text-ink-600">{r.invoice_sequence_no ?? r.id.slice(0, 8)}</td>
                    <td className="text-ink-600">{r.period ?? "—"}</td>
                    <td className="text-right tnum font-medium">{fmtAED(r.total_incl_vat ?? r.amount)}</td>
                    <td><StatusBadge status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
        {!isLoading && (!data || data.entries.length === 0) && (
          <EmptyState icon={Send} title="Queue empty" hint="No invoices currently queued for dispatch for this client." />
        )}
        {data?.rule && (
          <div className="px-4 py-2 border-t border-ink-100 text-2xs text-ink-500">
            Ordering rule: <Badge tone="brand" dot={false}>{data.rule}</Badge>
          </div>
        )}
      </Panel>
    </div>
  );
}

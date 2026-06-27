import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ShieldCheck, Check, X, DollarSign } from "lucide-react";
import { api } from "../api";
import { fmtAED } from "../lib";
import { PageHeader, Badge, EmptyState, Spinner, TableSkeleton } from "../ui";
import { PaymentsModal } from "../components/PaymentsModal";
import type { FinanceQueueRow, Invoice } from "../types";

export function FinanceQueue() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["finance-queue"], queryFn: api.financeQueue, refetchInterval: 5_000 });
  const inval = () => { qc.invalidateQueries({ queryKey: ["finance-queue"] }); qc.invalidateQueries({ queryKey: ["invoices"] }); };
  const approve = useMutation({ mutationFn: (id: string) => api.financeApprove(id), onSuccess: inval });
  const reject = useMutation({ mutationFn: ({ id, reason }: { id: string; reason: string }) => api.financeReject(id, reason), onSuccess: inval });
  const [payFor, setPayFor] = useState<Invoice | null>(null);

  const asInvoice = (r: FinanceQueueRow): Invoice => ({
    id: r.id,
    timesheet_id: "",
    client_code: r.client_code,
    period: r.period,
    amount: r.amount,
    currency: r.currency ?? "AED",
    status: r.status,
    line_items: [],
    pdf_available: false,
    dispatched_at: null,
    invoice_sequence_no: r.invoice_sequence_no,
    total_incl_vat: r.total_incl_vat,
  });

  return (
    <div>
      <PageHeader icon={ShieldCheck} title="Finance approvals"
        description="Invoices at or above the client threshold, or with rule exceptions, require Finance sign-off before dispatch."
        actions={data ? <Badge tone={data.length ? "amber" : "green"}>{data.length} pending</Badge> : undefined} />

      <div className="card-flush">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>Invoice #</th><th>Client</th><th>Period</th><th className="text-right">Total (incl. VAT)</th><th className="text-right">Threshold</th><th>Exceptions</th><th className="text-right">Decision</th></tr>
            </thead>
            {isLoading ? <TableSkeleton rows={4} cols={7} /> : (
              <tbody>
                {data?.map((r) => (
                  <tr key={r.id}>
                    <td className="font-mono text-xs text-ink-600">{r.invoice_sequence_no ?? r.id.slice(0, 8)}</td>
                    <td><div className="font-medium text-ink-800">{r.client_code}</div><div className="text-2xs text-ink-400">{r.client_name}</div></td>
                    <td className="text-ink-600">{r.period ?? "—"}</td>
                    <td className="text-right tnum font-semibold text-ink-900">{fmtAED(r.total_incl_vat ?? r.amount)}</td>
                    <td className="text-right tnum text-ink-500">{fmtAED(r.threshold)}</td>
                    <td>{r.rule_failures?.length ? <Badge tone="red">{r.rule_failures.length} failed</Badge> : <span className="text-ink-300 text-xs">—</span>}</td>
                    <td>
                      <div className="flex items-center justify-end gap-1.5">
                        {r.status === "dispatched"
                          ? (
                            <button className="btn-outline btn-sm" onClick={() => setPayFor(asInvoice(r))}>
                              <DollarSign size={13} /> Record payment
                            </button>
                          ) : (
                            <>
                              <button className="btn-outline btn-sm" disabled={reject.isPending} onClick={() => { const x = prompt("Reason for rejection?"); if (x) reject.mutate({ id: r.id, reason: x }); }}><X size={13} /> Reject</button>
                              <button className="btn-primary btn-sm" disabled={approve.isPending} onClick={() => approve.mutate(r.id)}>{approve.isPending ? <Spinner /> : <Check size={13} />} Approve</button>
                            </>
                          )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
        {!isLoading && (!data || data.length === 0) && <EmptyState icon={ShieldCheck} title="Approval queue is clear" hint="No invoices currently need Finance sign-off." />}
      </div>

      {payFor && (
        <PaymentsModal invoice={payFor} onClose={() => setPayFor(null)} onDone={() => { setPayFor(null); inval(); }} />
      )}
    </div>
  );
}

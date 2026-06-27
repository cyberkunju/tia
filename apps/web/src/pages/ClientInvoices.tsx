import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ReceiptText, ExternalLink, Check, X } from "lucide-react";
import { api, API_BASE } from "../api";
import { fmtAED, vatBreakdown } from "../lib";
import { PageHeader, Badge, EmptyState, TableSkeleton, Spinner } from "../ui";
import type { Invoice } from "../types";

function approvalTone(s?: string | null) {
  return s === "approved" ? "green" : s === "rejected" ? "red" : "amber";
}

export function ClientInvoices() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["invoices"], queryFn: () => api.listInvoices(), refetchInterval: 4_000 });

  const approve = useMutation({ mutationFn: (id: string) => api.clientApprove(id), onSuccess: () => qc.invalidateQueries({ queryKey: ["invoices"] }) });
  const reject = useMutation({ mutationFn: ({ id, reason }: { id: string; reason: string }) => api.clientReject(id, reason), onSuccess: () => qc.invalidateQueries({ queryKey: ["invoices"] }) });

  const totals = (inv: Invoice) => {
    if (inv.total_incl_vat != null && inv.vat_amount != null) return { subtotal: inv.total_excl_vat ?? inv.amount, vat: inv.vat_amount, total: inv.total_incl_vat };
    return vatBreakdown(inv.amount);
  };

  return (
    <div>
      <PageHeader icon={ReceiptText} title="Invoices" description="Tax invoices issued by TASC — review, approve, or raise a query. Amounts in AED incl. 5% VAT." />
      <div className="card-flush">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Invoice #</th><th>Period</th>
                <th className="text-right">Subtotal</th><th className="text-right">VAT</th><th className="text-right">Total (AED)</th>
                <th>Approval</th><th className="text-right">Actions</th>
              </tr>
            </thead>
            {isLoading ? <TableSkeleton rows={5} cols={7} /> : (
              <tbody>
                {data?.map((inv) => {
                  const t = totals(inv);
                  const pending = inv.client_approval_status !== "approved";
                  return (
                    <tr key={inv.id}>
                      <td className="font-mono text-xs text-ink-600">{inv.invoice_sequence_no ?? inv.id.slice(0, 8)}</td>
                      <td className="text-ink-600">{inv.period ?? "—"}</td>
                      <td className="text-right tnum text-ink-600">{fmtAED(t.subtotal)}</td>
                      <td className="text-right tnum text-ink-500">{fmtAED(t.vat)}</td>
                      <td className="text-right tnum font-semibold text-ink-900">{fmtAED(t.total)}</td>
                      <td><Badge tone={approvalTone(inv.client_approval_status)} dot={false}>{inv.client_approval_status ?? "pending"}</Badge></td>
                      <td>
                        <div className="flex items-center justify-end gap-1.5">
                          {inv.pdf_available && <a className="btn-ghost btn-sm" href={`${API_BASE}/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer"><ExternalLink size={13} /></a>}
                          {pending && (
                            <>
                              <button className="btn-outline btn-sm" disabled={reject.isPending} onClick={() => { const r = prompt("Reason for rejecting this invoice?"); if (r) reject.mutate({ id: inv.id, reason: r }); }}><X size={13} /> Reject</button>
                              <button className="btn-primary btn-sm" disabled={approve.isPending} onClick={() => approve.mutate(inv.id)}>{approve.isPending ? <Spinner /> : <Check size={13} />} Approve</button>
                            </>
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
        {!isLoading && (!data || data.length === 0) && <EmptyState icon={ReceiptText} title="No invoices yet" hint="Approved timesheets generate tax invoices that appear here." />}
      </div>
    </div>
  );
}

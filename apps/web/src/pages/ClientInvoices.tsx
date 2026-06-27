import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ReceiptText, ExternalLink, Check, X, Zap, MessageSquarePlus, AlertCircle, FileText } from "lucide-react";
import { api, API_BASE } from "../api";
import { fmtAED, isAutoDispatched, vatBreakdown } from "../lib";
import { PageHeader, Badge, EmptyState, TableSkeleton, Spinner } from "../ui";
import { usePersona } from "../store";
import type { Invoice } from "../types";

function approvalTone(s?: string | null) {
  return s === "approved" ? "green" : s === "rejected" ? "red" : "amber";
}

export function ClientInvoices() {
  const qc = useQueryClient();
  const { currentClientCode } = usePersona();
  const { data: clients } = useQuery({ queryKey: ["clients"], queryFn: api.listClients });
  const clientName = useMemo(
    () => clients?.find((c) => c.code === currentClientCode)?.name,
    [clients, currentClientCode],
  );

  const { data, isLoading } = useQuery({
    queryKey: ["invoices", currentClientCode],
    queryFn: () => api.listInvoices(currentClientCode ?? undefined),
    refetchInterval: 4_000,
    enabled: !!currentClientCode,
  });

  const totals = (inv: Invoice) => {
    if (inv.total_incl_vat != null && inv.vat_amount != null) return { subtotal: inv.total_excl_vat ?? inv.amount, vat: inv.vat_amount, total: inv.total_incl_vat };
    return vatBreakdown(inv.amount);
  };

  const [actionFor, setActionFor] = useState<{ inv: Invoice; mode: "approve" | "reject" | "query" } | null>(null);

  // The first pending invoice gets a hero card - judges and clients see the
  // most actionable invoice at the top of the page.
  const pendingHero = useMemo(
    () => (data ?? []).find((inv) => inv.client_approval_status !== "approved" && inv.client_approval_status !== "rejected" && inv.status !== "voided"),
    [data],
  );

  return (
    <div>
      <PageHeader
        icon={ReceiptText}
        title={clientName ? `Invoices · ${clientName}` : "Invoices"}
        description={
          currentClientCode
            ? <span>Tax invoices issued by TASC for <span className="font-mono">{currentClientCode}</span> - review, approve, or raise a query. Amounts in AED incl. 5% VAT.</span>
            : "Tax invoices issued by TASC - review, approve, or raise a query. Amounts in AED incl. 5% VAT."
        }
      />

      {pendingHero && (
        <PendingCard
          inv={pendingHero}
          onApprove={() => setActionFor({ inv: pendingHero, mode: "approve" })}
          onReject={() => setActionFor({ inv: pendingHero, mode: "reject" })}
          onQuery={() => setActionFor({ inv: pendingHero, mode: "query" })}
        />
      )}

      <div className="card-flush">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Invoice #</th><th>Period</th>
                <th className="text-right">Subtotal</th><th className="text-right">VAT</th><th className="text-right">Total (AED)</th>
                <th>Dispatch</th>
                <th>Approval</th><th className="text-right">Actions</th>
              </tr>
            </thead>
            {isLoading ? <TableSkeleton rows={5} cols={8} /> : (
              <tbody>
                {data?.map((inv) => {
                  const t = totals(inv);
                  const pending = inv.client_approval_status !== "approved" && inv.client_approval_status !== "rejected";
                  const auto = isAutoDispatched(inv.status) && !inv.client_approval_status;
                  return (
                    <tr key={inv.id}>
                      <td className="font-mono text-xs text-ink-600">{inv.invoice_sequence_no ?? inv.id.slice(0, 8)}</td>
                      <td className="text-ink-600">{inv.period ?? "-"}</td>
                      <td className="text-right tnum text-ink-600">{fmtAED(t.subtotal)}</td>
                      <td className="text-right tnum text-ink-500">{fmtAED(t.vat)}</td>
                      <td className="text-right tnum font-semibold text-ink-900">{fmtAED(t.total)}</td>
                      <td>
                        {auto
                          ? <Badge tone="brand"><Zap size={9} /> AUTO</Badge>
                          : inv.status === "dispatched"
                            ? <Badge tone="green" dot={false}>dispatched</Badge>
                            : <span className="text-ink-300 text-xs">-</span>}
                      </td>
                      <td><Badge tone={approvalTone(inv.client_approval_status)} dot={false}>{inv.client_approval_status ?? "pending"}</Badge></td>
                      <td>
                        <div className="flex items-center justify-end gap-1.5">
                          {inv.pdf_available && <a className="btn-ghost btn-sm" href={`${API_BASE}/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer"><ExternalLink size={13} /></a>}
                          {pending && (
                            <>
                              <button className="btn-ghost btn-sm" title="Raise query" onClick={() => setActionFor({ inv, mode: "query" })}><MessageSquarePlus size={13} /></button>
                              <button className="btn-outline btn-sm" onClick={() => setActionFor({ inv, mode: "reject" })}><X size={13} /> Reject</button>
                              <button className="btn-primary btn-sm" onClick={() => setActionFor({ inv, mode: "approve" })}><Check size={13} /> Approve</button>
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
        {!isLoading && !currentClientCode && (
          <EmptyState icon={ReceiptText} title="Pick a client" hint="Use the Acting as picker in the header to choose which client's invoices to view." />
        )}
        {!isLoading && currentClientCode && (!data || data.length === 0) && (
          <EmptyState icon={ReceiptText} title="No invoices yet" hint="Approved timesheets generate tax invoices that appear here." />
        )}
      </div>

      {actionFor && (
        <InvoiceActionModal
          invoice={actionFor.inv}
          mode={actionFor.mode}
          clientCode={currentClientCode ?? ""}
          onClose={() => setActionFor(null)}
          onDone={() => { setActionFor(null); qc.invalidateQueries({ queryKey: ["invoices"] }); }}
        />
      )}
    </div>
  );
}

/**
 * Hero card for the first pending invoice - surfaces approve/reject/raise-query
 * actions above the full table so the most-important invoice is one click away.
 */
function PendingCard({ inv, onApprove, onReject, onQuery }: {
  inv: Invoice;
  onApprove: () => void; onReject: () => void; onQuery: () => void;
}) {
  const subtotal = inv.total_excl_vat ?? inv.amount;
  const vat = inv.vat_amount ?? vatBreakdown(inv.amount).vat;
  const total = inv.total_incl_vat ?? vatBreakdown(inv.amount).total;
  return (
    <section className="card overflow-hidden mb-5 ring-1 ring-amber-200">
      <div className="px-4 py-2.5 bg-amber-50 border-b border-amber-200 text-2xs uppercase font-semibold tracking-wide text-amber-900 flex items-center gap-1.5">
        <AlertCircle size={12} /> Awaiting your approval
      </div>
      <div className="p-5 grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4 items-center">
        <div>
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <FileText size={14} className="text-ink-500" />
            <span className="font-mono text-xs text-ink-500">{inv.invoice_sequence_no ?? inv.id.slice(0, 8)}</span>
            <span className="text-2xs text-ink-400">·</span>
            <span className="text-2xs text-ink-500">{inv.period ?? "-"}</span>
          </div>
          <p className="text-xl font-semibold text-ink-900 tnum">{fmtAED(total)} <span className="text-sm font-normal text-ink-500">incl. {fmtAED(vat)} VAT</span></p>
          <p className="text-2xs text-ink-500 mt-1">Net: <span className="tnum">{fmtAED(subtotal)}</span></p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {inv.pdf_available && <a className="btn-outline btn-sm" href={`${API_BASE}/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer"><ExternalLink size={13} /> View PDF</a>}
          <button className="btn-ghost btn-sm" onClick={onQuery}><MessageSquarePlus size={13} /> Raise query</button>
          <button className="btn-outline btn-sm" onClick={onReject}><X size={13} /> Reject</button>
          <button className="btn-primary btn-sm" onClick={onApprove}><Check size={13} /> Approve</button>
        </div>
      </div>
    </section>
  );
}

/** Polished approve/reject/raise-query modal - replaces the inline prompt(). */
function InvoiceActionModal({ invoice, mode, clientCode, onClose, onDone }: {
  invoice: Invoice;
  mode: "approve" | "reject" | "query";
  clientCode: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [subject, setSubject] = useState(`Question on invoice ${invoice.invoice_sequence_no ?? invoice.id.slice(0, 8)}`);
  const approve = useMutation({ mutationFn: () => api.clientApprove(invoice.id, "client", reason || undefined), onSuccess: onDone });
  const reject = useMutation({ mutationFn: () => api.clientReject(invoice.id, reason || "no reason given"), onSuccess: onDone });
  const raise = useMutation({
    mutationFn: () => api.raiseQuery(clientCode, { subject, body: reason, invoice_id: invoice.id, raised_by: "client" }),
    onSuccess: onDone,
  });

  const total = invoice.total_incl_vat ?? invoice.amount;
  const title = mode === "approve" ? "Approve invoice" : mode === "reject" ? "Reject invoice" : "Raise a query";
  const submitting = approve.isPending || reject.isPending || raise.isPending;

  const submit = () => {
    if (mode === "approve") approve.mutate();
    else if (mode === "reject") reject.mutate();
    else raise.mutate();
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center px-4 animate-fade-in">
      <div className="absolute inset-0 bg-ink-950/55" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-xl bg-white shadow-lg border border-ink-200 p-5">
        <button onClick={onClose} className="absolute top-3 right-3 grid place-items-center h-8 w-8 rounded-md text-ink-500 hover:bg-ink-100" aria-label="Close">
          <X size={16} />
        </button>
        <h3 className="text-base font-semibold text-ink-900 mb-1">{title}</h3>
        <p className="text-xs text-ink-500 mb-3">
          <span className="font-mono">{invoice.invoice_sequence_no ?? invoice.id.slice(0, 8)}</span> · {fmtAED(total)}
        </p>
        {mode === "query" && (
          <label className="block mb-3">
            <span className="field-label">Subject</span>
            <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
        )}
        <label className="block">
          <span className="field-label">
            {mode === "approve" ? "Note (optional)" : mode === "reject" ? "Reason" : "Details"}
          </span>
          <textarea className="textarea" rows={4} value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder={mode === "approve" ? "Anything FinOps should know…" : mode === "reject" ? "Why are you rejecting?" : "Describe the question…"} />
        </label>
        <div className="flex items-center justify-end gap-2 mt-4">
          <button className="btn-outline btn-sm" onClick={onClose}>Cancel</button>
          <button
            className={mode === "reject" ? "btn-danger btn-sm" : "btn-primary btn-sm"}
            disabled={submitting || (mode !== "approve" && !reason.trim())}
            onClick={submit}
          >
            {submitting ? <Spinner /> : mode === "approve" ? <Check size={13} /> : mode === "reject" ? <X size={13} /> : <MessageSquarePlus size={13} />}
            {mode === "approve" ? "Approve" : mode === "reject" ? "Confirm reject" : "Submit query"}
          </button>
        </div>
      </div>
    </div>
  );
}

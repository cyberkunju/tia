import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ReceiptText, ExternalLink, CheckCircle2, XCircle, MessageSquarePlus,
  Loader2, AlertCircle, FileText,
} from "lucide-react";
import { api, API_BASE } from "../api";
import { fmtMoney } from "../lib";
import { PageHeader, StatusBadge, EmptyState, TableSkeleton, Panel, Badge } from "../ui";
import type { Invoice } from "../types";

export function ClientInvoices() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["invoices"],
    queryFn: () => api.listInvoices(),
    refetchInterval: 4_000,
  });

  const pending = useMemo(
    () => (data ?? []).filter((i) => i.client_approval_status === "pending"),
    [data],
  );
  const approved = useMemo(
    () => (data ?? []).filter((i) => i.client_approval_status === "approved" || i.status === "dispatched"),
    [data],
  );
  const rejected = useMemo(
    () => (data ?? []).filter((i) => i.client_approval_status === "rejected" || i.status === "rejected"),
    [data],
  );

  const [modal, setModal] = useState<null | { mode: "approve" | "reject" | "query"; invoice: Invoice }>(null);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={ReceiptText}
        title="Your invoices"
        description="Review and approve invoices for the work TASC delivered. Raise a query if anything looks off."
      />

      {pending.length > 0 && (
        <Panel
          title={<span>Awaiting your approval <span className="text-2xs font-medium text-amber-800 bg-amber-100 border border-amber-200 rounded px-1.5 py-0.5 ml-1.5">{pending.length}</span></span>}
          subtitle="Approve to release for dispatch, or raise a query if anything looks wrong."
        >
          <div className="space-y-3">
            {pending.map((inv) => (
              <PendingCard
                key={inv.id}
                invoice={inv}
                onApprove={() => setModal({ mode: "approve", invoice: inv })}
                onReject={() => setModal({ mode: "reject", invoice: inv })}
                onQuery={() => setModal({ mode: "query", invoice: inv })}
              />
            ))}
          </div>
        </Panel>
      )}

      <Panel title="All invoices" subtitle="Generated for your account">
        <div className="-m-4">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Sequence</th>
                  <th>Period</th>
                  <th className="text-right">Excl VAT</th>
                  <th className="text-right">VAT</th>
                  <th className="text-right">Total</th>
                  <th>Status</th>
                  <th>Your approval</th>
                  <th className="text-right">PDF</th>
                </tr>
              </thead>
              {isLoading ? (
                <TableSkeleton rows={5} cols={8} />
              ) : (
                <tbody>
                  {(data ?? []).map((inv) => (
                    <tr key={inv.id}>
                      <td className="font-mono text-xs text-ink-700">{inv.invoice_sequence_no ?? inv.id.slice(0, 8)}</td>
                      <td className="text-ink-600">{inv.period ?? "—"}</td>
                      <td className="text-right tnum">{fmtMoney(inv.total_excl_vat ?? inv.amount, inv.currency)}</td>
                      <td className="text-right tnum text-ink-500">{fmtMoney(inv.vat_amount ?? 0, inv.currency)}</td>
                      <td className="text-right tnum font-semibold">{fmtMoney(inv.total_incl_vat ?? inv.amount, inv.currency)}</td>
                      <td><StatusBadge status={inv.status} /></td>
                      <td>{approvalCell(inv)}</td>
                      <td className="text-right">
                        {inv.pdf_available ? (
                          <a className="inline-flex items-center gap-1 text-brand-700 hover:text-brand-800 text-xs font-medium" href={`${API_BASE}/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer">
                            Open <ExternalLink size={12} />
                          </a>
                        ) : <span className="text-ink-300 text-xs">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              )}
            </table>
          </div>
          {!isLoading && (!data || data.length === 0) && (
            <EmptyState icon={ReceiptText} title="No invoices yet" hint="Submit a timesheet and TASC will generate the invoice here." />
          )}
        </div>
      </Panel>

      {approved.length > 0 || rejected.length > 0 ? (
        <div className="grid sm:grid-cols-3 gap-3 text-xs text-ink-500">
          <span>Pending: <strong className="text-amber-700">{pending.length}</strong></span>
          <span>Approved: <strong className="text-emerald-700">{approved.length}</strong></span>
          <span>Rejected: <strong className="text-red-700">{rejected.length}</strong></span>
        </div>
      ) : null}

      {modal && (
        <InvoiceActionModal
          mode={modal.mode}
          invoice={modal.invoice}
          onClose={() => setModal(null)}
          onDone={() => {
            qc.invalidateQueries({ queryKey: ["invoices"] });
            setModal(null);
          }}
        />
      )}
    </div>
  );
}

function approvalCell(inv: Invoice) {
  if (inv.client_approval_status === "approved") return <Badge tone="green">Approved</Badge>;
  if (inv.client_approval_status === "rejected") return <Badge tone="red">Rejected</Badge>;
  if (inv.client_approval_status === "pending") return <Badge tone="amber">Pending</Badge>;
  return <span className="text-ink-400 text-xs">—</span>;
}

function PendingCard({ invoice, onApprove, onReject, onQuery }: {
  invoice: Invoice;
  onApprove: () => void;
  onReject: () => void;
  onQuery: () => void;
}) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <FileText size={14} className="text-amber-700" />
            <span className="font-mono text-xs text-ink-700">{invoice.invoice_sequence_no ?? invoice.id.slice(0, 8)}</span>
            <Badge tone="amber">Pending your approval</Badge>
          </div>
          <h3 className="text-sm font-semibold text-ink-900">
            {invoice.period} ·{" "}
            <span className="tnum">{fmtMoney(invoice.total_incl_vat ?? invoice.amount, invoice.currency)}</span>
            <span className="text-2xs text-ink-500 font-normal ml-1">(incl. VAT)</span>
          </h3>
          <p className="mt-0.5 text-xs text-ink-600">
            {invoice.line_items?.length ?? 0} employee{(invoice.line_items?.length ?? 0) === 1 ? "" : "s"} billed
            {invoice.due_date && <span> · due {invoice.due_date}</span>}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {invoice.pdf_available && (
            <a href={`${API_BASE}/invoices/${invoice.id}/pdf`} target="_blank" rel="noreferrer"
              className="btn-outline btn-sm">
              <FileText size={14} /> Open PDF
            </a>
          )}
          <button onClick={onQuery} className="btn-outline btn-sm">
            <MessageSquarePlus size={14} /> Raise query
          </button>
          <button onClick={onReject} className="btn-danger btn-sm">
            <XCircle size={14} /> Reject
          </button>
          <button onClick={onApprove} className="inline-flex items-center gap-1.5 rounded-md bg-brand-500 hover:bg-brand-400 text-teal-950 text-xs font-semibold px-3 py-1.5 shadow-xs">
            <CheckCircle2 size={14} /> Approve
          </button>
        </div>
      </div>
    </div>
  );
}

function InvoiceActionModal({
  mode, invoice, onClose, onDone,
}: { mode: "approve" | "reject" | "query"; invoice: Invoice; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [subject, setSubject] = useState(mode === "query" ? `Question about invoice ${invoice.invoice_sequence_no ?? invoice.id.slice(0, 8)}` : "");

  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === "approve") return api.clientApprove(invoice.id, "client", reason || undefined);
      if (mode === "reject") return api.clientReject(invoice.id, reason || "no reason given", "client");
      await api.raiseQuery(invoice.client_code, {
        subject: subject || "Question",
        body: reason,
        invoice_id: invoice.id,
        raised_by: "client",
      });
      return { status: "open" };
    },
    onSuccess: onDone,
  });

  const titles: Record<typeof mode, string> = {
    approve: "Approve invoice",
    reject: "Reject invoice",
    query: "Raise a query",
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center px-4 animate-fade-in">
      <div className="absolute inset-0 bg-ink-950/45" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-xl bg-white shadow-lg border border-ink-200 p-5">
        <h3 className="text-base font-semibold text-ink-900">{titles[mode]}</h3>
        <p className="mt-0.5 text-xs text-ink-500">
          {invoice.invoice_sequence_no ?? invoice.id.slice(0, 8)} · {fmtMoney(invoice.total_incl_vat ?? invoice.amount, invoice.currency)}
        </p>

        {mode === "query" && (
          <div className="mt-3">
            <label className="field-label">Subject</label>
            <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
        )}

        <div className="mt-3">
          <label className="field-label">
            {mode === "reject" ? "Reason for rejection" : mode === "approve" ? "Comment (optional)" : "Your question"}
          </label>
          <textarea
            className="textarea"
            rows={4}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={
              mode === "reject" ? "What's wrong? (this opens a thread for FinOps to follow up)" :
              mode === "approve" ? "Optional note" :
              "What's your question?"
            }
            autoFocus
          />
        </div>

        {mutation.isError && (
          <div className="mt-3 rounded-md border border-red-200 bg-red-50 text-red-900 text-xs px-3 py-2">
            <AlertCircle size={12} className="inline mr-1" />{String(mutation.error)}
          </div>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button onClick={onClose} className="btn-outline btn-sm">Cancel</button>
          <button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || (mode === "reject" && !reason.trim()) || (mode === "query" && !reason.trim())}
            className={`inline-flex items-center gap-1.5 rounded-md text-sm font-semibold px-4 py-2 shadow-xs disabled:opacity-60
              ${mode === "reject" ? "bg-red-600 text-white hover:bg-red-700" : "bg-brand-500 hover:bg-brand-400 text-teal-950"}`}
          >
            {mutation.isPending ? <><Loader2 size={14} className="animate-spin" /> Submitting…</> : titles[mode]}
          </button>
        </div>
      </div>
    </div>
  );
}

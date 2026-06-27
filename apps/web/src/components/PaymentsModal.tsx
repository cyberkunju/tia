import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, X, DollarSign, Check } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { fmtAED } from "../lib";
import type { Invoice } from "../types";

/** Record a payment against an invoice — used by FinanceQueue dispatched rows. */
export function PaymentsModal({ invoice, onClose, onDone }: {
  invoice: Invoice;
  onClose: () => void;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const due = invoice.total_incl_vat ?? invoice.amount;
  const [amount, setAmount] = useState(String(due));
  const [method, setMethod] = useState("bank_transfer");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");

  const pay = useMutation({
    mutationFn: () => api.payInvoice(invoice.id, {
      amount: Number(amount) || 0,
      method,
      reference: reference || undefined,
      notes: notes || undefined,
      paid_by: "finance",
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payments", invoice.id] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["statement"] });
      onDone();
    },
  });

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center px-4 animate-fade-in">
      <div className="absolute inset-0 bg-ink-950/55" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-xl bg-white shadow-lg border border-ink-200 p-5">
        <button onClick={onClose} className="absolute top-3 right-3 grid place-items-center h-8 w-8 rounded-md text-ink-500 hover:bg-ink-100"><X size={16} /></button>
        <div className="flex items-center gap-2 mb-1">
          <DollarSign size={16} className="text-emerald-600" />
          <h3 className="text-base font-semibold text-ink-900">Record payment</h3>
        </div>
        <p className="text-xs text-ink-500 mb-4">
          <span className="font-mono">{invoice.invoice_sequence_no ?? invoice.id.slice(0, 8)}</span> · due {fmtAED(due)}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <label className="block col-span-2">
            <span className="field-label">Amount (AED)</span>
            <input className="input tnum" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="block">
            <span className="field-label">Method</span>
            <select className="select" value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="bank_transfer">Bank transfer</option>
              <option value="wire">Wire</option>
              <option value="card">Card</option>
              <option value="cheque">Cheque</option>
              <option value="ach">ACH</option>
            </select>
          </label>
          <label className="block">
            <span className="field-label">Reference</span>
            <input className="input font-mono" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="ENBD-2026-…" />
          </label>
          <label className="block col-span-2">
            <span className="field-label">Notes (optional)</span>
            <textarea className="textarea text-sm" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </div>
        {pay.isError && (
          <div className="rounded-md border border-red-200 bg-red-50 text-red-900 text-xs px-3 py-2 mt-3">
            {pay.error instanceof Error ? pay.error.message : String(pay.error)}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 mt-4">
          <button className="btn-outline btn-sm" onClick={onClose}>Cancel</button>
          <button
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-3 py-1.5 shadow-xs disabled:opacity-60"
            disabled={pay.isPending || !Number(amount)}
            onClick={() => pay.mutate()}
          >
            {pay.isPending ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Record payment
          </button>
        </div>
      </div>
    </div>
  );
}

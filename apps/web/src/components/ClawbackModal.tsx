/**
 * ClawbackModal - state-aware modal.
 *
 * Render path is driven entirely by the eligibility endpoint:
 *   void                              → "Void this invoice"
 *   credit_note                       → "Issue a Tax Credit Note (UAE Art. 60)"
 *   credit_note_with_refund_pending   → above + refund warning chip
 *
 * No raw rule_results JSON. Everything is human prose.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertOctagon, AlertTriangle, CheckCircle2, Loader2, RotateCcw, ScrollText, X,
} from "lucide-react";
import { api } from "../api";
import type {
  AdjustmentType, ClawbackEligibility, ClawbackReasonCode, ClawbackResponse, Invoice,
} from "../types";
import { fmtMoney } from "../lib";

const REASON_LABELS: Record<ClawbackReasonCode, string> = {
  PRICING_ERROR: "Pricing error",
  GOODS_RETURNED: "Services returned / cancelled",
  DISCOUNT: "Post-sale discount granted",
  DUPLICATE: "Duplicate invoice",
  OTHER: "Other",
};

export function ClawbackModal({
  invoice, onClose, onDone,
}: {
  invoice: Invoice;
  onClose: () => void;
  onDone: (resp: ClawbackResponse) => void;
}) {
  const qc = useQueryClient();
  const { data: elig, isLoading } = useQuery({
    queryKey: ["clawback-eligibility", invoice.id],
    queryFn: () => api.clawbackEligibility(invoice.id),
  });

  const [reasonCode, setReasonCode] = useState<ClawbackReasonCode>("PRICING_ERROR");
  const [reasonText, setReasonText] = useState("");
  const [adjustmentType, setAdjustmentType] = useState<AdjustmentType>("CREDIT_TO_CLIENT");
  const [partial, setPartial] = useState(false);
  const [partialAmount, setPartialAmount] = useState("");
  const [disputedHours, setDisputedHours] = useState("");

  // pick a sensible default reason_code once eligibility loads
  useEffect(() => {
    if (elig?.valid_reason_codes && elig.valid_reason_codes.length > 0) {
      if (!elig.valid_reason_codes.includes(reasonCode)) {
        setReasonCode(elig.valid_reason_codes[0]);
      }
    }
  }, [elig, reasonCode]);

  const mutation = useMutation({
    mutationFn: () =>
      api.clawback(invoice.id, {
        by_user: "finops",
        reason_code: reasonCode,
        reason_text: reasonText.trim() || undefined,
        adjustment_type: adjustmentType,
        partial_amount: partial && partialAmount ? Number(partialAmount) : undefined,
        disputed_hours: partial && disputedHours ? Number(disputedHours) : undefined,
      }),
    onSuccess: (resp) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["dispatch-tracking"] });
      qc.invalidateQueries({ queryKey: ["events", invoice.id] });
      onDone(resp);
    },
  });

  const action = elig?.action_when_clawed_back ?? null;
  const heading = useMemo(() => {
    if (!action) return "Clawback";
    if (action === "void") return "Void this invoice";
    if (action === "credit_note") return "Issue a Tax Credit Note";
    return "Issue a Tax Credit Note + flag for refund";
  }, [action]);

  const submitLabel = useMemo(() => {
    if (!action) return "Submit";
    if (action === "void") return "Void invoice";
    return "Issue credit note";
  }, [action]);

  const urgency = elig?.urgency;
  void urgency;
  const validAdjustmentTypes = elig?.valid_adjustment_types ?? [
    "CREDIT_TO_CLIENT", "DEDUCT_FROM_NEXT_INVOICE", "DEDUCT_FROM_PAYROLL",
    "INTERNAL_WRITE_OFF", "MANUAL_REVIEW",
  ];
  const adjustmentLabels: Record<string, string> = elig?.adjustment_type_labels ?? {};

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center px-4 animate-fade-in">
      <div className="absolute inset-0 bg-ink-950/55" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-xl bg-white shadow-lg border border-ink-200 p-5 max-h-[88vh] overflow-y-auto">
        <button onClick={onClose} className="absolute top-3 right-3 grid place-items-center h-8 w-8 rounded-md text-ink-500 hover:bg-ink-100" aria-label="Close">
          <X size={16} />
        </button>

        <div className="flex items-center gap-2 mb-1">
          {action === "void" ? <RotateCcw size={16} className="text-amber-700" /> :
            <ScrollText size={16} className="text-amber-700" />}
          <h3 className="text-base font-semibold text-ink-900">{heading}</h3>
        </div>
        <p className="text-xs text-ink-500 mb-3">
          Invoice <span className="font-mono">{invoice.invoice_sequence_no ?? invoice.id.slice(0, 8)}</span>
          {" · "}{fmtMoney(invoice.total_incl_vat ?? invoice.amount, invoice.currency)}
        </p>

        {isLoading ? (
          <div className="text-xs text-ink-500 inline-flex items-center gap-1.5">
            <Loader2 size={14} className="animate-spin" /> Checking eligibility…
          </div>
        ) : !action ? (
          <div className="rounded-md border border-ink-200 bg-ink-50 px-3 py-2 text-sm text-ink-700">
            <strong>Already settled.</strong> {elig?.reason ?? "Clawback not valid from this state."}
          </div>
        ) : (
          <>
            <UAEArt60Banner elig={elig!} />

            {/* Reason */}
            <div className="mb-3">
              <label className="field-label">Reason</label>
              <select className="select" value={reasonCode} onChange={(e) => setReasonCode(e.target.value as ClawbackReasonCode)}>
                {(elig?.valid_reason_codes ?? Object.keys(REASON_LABELS)).map((c) => (
                  <option key={c} value={c}>{REASON_LABELS[c as ClawbackReasonCode] ?? c}</option>
                ))}
              </select>
            </div>

            <div className="mb-3">
              <label className="field-label">Notes (optional)</label>
              <textarea
                className="textarea text-sm"
                rows={2}
                value={reasonText}
                onChange={(e) => setReasonText(e.target.value)}
                placeholder={action === "void" ? "Why void it?" : "Explain the adjustment to FinOps + the client."}
              />
            </div>

            {/* Partial + adjustment shown only on credit-note paths */}
            {action !== "void" && (
              <>
                <div className="mb-3 rounded-md border border-ink-200 bg-ink-50/40 px-3 py-2">
                  <label className="inline-flex items-center gap-2 text-sm font-medium text-ink-800">
                    <input
                      type="checkbox"
                      checked={partial}
                      onChange={(e) => setPartial(e.target.checked)}
                      className="rounded border-ink-300"
                    />
                    Partial clawback (don't credit the whole invoice)
                  </label>
                  {partial && (
                    <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <label className="field-label">Disputed amount (AED)</label>
                        <input
                          className="input tnum"
                          inputMode="decimal"
                          value={partialAmount}
                          onChange={(e) => setPartialAmount(e.target.value)}
                          placeholder="e.g. 200"
                        />
                      </div>
                      <div>
                        <label className="field-label">Disputed hours</label>
                        <input
                          className="input tnum"
                          inputMode="decimal"
                          value={disputedHours}
                          onChange={(e) => setDisputedHours(e.target.value)}
                          placeholder="e.g. 4"
                        />
                      </div>
                    </div>
                  )}
                </div>

                <div className="mb-3">
                  <label className="field-label">Adjustment type</label>
                  <select className="select" value={adjustmentType} onChange={(e) => setAdjustmentType(e.target.value as AdjustmentType)}>
                    {validAdjustmentTypes.map((t) => (
                      <option key={t} value={t}>
                        {adjustmentLabels[t] ?? t}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-2xs text-ink-500">
                    Source timesheet will be marked for re-review. The corrected timesheet must be re-uploaded by FinOps.
                  </p>
                </div>

                {action === "credit_note_with_refund_pending" && (
                  <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900 inline-flex items-center gap-2">
                    <AlertOctagon size={13} className="shrink-0" />
                    A refund will be required - flagged for manual bank processing.
                  </div>
                )}
              </>
            )}

            {mutation.isError && (
              <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
                {String(mutation.error)}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 mt-4">
              <button onClick={onClose} className="btn-outline btn-sm">Cancel</button>
              <button
                onClick={() => mutation.mutate()}
                disabled={mutation.isPending}
                className={action === "void"
                  ? "btn-danger btn-sm"
                  : "inline-flex items-center gap-1.5 rounded-md bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold px-3 py-1.5 shadow-xs disabled:opacity-60"
                }
              >
                {mutation.isPending ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                {submitLabel}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function UAEArt60Banner({ elig }: { elig: ClawbackEligibility }) {
  if (elig.action_when_clawed_back === "void") {
    return (
      <div className="mb-3 rounded-md border border-ink-200 bg-ink-50 px-3 py-2 text-xs text-ink-700">
        <strong>Pre-dispatch void.</strong> {elig.explanation}
      </div>
    );
  }
  const days = elig.days_remaining ?? 14;
  const tone =
    elig.urgency === "urgent"
      ? "border-red-300 bg-red-50 text-red-900"
      : elig.urgency === "warning"
        ? "border-amber-300 bg-amber-50 text-amber-900"
        : "border-teal-200 bg-teal-50 text-teal-900";
  return (
    <div className={`mb-3 rounded-md border px-3 py-2 text-xs ${tone}`}>
      <div className="flex items-center gap-1.5 font-semibold">
        {elig.urgency === "urgent" ? <AlertOctagon size={13} /> : <AlertTriangle size={13} />}
        UAE FTA - Tax Credit Note must be issued within 14 days · {days} day{days === 1 ? "" : "s"} remaining
      </div>
      <p className="mt-1 opacity-90">
        Issued under UAE VAT Law Articles 60 + 62 · Decision No. 7 of 2019 (combined Tax Invoice / Tax Credit Note document).
        Source timesheet will be marked for re-review; a transparent thread is opened on the client portal.
      </p>
    </div>
  );
}

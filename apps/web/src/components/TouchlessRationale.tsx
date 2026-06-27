/**
 * TouchlessRationale - "Why touchless?" modal.
 *
 * Reads the audit timeline (events) for this invoice and finds the
 * `auto_dispatched_within_tolerance` event. Renders the rationale as PROSE
 * + rule chips. No raw JSON.
 */

import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Hash, ScrollText, Sparkles, X, Zap } from "lucide-react";
import { api } from "../api";
import { fmtMoney } from "../lib";
import type { EventRow, Invoice } from "../types";

export function TouchlessRationale({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const { data: events, isLoading } = useQuery({
    queryKey: ["events", invoice.id],
    queryFn: () => api.listEvents(invoice.id, 100),
  });

  const auto = (events ?? []).find((e: EventRow) => e.action === "auto_dispatched_within_tolerance");

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center px-4 animate-fade-in">
      <div className="absolute inset-0 bg-ink-950/55" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-xl bg-white shadow-lg border border-ink-200 p-5 max-h-[88vh] overflow-y-auto">
        <button onClick={onClose} className="absolute top-3 right-3 grid place-items-center h-8 w-8 rounded-md text-ink-500 hover:bg-ink-100" aria-label="Close">
          <X size={16} />
        </button>

        <div className="flex items-center gap-2 mb-1">
          <Sparkles size={16} className="text-brand-600" />
          <h3 className="text-base font-semibold text-ink-900">Why was this touchless?</h3>
        </div>
        <p className="text-xs text-ink-500 mb-4">
          Invoice <span className="font-mono">{invoice.invoice_sequence_no ?? invoice.id.slice(0, 8)}</span>
          {" · "}{fmtMoney(invoice.total_incl_vat ?? invoice.amount, invoice.currency)}
        </p>

        {isLoading ? (
          <div className="text-xs text-ink-500">Loading audit trail…</div>
        ) : !auto ? (
          <div className="rounded-md border border-ink-200 bg-ink-50 px-3 py-2 text-sm text-ink-700">
            This invoice wasn't auto-dispatched - it went through manual review.
          </div>
        ) : (
          <AutoCard event={auto} invoice={invoice} />
        )}

        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className="btn-outline btn-sm">Close</button>
        </div>
      </div>
    </div>
  );
}

function AutoCard({ event, invoice }: { event: EventRow; invoice: Invoice }) {
  const p = event.payload || {};
  const amount = Number(p.amount ?? invoice.amount ?? 0);
  const threshold = Number(p.threshold ?? 50000);
  const passed = Array.isArray(p.rules_passed) ? (p.rules_passed as string[]) : [];
  const engine = String(p.engine ?? "in_process");
  const hash = (event.payload?.idempotency_key as string) || event.id;
  const fmtFull = (n: number) => `AED ${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

  return (
    <div className="space-y-3">
      {/* The decision in plain prose */}
      <div className="rounded-md border border-brand-200 bg-brand-50 px-3 py-2">
        <div className="flex items-center gap-1.5 text-brand-800 font-semibold text-sm">
          <Zap size={14} /> Auto-dispatched within tolerance
        </div>
        <p className="mt-1 text-xs text-ink-700 leading-relaxed">
          The amount <span className="font-mono">{fmtFull(amount)}</span> was at or below the
          client's auto-dispatch threshold of <span className="font-mono">{fmtFull(threshold)}</span>,
          and all of TIA's contract-bound rules passed. No human click was needed.
        </p>
      </div>

      {/* Rules passed as readable chips, NOT JSON */}
      <div>
        <div className="text-2xs font-semibold uppercase tracking-wide text-ink-500 mb-1.5">
          Rules that passed ({passed.length})
        </div>
        <div className="flex flex-wrap gap-1.5">
          {passed.length === 0 ? (
            <span className="text-xs text-ink-400">No rule IDs recorded.</span>
          ) : (
            passed.map((rid) => (
              <span key={rid}
                className="inline-flex items-center gap-1 rounded-md bg-emerald-50 text-emerald-800 border border-emerald-200 px-1.5 py-0.5 text-2xs font-mono">
                <CheckCircle2 size={10} /> {rid}
              </span>
            ))
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs text-ink-700">
        <div className="rounded-md bg-ink-50 px-2.5 py-1.5">
          <div className="text-2xs text-ink-500 uppercase tracking-wide">Engine</div>
          <div className="font-mono">{engine}</div>
        </div>
        <div className="rounded-md bg-ink-50 px-2.5 py-1.5">
          <div className="text-2xs text-ink-500 uppercase tracking-wide">Decision time</div>
          <div className="font-mono">{event.at ? event.at.slice(11, 19) : "-"}</div>
        </div>
      </div>

      <div className="rounded-md border border-ink-200 bg-ink-50 px-3 py-2">
        <div className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-500">
          <Hash size={11} /> Audit chain reference
        </div>
        <div className="mt-1 font-mono text-2xs text-ink-700 break-all">{hash.slice(0, 32)}…</div>
        <p className="mt-1 text-2xs text-ink-500 inline-flex items-center gap-1">
          <ScrollText size={10} /> Every auto-dispatch is recorded in TIA's tamper-evident audit chain.
        </p>
      </div>
    </div>
  );
}

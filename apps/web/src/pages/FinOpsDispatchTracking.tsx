import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Mail, Radar, RotateCcw, Sparkles, Zap } from "lucide-react";
import { api } from "../api";
import { fmtAED, fmtAge, fmtPct, isAutoDispatched } from "../lib";
import { PageHeader, Metric, StatusBadge, ConfidenceBadge, Badge, EmptyState, TableSkeleton } from "../ui";
import { TouchlessRationale } from "../components/TouchlessRationale";
import { ClawbackModal } from "../components/ClawbackModal";
import { InvoiceChatTrigger } from "../components/InvoiceChatTrigger";
import type { DispatchTrackingRow, Invoice } from "../types";

export function FinOpsDispatchTracking() {
  const { data, isLoading } = useQuery({ queryKey: ["dispatch-tracking"], queryFn: api.dispatchTracking, refetchInterval: 5_000 });
  const { data: stp } = useQuery({ queryKey: ["m-stp"], queryFn: api.metricsStp, refetchInterval: 5_000 });
  const [whyFor, setWhyFor] = useState<Invoice | null>(null);
  const [clawbackFor, setClawbackFor] = useState<Invoice | null>(null);
  const [resending, setResending] = useState<string | null>(null);
  const [resendResult, setResendResult] = useState<Record<string, { ok: boolean; msg: string }>>({});

  // Live KPI strip — counts derived from /dispatch/tracking right now.
  const kpi = useMemo(() => {
    const rows = data ?? [];
    let dispatched = 0, generated = 0, awaitingApproval = 0, autoCount = 0, totalAED = 0;
    for (const r of rows) {
      if (r.status === "dispatched") dispatched += 1;
      else if (r.status === "generated") generated += 1;
      if (!r.client_approval_status || r.client_approval_status === "pending") awaitingApproval += 1;
      if (isAutoDispatched(r.status) && !r.client_approval_status) autoCount += 1;
      /* v8 ignore next -- rows always carry an amount (the row cell fmtAED(total_incl_vat ?? amount) would crash otherwise), so the `?? 0` is unreachable */
      totalAED += r.total_incl_vat ?? r.amount ?? 0;
    }
    return { rows: rows.length, dispatched, generated, awaitingApproval, autoCount, totalAED };
  }, [data]);

  async function resend(id: string) {
    setResending(id);
    try {
      const r = await api.resendInvoiceEmail(id);
      setResendResult((m) => ({
        ...m,
        [id]: r.sent
          ? { ok: true, msg: r.to ? `sent → ${r.to}` : "sent" }
          : { ok: false, msg: r.reason || "failed" },
      }));
    } catch (e) {
      setResendResult((m) => ({ ...m, [id]: { ok: false, msg: String((e as Error).message || e) } }));
    } finally {
      setResending(null);
    }
  }

  // Map a DispatchTrackingRow into the Invoice shape that the modals expect.
  // Only the fields actually consumed by the modals (id, status, amount,
  // total_incl_vat, currency, invoice_sequence_no, client_code, period) are
  // required.
  const asInvoice = (r: DispatchTrackingRow): Invoice => ({
    id: r.id,
    timesheet_id: "",
    client_code: r.client_code,
    period: r.period,
    amount: r.amount,
    currency: "AED",
    status: r.status,
    line_items: [],
    pdf_available: false,
    dispatched_at: r.dispatch_attempted_at,
    invoice_sequence_no: r.invoice_sequence_no,
    total_incl_vat: r.total_incl_vat,
    client_approval_status: r.client_approval_status,
  });

  return (
    <div>
      <PageHeader icon={Radar} title="Dispatch tracking" description="Every invoice's dispatch state and client approval, end to end. The AUTO chip marks fully touchless dispatches." />

      {/* Live KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Metric label="Total tracked" value={kpi.rows.toString()} hint={`${fmtAED(kpi.totalAED)} billed`} />
        <Metric label="Dispatched" value={kpi.dispatched.toString()} hint={kpi.autoCount > 0 ? `${kpi.autoCount} fully touchless` : "no touchless yet"} accent={kpi.autoCount > 0} />
        <Metric label="Pending dispatch" value={kpi.generated.toString()} hint={kpi.generated === 0 ? "queue clean" : "awaiting send"} accent={kpi.generated === 0} />
        <Metric label="Touchless rate" value={stp ? fmtPct(stp.touchless_rate) : "-"} hint={stp ? `target ${fmtPct(stp.target)}` : "no STP data"} accent={stp ? stp.touchless_rate >= stp.target : false} />
      </div>
      <div className="card-flush">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>Invoice #</th><th>Client</th><th>Period</th><th className="text-right">Total (incl. VAT)</th><th>Status</th><th>Client approval</th><th>Confidence</th><th>Dispatched</th><th className="text-right">Actions</th></tr>
            </thead>
            {isLoading ? <TableSkeleton rows={5} cols={9} /> : (
              <tbody>
                {data?.map((r) => {
                  const auto = isAutoDispatched(r.status) && !r.client_approval_status;
                  const canClawback = r.status === "dispatched" || r.status === "generated" || r.status === "finance_approved";
                  return (
                    <tr key={r.id}>
                      <td className="font-mono text-xs text-ink-600">{r.invoice_sequence_no ?? r.id.slice(0, 8)}</td>
                      <td className="font-medium text-ink-800">{r.client_code}</td>
                      <td className="text-ink-600">{r.period ?? "-"}</td>
                      <td className="text-right tnum font-medium">{fmtAED(r.total_incl_vat ?? r.amount)}</td>
                      <td>
                        <div className="inline-flex items-center gap-1">
                          <StatusBadge status={r.status} />
                          {auto && <Badge tone="brand"><Zap size={9} /> AUTO</Badge>}
                        </div>
                      </td>
                      <td><Badge tone={r.client_approval_status === "approved" ? "green" : r.client_approval_status === "rejected" ? "red" : "amber"} dot={false}>{r.client_approval_status ?? "pending"}</Badge></td>
                      <td><ConfidenceBadge value={r.confidence} /></td>
                      <td className="text-ink-500 text-xs whitespace-nowrap">{r.dispatch_attempted_at ? fmtAge(r.dispatch_attempted_at) + " ago" : "-"}</td>
                      <td>
                        <div className="flex items-center justify-end gap-1.5">
                          <InvoiceChatTrigger
                            kind="invoice"
                            id={r.id}
                            ref={r.invoice_sequence_no ?? r.id.slice(0, 8)}
                          />
                          {auto && (
                            <button onClick={() => setWhyFor(asInvoice(r))} className="btn-ghost btn-sm" title="Why touchless?">
                              <Sparkles size={12} /> Why?
                            </button>
                          )}
                          {r.status === "dispatched" && (
                            <button
                              onClick={() => resend(r.id)}
                              disabled={resending === r.id}
                              className="btn-outline btn-sm"
                              title="Re-send invoice email to original sender"
                            >
                              <Mail size={12} /> {resending === r.id ? "Sending…" : "Resend email"}
                            </button>
                          )}
                          {canClawback && (
                            <button onClick={() => setClawbackFor(asInvoice(r))} className="btn-outline btn-sm" title="Void or issue credit note">
                              <RotateCcw size={12} /> Clawback
                            </button>
                          )}
                        </div>
                        {resendResult[r.id] && (
                          <div className={`text-xs mt-1 text-right ${resendResult[r.id].ok ? "text-emerald-600" : "text-red-600"}`}>
                            {resendResult[r.id].msg}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            )}
          </table>
        </div>
        {!isLoading && (!data || data.length === 0) && <EmptyState icon={Radar} title="No invoices to track yet" />}
      </div>

      {whyFor && <TouchlessRationale invoice={whyFor} onClose={() => setWhyFor(null)} />}
      {clawbackFor && (
        <ClawbackModal
          invoice={clawbackFor}
          onClose={() => setClawbackFor(null)}
          onDone={() => setClawbackFor(null)}
        />
      )}
    </div>
  );
}

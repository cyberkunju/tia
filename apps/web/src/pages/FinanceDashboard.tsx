import { useQuery } from "@tanstack/react-query";
import { LayoutDashboard } from "lucide-react";
import { api } from "../api";
import { fmtAED, fmtPct } from "../lib";
import { PageHeader, Panel, Metric, StatusBadge, EmptyState } from "../ui";
import { AuditChainCard } from "../components/AuditChainCard";

export function FinanceDashboard() {
  const { data: stp } = useQuery({ queryKey: ["m-stp"], queryFn: api.metricsStp, refetchInterval: 6_000 });
  const { data: time } = useQuery({ queryKey: ["m-time"], queryFn: api.metricsTimeToInvoice, refetchInterval: 6_000 });
  const { data: acc } = useQuery({ queryKey: ["m-acc"], queryFn: api.metricsAccuracy });
  const { data: head } = useQuery({ queryKey: ["m-head"], queryFn: api.metricsHeadcount });
  const { data: invoices } = useQuery({ queryKey: ["invoices"], queryFn: () => api.listInvoices(), refetchInterval: 6_000 });

  const total = (invoices ?? []).reduce((a, i) => a + (i.total_incl_vat ?? i.amount), 0);
  const byClient: Record<string, number> = {};
  (invoices ?? []).forEach((i) => { byClient[i.client_code] = (byClient[i.client_code] || 0) + (i.total_incl_vat ?? i.amount); });
  const top = Object.entries(byClient).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const max = top[0]?.[1] ?? 1;

  const touchlessOk = stp ? stp.touchless_rate >= stp.target : false;

  return (
    <div>
      <PageHeader icon={LayoutDashboard} title="Finance — month close" description="Straight-through processing, cycle time, accuracy, and billed value (AED)." />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <Metric label="Touchless (STP)" value={stp ? fmtPct(stp.touchless_rate) : "—"} hint={stp ? `${stp.auto} auto · target ${fmtPct(stp.target)}` : ""} accent={touchlessOk} />
        <Metric label="Time to invoice" value={time ? `${time.mean_minutes.toFixed(1)}m` : "—"} hint={time ? `${time.samples} samples · target <${time.target_max_minutes}m` : ""} />
        <Metric label="Accuracy (F1)" value={acc?.overall_macro_f1 != null ? acc.overall_macro_f1.toFixed(2) : (acc ? `${acc.passed}/${acc.runnable}` : "—")} hint={acc ? `target ${acc.target} · ECE ${acc.ece ?? "—"}` : ""} />
        <Metric label="Billed (incl. VAT)" value={fmtAED(total)} hint={`${(invoices ?? []).length} invoices · ${head?.total_unique_emps ?? 0} associates`} />
      </div>

      {/* Tamper-evident audit chain — green dot when intact, red banner if broken. */}
      <div className="mb-4">
        <AuditChainCard />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Panel title="Top clients by billed AED">
          {top.length === 0 ? <EmptyState title="No invoices yet" /> : (
            <div className="space-y-3">
              {top.map(([code, amt]) => (
                <div key={code}>
                  <div className="flex items-center justify-between text-sm mb-1"><span className="font-medium text-ink-800">{code}</span><span className="tnum text-ink-700">{fmtAED(amt)}</span></div>
                  <div className="h-1.5 rounded-full bg-ink-100 overflow-hidden"><div className="h-full rounded-full bg-brand-500" style={{ width: `${(amt / max) * 100}%` }} /></div>
                </div>
              ))}
            </div>
          )}
        </Panel>
        <Panel title="Recent invoices">
          {(invoices ?? []).length === 0 ? <EmptyState title="No invoices yet" /> : (
            <div className="divide-y divide-ink-100 -my-1">
              {(invoices ?? []).slice(0, 6).map((i) => (
                <div key={i.id} className="flex items-center justify-between py-2.5">
                  <div className="min-w-0"><div className="font-medium text-sm text-ink-800">{i.client_code} <span className="text-ink-400 font-normal">· {i.period}</span></div><div className="font-mono text-2xs text-ink-400">{i.invoice_sequence_no ?? i.id.slice(0, 8)}</div></div>
                  <div className="flex items-center gap-2.5"><span className="tnum text-sm">{fmtAED(i.total_incl_vat ?? i.amount)}</span><StatusBadge status={i.status} /></div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

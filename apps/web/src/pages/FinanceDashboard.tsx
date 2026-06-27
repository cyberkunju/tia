import { useQuery } from "@tanstack/react-query";
import { LayoutDashboard } from "lucide-react";
import { api } from "../api";
import { fmtMoney, fmtPct } from "../lib";
import { PageHeader, Panel, Metric, StatusBadge, EmptyState } from "../ui";

export function FinanceDashboard() {
  const { data: docs } = useQuery({ queryKey: ["docs"], queryFn: api.listDocs, refetchInterval: 5_000 });
  const { data: invoices } = useQuery({ queryKey: ["invoices"], queryFn: () => api.listInvoices(), refetchInterval: 5_000 });
  const { data: ev } = useQuery({ queryKey: ["eval"], queryFn: api.evalSummary });

  const total = (invoices ?? []).reduce((acc, i) => acc + i.amount, 0);
  const dispatched = (invoices ?? []).filter((i) => i.status === "dispatched").length;
  const generated = (invoices ?? []).filter((i) => i.status === "generated").length;
  const auto = (docs ?? []).filter((d) => d.routing === "auto").length;
  const hitl = (docs ?? []).filter((d) => d.routing === "hitl").length;
  const docsWithRouting = (docs ?? []).filter((d) => d.routing != null);
  const touchless = docsWithRouting.length > 0 ? auto / docsWithRouting.length : 0;

  const byClient: Record<string, number> = {};
  (invoices ?? []).forEach((i) => { byClient[i.client_code] = (byClient[i.client_code] || 0) + i.amount; });
  const topClients = Object.entries(byClient).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const maxClient = topClients[0]?.[1] ?? 1;

  return (
    <div>
      <PageHeader
        icon={LayoutDashboard}
        title="Month-close dashboard"
        description="Touchless rate is the headline product metric."
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <Metric label="Touchless rate" value={fmtPct(touchless)} hint={`${auto} auto · ${hitl} review`} accent />
        <Metric label="Projected total" value={fmtMoney(total)} hint={`${(invoices ?? []).length} invoices`} />
        <Metric label="Dispatched" value={<>{dispatched}<span className="text-ink-300">/{(invoices ?? []).length}</span></>} hint={`${generated} pending`} />
        <Metric label="F1 · days worked" value={ev ? ev.macro_f1.days_worked?.toFixed(2) ?? "—" : "—"} hint={ev ? `passed ${ev.passed}/${ev.runnable}` : ""} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Panel title="Top clients by billed AED">
          {topClients.length === 0 ? (
            <EmptyState title="No invoices yet" />
          ) : (
            <div className="space-y-3">
              {topClients.map(([code, amount]) => (
                <div key={code}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="font-medium text-ink-800">{code}</span>
                    <span className="tnum text-ink-700">{fmtMoney(amount)}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-ink-100 overflow-hidden">
                    <div className="h-full rounded-full bg-brand-500" style={{ width: `${(amount / maxClient) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Recent invoices">
          {(invoices ?? []).length === 0 ? (
            <EmptyState title="No invoices yet" />
          ) : (
            <div className="divide-y divide-ink-100 -my-1">
              {(invoices ?? []).slice(0, 6).map((i) => (
                <div key={i.id} className="flex items-center justify-between py-2.5">
                  <div className="min-w-0">
                    <div className="font-medium text-sm text-ink-800">{i.client_code} <span className="text-ink-400 font-normal">· {i.period}</span></div>
                    <div className="font-mono text-2xs text-ink-400">{i.id.slice(0, 8)}</div>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <span className="tnum text-sm">{fmtMoney(i.amount, i.currency)}</span>
                    <StatusBadge status={i.status} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

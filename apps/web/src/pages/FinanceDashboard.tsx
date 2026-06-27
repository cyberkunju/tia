import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { fmtMoney, fmtPct, statusBadgeClass } from "../lib";

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
  (invoices ?? []).forEach((i) => {
    byClient[i.client_code] = (byClient[i.client_code] || 0) + i.amount;
  });
  const topClients = Object.entries(byClient).sort((a, b) => b[1] - a[1]).slice(0, 5);

  return (
    <div>
      <h1 className="text-xl font-semibold mb-1">Finance — month-close dashboard</h1>
      <p className="text-sm text-ink-600 mb-4">Touchless rate is the headline product metric.</p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <Stat label="Touchless rate" value={fmtPct(touchless)} hint={`${auto} auto · ${hitl} HITL`} accent="brand" />
        <Stat label="Projected total" value={fmtMoney(total)} hint={`${(invoices ?? []).length} invoices`} />
        <Stat label="Dispatched" value={`${dispatched}/${(invoices ?? []).length}`} hint={`${generated} pending`} />
        <Stat label="Eval F1 (days)" value={ev ? ev.macro_f1.days_worked?.toFixed(2) ?? "—" : "—"} hint={ev ? `passed ${ev.passed}/${ev.runnable}` : ""} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card p-4">
          <h3 className="font-semibold mb-3">Top clients by billed AED</h3>
          {topClients.length === 0 && <div className="text-ink-400 text-sm">No invoices yet.</div>}
          {topClients.map(([code, amount]) => (
            <div key={code} className="flex items-center justify-between py-1.5 border-b border-ink-100 last:border-0">
              <span className="font-medium">{code}</span>
              <span className="tabular-nums">{fmtMoney(amount)}</span>
            </div>
          ))}
        </div>
        <div className="card p-4">
          <h3 className="font-semibold mb-3">Recent invoices</h3>
          <div className="space-y-2 text-sm">
            {(invoices ?? []).slice(0, 6).map((i) => (
              <div key={i.id} className="flex items-center justify-between">
                <div>
                  <div className="font-mono text-xs text-ink-500">{i.id.slice(0, 8)}</div>
                  <div className="font-medium">{i.client_code} · {i.period}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="tabular-nums">{fmtMoney(i.amount, i.currency)}</span>
                  <span className={statusBadgeClass(i.status)}>{i.status}</span>
                </div>
              </div>
            ))}
            {(invoices ?? []).length === 0 && <div className="text-ink-400">No invoices yet.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: "brand" }) {
  return (
    <div className={`card p-4 ${accent === "brand" ? "border-brand-300 bg-brand-50/40" : ""}`}>
      <div className="text-xs text-ink-500 uppercase tracking-wider">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${accent === "brand" ? "text-brand-700" : ""}`}>{value}</div>
      {hint && <div className="text-[11px] text-ink-500 mt-0.5">{hint}</div>}
    </div>
  );
}

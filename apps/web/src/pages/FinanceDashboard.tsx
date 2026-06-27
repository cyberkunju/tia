import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Activity, Clock, Target, ListChecks, Users, Building2, Truck, Receipt,
} from "lucide-react";
import { api, API_BASE } from "../api";
import { fmtMoney } from "../lib";
import { PageHeader, Panel, EmptyState, Badge } from "../ui";
import { KpiTile } from "../components/KpiTile";

export function FinanceDashboard() {
  const stp = useQuery({ queryKey: ["m-stp"], queryFn: api.metricsStp, refetchInterval: 5_000 });
  const tti = useQuery({ queryKey: ["m-tti"], queryFn: api.metricsTimeToInvoice, refetchInterval: 5_000 });
  const acc = useQuery({ queryKey: ["m-acc"], queryFn: api.metricsAccuracy, refetchInterval: 30_000 });
  const hc  = useQuery({ queryKey: ["m-hc"],  queryFn: api.metricsHeadcount, refetchInterval: 15_000 });
  const queue = useQuery({ queryKey: ["fin-queue"], queryFn: api.financeQueue, refetchInterval: 5_000 });

  const sRate = stp.data?.touchless_rate ?? 0;
  const sTarget = stp.data?.target ?? 0.8;
  const sMin = tti.data?.mean_minutes ?? 0;
  const sMax = tti.data?.target_max_minutes ?? 5;
  const acT = acc.data?.target ?? 0.99;
  const acV = acc.data?.overall_macro_f1 ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Activity}
        title="Finance Dashboard"
        description="TASC's three success measures — live."
        actions={
          <Link to="/finance/queue" className="btn-outline btn-sm">
            <ListChecks size={14} /> Approval queue
            {queue.data && queue.data.length > 0 && (
              <span className="ml-1 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full bg-red-100 text-red-700 text-2xs font-semibold">
                {queue.data.length}
              </span>
            )}
          </Link>
        }
      />

      {/* The 3 brief success-measure tiles */}
      <div className="grid sm:grid-cols-3 gap-4">
        <KpiTile
          label="Touchless rate"
          value={`${(sRate * 100).toFixed(0)}%`}
          sub={stp.data ? <span>auto {stp.data.auto} · hitl {stp.data.hitl} · escalate {stp.data.escalate}</span> : "—"}
          target={`${(sTarget * 100).toFixed(0)}%+`}
          hitTarget={sRate >= sTarget}
          icon={Target}
          tone={sRate >= sTarget ? "brand" : "gold"}
        />
        <KpiTile
          label="Mean time to invoice"
          value={sMin < 1 ? `${(sMin * 60).toFixed(1)}s` : `${sMin.toFixed(2)}m`}
          sub={tti.data ? <span>{tti.data.samples} sampled · {tti.data.invoices} invoices</span> : "—"}
          target={`<${sMax} min`}
          hitTarget={sMin <= sMax}
          icon={Clock}
          tone={sMin <= sMax ? "teal" : "gold"}
        />
        <KpiTile
          label="Extraction accuracy"
          value={acV !== null ? `${(acV * 100).toFixed(1)}%` : "—"}
          sub={acc.data ? <span>macro F1 · ECE {(acc.data.ece ?? 0).toFixed(3)} · eval {acc.data.passed}/{acc.data.runnable}</span> : "—"}
          target={`${(acT * 100).toFixed(0)}%+`}
          hitTarget={acV !== null ? acV >= acT : undefined}
          icon={Activity}
          tone={acV !== null && acV >= acT ? "brand" : "gold"}
        />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        {/* Headcount per period */}
        <Panel
          title={<span className="flex items-center gap-2"><Users size={14} /> Headcount billed</span>}
          subtitle="Unique employees per period (TASC HC KPI)"
          className="lg:col-span-1"
        >
          {hc.isLoading ? (
            <div className="text-xs text-ink-400">Loading…</div>
          ) : !hc.data || Object.keys(hc.data.by_period).length === 0 ? (
            <EmptyState title="No headcount yet" />
          ) : (
            <ul className="space-y-1.5">
              {Object.entries(hc.data.by_period).map(([p, n]) => (
                <li key={p} className="flex items-center justify-between text-sm">
                  <span className="text-ink-700">{p}</span>
                  <Badge tone="brand">{n} emps</Badge>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-2xs text-ink-400">
            Total unique: <strong>{hc.data?.total_unique_emps ?? 0}</strong>
          </p>
        </Panel>

        {/* Approval queue preview */}
        <Panel
          title={<span className="flex items-center gap-2"><ListChecks size={14} /> Approval queue</span>}
          subtitle="Invoices over per-client threshold"
          className="lg:col-span-2"
          actions={
            <Link to="/finance/queue" className="btn-outline btn-sm">
              View all <Receipt size={12} />
            </Link>
          }
        >
          {queue.isLoading ? (
            <div className="text-xs text-ink-400">Loading…</div>
          ) : !queue.data || queue.data.length === 0 ? (
            <EmptyState title="No invoices over threshold" icon={Truck} />
          ) : (
            <ul className="divide-y divide-ink-100 -my-2">
              {queue.data.slice(0, 5).map((row) => (
                <li key={row.id} className="py-2 flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink-900 truncate">
                      {row.client_name ?? row.client_code} · {row.period ?? "—"}
                    </p>
                    <p className="text-2xs text-ink-500 font-mono">{row.invoice_sequence_no ?? row.id.slice(0, 8)}</p>
                  </div>
                  <div className="text-right">
                    <p className="tnum text-sm font-semibold text-ink-900">{fmtMoney(row.total_incl_vat ?? row.amount, row.currency)}</p>
                    <p className="text-2xs text-ink-500">over {fmtMoney(row.threshold, row.currency)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel
        title="Compliance artifacts"
        subtitle="Smart Bot + SAP outputs — Ramco-shaped Excel & WPS SIF for the bank"
      >
        <div className="grid sm:grid-cols-2 gap-3">
          <ArtifactRow
            title="Consolidated payroll (Ramco-shaped)"
            sub="One row per resolved employee — Basic/OT/VAT/Net all columns"
            href={`${API_BASE}/consolidate/CL001/${encodeURIComponent("June 2026")}.xlsx`}
            icon={Building2}
            label="CL001 · June 2026 .xlsx"
          />
          <ArtifactRow
            title="WPS SIF (bank gateway)"
            sub="SCR + EDR records — UAE MOHRE format"
            href={`${API_BASE}/payroll/sif/CL001/${encodeURIComponent("June 2026")}.sif`}
            icon={Truck}
            label="CL001 · June 2026 .sif"
          />
        </div>
      </Panel>
    </div>
  );
}

function ArtifactRow({ title, sub, href, icon: Icon, label }: {
  title: string; sub: string; href: string; icon: typeof Receipt; label: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex items-start gap-3 p-3 rounded-lg border border-ink-200 hover:border-brand-300 hover:bg-brand-50/40 transition-colors"
    >
      <span className="grid place-items-center h-10 w-10 rounded-md bg-teal-100 text-teal-800 shrink-0">
        <Icon size={18} />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink-900">{title}</p>
        <p className="text-2xs text-ink-500 mt-0.5">{sub}</p>
        <p className="mt-1 text-2xs text-brand-700 font-mono">{label}</p>
      </div>
    </a>
  );
}

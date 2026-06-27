import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LayoutDashboard, Sprout, Loader2 } from "lucide-react";
import { api } from "../api";
import { fmtAED, fmtPct } from "../lib";
import { PageHeader, Panel, Metric, StatusBadge, EmptyState } from "../ui";
import { AuditChainCard } from "../components/AuditChainCard";
import { DispatchPillars } from "../components/DispatchPillars";
import { LiveActivityRail } from "../components/LiveActivityRail";
import type { StpMetricFull } from "../types";

/**
 * Quick prefab payloads that hit 5 different clients so the dashboard fills
 * with multi-client variety in a single click. Each payload is a clean
 * email-style timesheet that the orchestrator auto-dispatches.
 *
 * (Brief case 7 targets CL001 by design; without this button the demo
 * dashboard stays one-client until the operator manually drives diversity.)
 */
const SEED_PAYLOADS: { subject: string; body: string }[] = [
  {
    subject: "CL001 Emirates Steel · June 2026 timesheet",
    body: "Client: Emirates Steel Industries LLC (CL001)\nPeriod: June 2026\n\nEMP10001 Carlos Smith - 20 days\nEMP10002 Ahmed Khan - 20 days, 2 OT hours\n\nApproved by: Site Manager",
  },
  {
    subject: "CL003 Dubai Airports · June 2026 timesheet",
    body: "Client: Dubai Airports FZE (CL003)\nPeriod: June 2026\n\nEMP10057 Meera Al Hamdan - 20 days\nEMP10045 Aisha Patel - 20 days, 1 OT hour\n\nApproved by: Site Manager",
  },
  {
    subject: "CL004 ADNOC · June 2026 timesheet",
    body: "Client: ADNOC Distribution PJSC (CL004)\nPeriod: June 2026\n\nEMP10064 Carlos Patel - 20 days, 3 OT hours\n\nApproved by: Site Manager",
  },
  {
    subject: "CL006 ADCB · June 2026 timesheet",
    body: "Client: Abu Dhabi Commercial Bank PJSC (CL006)\nPeriod: June 2026\n\nEMP10111 Aisha Al Hamdan - 20 days, 2 OT hours\n\nApproved by: Site Manager",
  },
  {
    subject: "CL007 DP World · June 2026 timesheet",
    body: "Client: DP World FZE (CL007)\nPeriod: June 2026\n\nEMP10129 Meera Gupta - 20 days\nEMP10137 Meera Khan - 20 days, 1 OT hour\n\nApproved by: Site Manager",
  },
];

export function FinanceDashboard() {
  const qc = useQueryClient();
  const [seeding, setSeeding] = useState(false);
  // Aggressive 3s refetch on the live numbers — the dashboard should _feel_
  // live during the demo. The static-ish metrics (accuracy, headcount) use
  // the default cache because they don't drift each second.
  const { data: stp } = useQuery({ queryKey: ["m-stp"], queryFn: api.metricsStp, refetchInterval: 3_000 });
  const { data: time } = useQuery({ queryKey: ["m-time"], queryFn: api.metricsTimeToInvoice, refetchInterval: 3_000 });
  const { data: acc } = useQuery({ queryKey: ["m-acc"], queryFn: api.metricsAccuracy, refetchInterval: 30_000 });
  const { data: head } = useQuery({ queryKey: ["m-head"], queryFn: api.metricsHeadcount, refetchInterval: 10_000 });
  const { data: invoices } = useQuery({ queryKey: ["invoices"], queryFn: () => api.listInvoices(), refetchInterval: 3_000 });
  const { data: clients } = useQuery({ queryKey: ["clients"], queryFn: api.listClients });

  /** Fire 5 prefab timesheets at different clients so the dashboard shows variety. */
  const seedSamples = async () => {
    setSeeding(true);
    try {
      // Fire serially — each post triggers a full pipeline run; running them
      // in parallel saturates the orchestrator and the chain-hash linearity
      // depends on serial appends anyway.
      for (const p of SEED_PAYLOADS) {
        try { await api.submitEmail(p.body, p.subject); } catch { /* keep going */ }
      }
      await qc.invalidateQueries();
    } finally {
      setSeeding(false);
    }
  };

  const codeToName = useMemo(() => {
    const m: Record<string, string> = {};
    (clients ?? []).forEach((c) => { m[c.code] = c.name; });
    return m;
  }, [clients]);

  const list = invoices ?? [];
  const total = list.reduce((a, i) => a + (i.total_incl_vat ?? i.amount), 0);
  const byClient: Record<string, { amt: number; count: number }> = {};
  list.forEach((i) => {
    const k = i.client_code;
    if (!byClient[k]) byClient[k] = { amt: 0, count: 0 };
    byClient[k].amt += i.total_incl_vat ?? i.amount;
    byClient[k].count += 1;
  });
  const top = Object.entries(byClient).sort((a, b) => b[1].amt - a[1].amt).slice(0, 6);
  const max = top[0]?.[1].amt ?? 1;
  const clientsCovered = Object.keys(byClient).length;

  const touchlessOk = stp ? stp.touchless_rate >= stp.target : false;

  // Time saved vs the brief's baseline ("days to turn around" today).
  // We anchor to 2 working days = 960 minutes as the "manual" baseline and
  // show how many minutes per invoice we shaved off, in plain language.
  const mins = time?.mean_minutes ?? null;
  const manualBaselineMin = 960;
  const speedup = mins != null && mins > 0 ? Math.round(manualBaselineMin / mins) : null;

  return (
    <div>
      <PageHeader
        icon={LayoutDashboard}
        title="Finance — month close"
        description="Live touchless rate, cycle time, accuracy, and billed value (AED). Auto-refreshes every 3 seconds."
        actions={
          <button
            className="btn-outline btn-sm"
            disabled={seeding}
            onClick={seedSamples}
            title="Fires 5 prefab timesheets across CL001/CL002/CL003/CL006/CL008 so the dashboard shows multi-client variety."
          >
            {seeding ? <Loader2 size={13} className="animate-spin" /> : <Sprout size={13} />}
            {seeding ? "Seeding…" : "Seed sample data"}
          </button>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <Metric
          label="Touchless rate"
          value={stp ? fmtPct(stp.touchless_rate) : "—"}
          hint={
            stp
              ? `${stp.auto} of ${stp.total} invoices · brief target ${fmtPct(stp.target)}`
              : "no data yet"
          }
          accent={touchlessOk}
        />
        <Metric
          label="Cycle time per invoice"
          value={mins != null ? `${mins.toFixed(1)} min` : "—"}
          hint={
            mins != null
              ? speedup
                ? `${speedup}× faster than manual (≈2 working days)`
                : `${time?.samples ?? 0} samples · target <${time?.target_max_minutes ?? 5} min`
              : "no samples yet"
          }
        />
        <Metric
          label="Accuracy (eval F1)"
          value={
            acc?.overall_macro_f1 != null
              ? acc.overall_macro_f1.toFixed(2)
              : acc
              ? `${acc.passed}/${acc.runnable}`
              : "—"
          }
          hint={
            acc
              ? `target ${acc.target}${acc.ece != null ? ` · calibration ${acc.ece.toFixed(3)} ECE` : ""}`
              : "no eval run yet"
          }
        />
        <Metric
          label="Billed this period"
          value={fmtAED(total)}
          hint={`${list.length} invoice${list.length === 1 ? "" : "s"} · ${head?.total_unique_emps ?? 0} associate${head?.total_unique_emps === 1 ? "" : "s"} · ${clientsCovered} client${clientsCovered === 1 ? "" : "s"}`}
        />
      </div>

      {/* Tamper-evident audit chain — green dot when intact, red banner if broken. */}
      <div className="mb-4">
        <AuditChainCard />
      </div>

      {/* 3-pillar dispatch breakdown — auto / hitl / finance touchless story. */}
      <div className="mb-4">
        <DispatchPillars stp={stp as StpMetricFull | undefined} />
      </div>

      {/* Live event stream — SSE from /events/stream. */}
      <div className="mb-4">
        <LiveActivityRail max={25} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Panel title="Top clients by billed AED" subtitle={clientsCovered > 0 ? `${clientsCovered} of 10 clients have activity` : "Submit timesheets across clients to see variety"}>
          {top.length === 0 ? (
            <EmptyState title="No invoices yet" hint="Submit a timesheet to see clients here." />
          ) : (
            <div className="space-y-3">
              {top.map(([code, { amt, count }]) => (
                <div key={code}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <div className="min-w-0">
                      <div className="font-medium text-ink-800 truncate">{codeToName[code] ?? code}</div>
                      <div className="text-2xs text-ink-400 font-mono">{code} · {count} invoice{count === 1 ? "" : "s"}</div>
                    </div>
                    <span className="tnum text-ink-700 shrink-0 ml-3">{fmtAED(amt)}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-ink-100 overflow-hidden">
                    <div className="h-full rounded-full bg-brand-500 transition-all duration-700" style={{ width: `${(amt / max) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Recent invoices" subtitle={list.length > 0 ? `Latest ${Math.min(6, list.length)} of ${list.length}` : ""}>
          {list.length === 0 ? (
            <EmptyState title="No invoices yet" hint="The pipeline writes invoices here the moment they generate." />
          ) : (
            <div className="divide-y divide-ink-100 -my-1">
              {list.slice(0, 6).map((i) => (
                <div key={i.id} className="flex items-center justify-between py-2.5 gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm text-ink-800 truncate">
                      {codeToName[i.client_code] ?? i.client_code}
                      <span className="text-ink-400 font-normal"> · {i.period}</span>
                    </div>
                    <div className="font-mono text-2xs text-ink-400">{i.invoice_sequence_no ?? i.id.slice(0, 8)}</div>
                  </div>
                  <div className="flex items-center gap-2.5 shrink-0">
                    <span className="tnum text-sm font-medium text-ink-900">{fmtAED(i.total_incl_vat ?? i.amount)}</span>
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

import { Zap, UserCheck, ShieldCheck } from "lucide-react";
import type { StpMetricFull } from "../types";

/**
 * 3-pillar dispatch breakdown - auto / hitl / finance - segmented bar + three
 * pillar tiles. Tells the touchless story at a glance for judges. Icons are
 * lucide glyphs (no emoji) so the band stays professional.
 */
export function DispatchPillars({ stp }: { stp: StpMetricFull | undefined }) {
  const bd = stp?.dispatched_breakdown;
  const total = bd?.total_dispatched ?? 0;
  const auto = bd?.auto_dispatched ?? 0;
  const hitl = bd?.hitl_dispatched ?? 0;
  const finance = bd?.finance_dispatched ?? 0;
  /* v8 ignore next -- pct is only invoked after the total===0 early return, so the `: 0` branch is unreachable */
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
  return (
    <section className="card p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-sm font-semibold text-ink-900">Dispatched invoices - by path</h2>
        <span className="text-2xs text-ink-500">{total} dispatched · brief target 80%+ auto</span>
      </div>
      {total === 0 ? (
        <p className="text-xs text-ink-500">No invoices dispatched yet.</p>
      ) : (
        <>
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-ink-100">
            <span className="h-full bg-brand-500" style={{ width: `${pct(auto)}%` }} title={`Auto-dispatched ${pct(auto)}%`} />
            <span className="h-full bg-amber-500" style={{ width: `${pct(hitl)}%` }} title={`HITL dispatched ${pct(hitl)}%`} />
            <span className="h-full bg-emerald-500" style={{ width: `${pct(finance)}%` }} title={`Finance dispatched ${pct(finance)}%`} />
          </div>
          <div className="grid grid-cols-3 gap-3 mt-3 text-xs">
            <PillarTile color="brand" Icon={Zap} label="Auto-dispatched" value={auto} pct={pct(auto)} sub="touchless" />
            <PillarTile color="amber" Icon={UserCheck} label="FinOps reviewed" value={hitl} pct={pct(hitl)} sub="manual review" />
            <PillarTile color="emerald" Icon={ShieldCheck} label="Finance approved" value={finance} pct={pct(finance)} sub="over threshold" />
          </div>
        </>
      )}
    </section>
  );
}

function PillarTile({ color, Icon, label, value, pct, sub }: {
  color: "brand" | "amber" | "emerald";
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string; value: number; pct: number; sub: string;
}) {
  const ring = color === "brand" ? "ring-brand-200 bg-brand-50" : color === "amber" ? "ring-amber-200 bg-amber-50" : "ring-emerald-200 bg-emerald-50";
  const text = color === "brand" ? "text-brand-800" : color === "amber" ? "text-amber-900" : "text-emerald-800";
  return (
    <div className={`rounded-md ring-1 ${ring} px-3 py-2`}>
      <div className="flex items-center justify-between">
        <span className={`inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wide ${text}`}>
          <Icon size={11} /> {label}
        </span>
        <span className={`text-xs font-mono ${text}`}>{pct}%</span>
      </div>
      <div className="mt-1 text-lg font-semibold tnum text-ink-900">{value}</div>
      <div className="text-2xs text-ink-500">{sub}</div>
    </div>
  );
}

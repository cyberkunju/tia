import { useQuery } from "@tanstack/react-query";
import { FileText, Calendar, Globe, Percent, CalendarClock, ListChecks, CheckCircle2, CircleDot, Building2 } from "lucide-react";
import { api } from "../api";
import { cn } from "../lib";

const TYPE_LABEL: Record<string, string> = {
  TIME_AND_MATERIALS: "Time & Materials",
  FIXED_SCOPE: "Fixed-scope",
  RETAINER: "Retainer",
};

const JURISDICTION_TONE: Record<string, string> = {
  UAE: "bg-emerald-50 text-emerald-700 border-emerald-200",
  KSA: "bg-amber-50 text-amber-700 border-amber-200",
  IN: "bg-sky-50 text-sky-700 border-sky-200",
};

export function ContractPanel({ clientCode }: { clientCode: string | null | undefined }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["contract", clientCode],
    queryFn: () => clientCode ? api.getContract(clientCode) : Promise.resolve(null),
    enabled: !!clientCode,
  });

  if (!clientCode) return null;
  if (isLoading) {
    return (
      <section className="card p-4 animate-pulse">
        <div className="h-3 w-24 bg-ink-200 rounded mb-2" />
        <div className="h-5 w-48 bg-ink-200 rounded" />
      </section>
    );
  }
  if (isError || !data) {
    return (
      <section className="card p-4 text-xs text-ink-500">
        <div className="font-medium text-ink-700 mb-1 flex items-center gap-1.5">
          <FileText size={14} /> Contract
        </div>
        No active contract found for <span className="font-mono">{clientCode}</span>.
      </section>
    );
  }

  return (
    <section className="card overflow-hidden">
      <header className="flex items-start justify-between gap-3 px-4 py-3 border-b border-ink-200 bg-gradient-to-r from-teal-50 to-white">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Building2 size={14} className="text-teal-700 shrink-0" />
            <h2 className="text-sm font-semibold text-ink-900 truncate">{data.name}</h2>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={cn(
              "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs font-semibold uppercase border",
              JURISDICTION_TONE[data.jurisdiction] ?? "bg-ink-100 text-ink-700 border-ink-200",
            )}>
              <Globe size={10} /> {data.jurisdiction}
            </span>
            <span className="inline-flex items-center gap-1 rounded-md bg-teal-50 text-teal-800 border border-teal-200 px-1.5 py-0.5 text-2xs font-medium">
              {TYPE_LABEL[data.type] ?? data.type}
            </span>
            <span className="text-2xs text-ink-500">· {data.currency}</span>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 px-4 py-3 text-xs border-b border-ink-100">
        <KV icon={<Percent size={11} />} label="Max OT" value={`${(data.max_ot_pct * 100).toFixed(0)}%`} />
        <KV icon={<Percent size={11} />} label="Markup" value={`${(data.markup_pct * 100).toFixed(0)}%`} />
        <KV icon={<Percent size={11} />} label="VAT" value={`${(data.vat_rate * 100).toFixed(0)}%`} />
        <KV icon={<CalendarClock size={11} />} label="Terms" value={`Net ${data.payment_terms_days}d`} />
        <KV icon={<Calendar size={11} />} label="Period" value={`${data.start_date.slice(0, 7)} → ${data.end_date?.slice(0, 7) ?? "open"}`} />
        <KV icon={<FileText size={11} />} label="Roster" value={`${data.authorized_emp_count ?? 0} emp`} />
        {data.sac_code && <KV icon={<FileText size={11} />} label="SAC" value={data.sac_code} />}
      </div>

      {data.sows.length > 0 && (
        <div className="px-4 py-3 border-b border-ink-100">
          <div className="text-2xs font-semibold uppercase tracking-wide text-ink-500 mb-2 flex items-center gap-1">
            <ListChecks size={11} /> Statements of Work
          </div>
          <ul className="space-y-1.5">
            {data.sows.map((s, i) => (
              <li key={i} className="flex items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-1.5 min-w-0">
                  {s.status === "COMPLETED" ? (
                    <CheckCircle2 size={12} className="text-emerald-600 shrink-0" />
                  ) : (
                    <CircleDot size={12} className="text-amber-500 shrink-0" />
                  )}
                  <span className={cn("font-medium truncate", s.status === "COMPLETED" && "text-ink-500 line-through")}>
                    {s.deliverable}
                  </span>
                </div>
                <span className="tnum text-ink-500 shrink-0">{s.hours_consumed.toFixed(0)} / {s.hours_expected.toFixed(0)} h</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.rate_cards.length > 0 && (
        <div className="px-4 py-3">
          <div className="text-2xs font-semibold uppercase tracking-wide text-ink-500 mb-2">
            Rate card (top 5)
          </div>
          <ul className="space-y-1 text-xs">
            {data.rate_cards.slice(0, 5).map((rc, i) => (
              <li key={i} className="flex items-center justify-between gap-2 text-ink-700">
                <span className="truncate">{rc.labor_category}</span>
                <span className="tnum text-ink-500">{rc.regular_rate.toFixed(0)} <span className="text-ink-400">AED/hr</span></span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function KV({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="grid place-items-center h-6 w-6 rounded bg-ink-100 text-ink-500 shrink-0">{icon}</span>
      <div className="min-w-0">
        <div className="text-2xs text-ink-500">{label}</div>
        <div className="text-xs font-medium text-ink-800 truncate">{value}</div>
      </div>
    </div>
  );
}

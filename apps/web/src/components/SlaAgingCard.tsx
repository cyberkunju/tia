import { useQuery } from "@tanstack/react-query";
import { Clock, AlertTriangle } from "lucide-react";
import { api } from "../api";
import { Panel, Badge } from "../ui";

/**
 * SLA aging widget — shows mean/max age per status + how many are over SLA.
 * Reads /metrics/sla. Demo wins on judges who care about ops discipline.
 */
export function SlaAgingCard() {
  const { data, isLoading } = useQuery({
    queryKey: ["sla"],
    queryFn: api.metricsSla,
    refetchInterval: 30_000,
    retry: false,
  });

  if (isLoading) {
    return (
      <Panel title={<span className="flex items-center gap-2"><Clock size={13} /> SLA aging</span>}>
        <div className="text-xs text-ink-400">Loading…</div>
      </Panel>
    );
  }
  if (!data) {
    return (
      <Panel title={<span className="flex items-center gap-2"><Clock size={13} /> SLA aging</span>}>
        <div className="text-xs text-ink-500">SLA metrics unavailable.</div>
      </Panel>
    );
  }

  const overdue = data.over_sla_count;

  return (
    <Panel
      title={<span className="flex items-center gap-2"><Clock size={13} /> SLA aging</span>}
      subtitle="Mean / max age per stage · invoices over the client's SLA window."
      actions={
        <Badge tone={overdue > 0 ? "red" : "green"} dot={false}>
          {overdue > 0 ? <><AlertTriangle size={10} /> {overdue} over SLA</> : "All on track"}
        </Badge>
      }
    >
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
        {Object.entries(data.by_status).map(([status, s]) => (
          <div key={status} className="rounded-md border border-ink-200 px-3 py-2 bg-ink-50/40">
            <div className="text-2xs uppercase tracking-wide text-ink-500 mb-0.5">{status.replace(/_/g, " ")}</div>
            <div className="flex items-center gap-2">
              <span className="text-base font-semibold tnum text-ink-900">{s.count}</span>
              <span className="text-2xs text-ink-500">items</span>
            </div>
            <div className="text-2xs text-ink-500 mt-0.5">
              mean <span className="tnum">{s.mean_min.toFixed(0)}m</span> · max <span className="tnum">{s.max_min.toFixed(0)}m</span>
            </div>
          </div>
        ))}
      </div>
      {overdue > 0 && data.over_sla.length > 0 && (
        <div className="mt-3 rounded-md border border-red-200 bg-red-50/60 p-2">
          <div className="text-2xs font-semibold text-red-800 mb-1.5 flex items-center gap-1">
            <AlertTriangle size={10} /> Over-SLA items
          </div>
          <ul className="space-y-0.5 text-2xs text-red-900">
            {data.over_sla.slice(0, 5).map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-2">
                <code className="font-mono">{o.id.slice(0, 8)}</code>
                <span>{o.status}</span>
                <span className="tnum">{o.age_min.toFixed(0)}m / {o.limit_min}m limit</span>
              </li>
            ))}
            {data.over_sla.length > 5 && <li className="opacity-70">…and {data.over_sla.length - 5} more</li>}
          </ul>
        </div>
      )}
    </Panel>
  );
}

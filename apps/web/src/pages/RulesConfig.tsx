import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SlidersHorizontal } from "lucide-react";
import { api } from "../api";
import { cn } from "../lib";
import { PageHeader, Panel, Badge, Spinner } from "../ui";

/**
 * Live rule catalogue + per-rule trigger counts.
 *
 * Catalogue comes from `/rules` (server-side definitions). The trigger /
 * pass / fail counts are derived from every invoice's `rule_results` array
 * via `/invoices`, so the chips reflect what the rules actually did to the
 * pipeline this period. Toggles are local for the demo; per-client
 * persistence wires to the rule engine next.
 */
export function RulesConfig() {
  const { data, isLoading } = useQuery({ queryKey: ["rules"], queryFn: api.listRules, staleTime: 60 * 60 * 1000 });
  const { data: invoices } = useQuery({ queryKey: ["invoices"], queryFn: () => api.listInvoices(), refetchInterval: 8_000 });

  // Build rule → {fires, fails} from the real rule_results on every invoice.
  const counts = useMemo(() => {
    const m: Record<string, { fires: number; fails: number }> = {};
    for (const inv of invoices ?? []) {
      for (const r of (inv.rule_results as { rule_id?: string; passed?: boolean }[] | undefined) ?? []) {
        const id = r.rule_id;
        if (!id) continue;
        const row = m[id] ?? { fires: 0, fails: 0 };
        row.fires += 1;
        if (r.passed === false) row.fails += 1;
        m[id] = row;
      }
    }
    return m;
  }, [invoices]);

  const rules = useMemo(
    () => (data?.rules ?? []).map((r) => ({
      id: r.rule_id,
      name: r.function_name.replace(/^r\d+_/, "").replace(/_/g, " "),
      desc: r.friendly_message || "-",
    })),
    [data],
  );
  const [on, setOn] = useState<Record<string, boolean>>({});
  const initialised = useMemo(() => rules.every((r) => r.id in on), [rules, on]);
  if (!initialised && rules.length) setOn(Object.fromEntries(rules.map((r) => [r.id, true])));
  const enabled = Object.values(on).filter(Boolean).length;

  // Pipeline-wide rule totals
  const totals = useMemo(() => {
    let fires = 0, fails = 0;
    for (const v of Object.values(counts)) { fires += v.fires; fails += v.fails; }
    return { fires, fails, invoices: (invoices ?? []).length };
  }, [counts, invoices]);

  return (
    <div>
      <PageHeader
        icon={SlidersHorizontal}
        title="Validation rules"
        description="The deterministic BTP-style rule set every generated invoice is checked against. Failures route to human review."
        actions={data ? <Badge tone="brand">{enabled}/{data.count} enabled</Badge> : undefined}
      />

      {/* Live pipeline summary — derived from invoices' rule_results */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <SummaryTile label="Invoices checked" value={totals.invoices.toString()} />
        <SummaryTile label="Rule evaluations" value={totals.fires.toString()} />
        <SummaryTile label="Rule failures" value={totals.fails.toString()} tone={totals.fails > 0 ? "amber" : "green"} />
        <SummaryTile
          label="Pass rate"
          value={totals.fires > 0 ? `${((1 - totals.fails / totals.fires) * 100).toFixed(1)}%` : "—"}
          tone="green"
        />
      </div>

      <Panel bodyClassName="p-0">
        {isLoading ? (
          <div className="px-4 py-8 text-sm text-ink-500 flex items-center gap-2"><Spinner /> Loading rule catalogue…</div>
        ) : (
          <ul className="divide-y divide-ink-100">
            {rules.map((r) => {
              const c = counts[r.id];
              const fires = c?.fires ?? 0;
              const fails = c?.fails ?? 0;
              return (
                <li key={r.id} className="flex items-center gap-4 px-4 py-3">
                  <button
                    onClick={() => setOn((s) => ({ ...s, [r.id]: !s[r.id] }))}
                    className={cn(
                      "relative h-5 w-9 rounded-full transition-colors shrink-0",
                      on[r.id] ? "bg-brand-600" : "bg-ink-300",
                    )}
                  >
                    <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all", on[r.id] ? "left-4" : "left-0.5")} />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-2xs text-ink-500 bg-ink-100 px-1 rounded">{r.id}</span>
                      <span className="text-sm font-medium text-ink-900 capitalize">{r.name}</span>
                    </div>
                    <div className="text-xs text-ink-500 mt-0.5">{r.desc}</div>
                  </div>
                  <div className="shrink-0 flex items-center gap-2 text-2xs">
                    {fires > 0 ? (
                      <>
                        <span className="rounded-md border border-ink-200 px-1.5 py-0.5 text-ink-600 tnum">{fires} fired</span>
                        {fails > 0 ? (
                          <span className="rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-amber-700 tnum font-medium">
                            {fails} failed
                          </span>
                        ) : (
                          <span className="rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-emerald-700 tnum font-medium">
                            all passed
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-ink-300 italic">no invoices yet</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
      <p className="text-xs text-ink-400 mt-3">
        Rules execute deterministically server-side on every extraction path (Excel, email, GLM-OCR).
        Fire/fail counts are live — recomputed from every invoice's <span className="font-mono">rule_results</span> array.
      </p>
    </div>
  );
}

function SummaryTile({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "green" | "amber" }) {
  const cls = tone === "green" ? "text-emerald-700" : tone === "amber" ? "text-amber-700" : "text-ink-900";
  return (
    <div className="rounded-lg border border-ink-200 px-3 py-2.5 bg-white">
      <div className="text-2xs uppercase tracking-wide text-ink-400 font-semibold">{label}</div>
      <div className={`text-xl font-semibold tnum mt-0.5 ${cls}`}>{value}</div>
    </div>
  );
}

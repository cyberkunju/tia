import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Building2, Plus, Globe, Settings2 } from "lucide-react";
import { api } from "../api";
import { PageHeader, Panel, EmptyState, Badge } from "../ui";

const JURISDICTION_TONE: Record<string, "green" | "amber" | "blue" | "slate"> = {
  UAE: "green", KSA: "amber", IN: "blue",
};

export function FinOpsClients() {
  const { data, isLoading } = useQuery({ queryKey: ["clients"], queryFn: api.listClients });

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Building2}
        title="Clients"
        description="Configure each TASC customer — channels, validation profile, dispatch rules."
        actions={
          <Link to="/finops/clients/new" className="inline-flex items-center gap-1.5 rounded-md bg-brand-500 hover:bg-brand-400 text-teal-950 text-sm font-semibold px-3 py-2 shadow-xs">
            <Plus size={14} /> New client
          </Link>
        }
      />

      {isLoading ? (
        <div className="text-sm text-ink-500">Loading…</div>
      ) : !data || data.length === 0 ? (
        <Panel><EmptyState icon={Building2} title="No clients yet" hint="Add your first client to start onboarding." /></Panel>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {data.map((c) => {
            const j = String(c.settings?.jurisdiction ?? "UAE");
            const trn = String(c.settings?.customer_trn ?? "—");
            const order = String(c.settings?.dispatch_order_rule ?? "—");
            const grouping = String(c.settings?.dispatch_grouping_mode ?? "—");
            return (
              <Link
                key={c.code}
                to={`/finops/clients/${c.code}`}
                className="card p-4 hover:border-brand-300 hover:shadow-md transition-all group"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Building2 size={13} className="text-teal-700" />
                      <span className="font-mono text-2xs text-ink-500">{c.code}</span>
                    </div>
                    <h3 className="text-sm font-semibold text-ink-900 truncate">{c.name}</h3>
                    <p className="text-2xs text-ink-500 truncate">{c.industry || "—"} · {c.city || "—"}</p>
                  </div>
                  <Badge tone={JURISDICTION_TONE[j] ?? "slate"}>
                    <Globe size={9} /> {j}
                  </Badge>
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-2 text-2xs">
                  <KV k="TRN" v={trn} />
                  <KV k="Order" v={order.replace(/_/g, " ")} />
                  <KV k="Grouping" v={grouping.replace(/_/g, " ")} />
                  <KV k="SLA" v={`${c.settings?.sla_days_to_invoice ?? "—"}d`} />
                </dl>

                <div className="mt-3 flex items-center justify-end text-2xs text-brand-700 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Settings2 size={11} className="mr-1" /> Configure
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-ink-500 uppercase tracking-wide text-[10px]">{k}</dt>
      <dd className="text-ink-800 font-medium truncate">{v}</dd>
    </div>
  );
}

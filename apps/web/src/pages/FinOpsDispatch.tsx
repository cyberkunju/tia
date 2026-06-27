import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Send, Check } from "lucide-react";
import { api } from "../api";
import { cn, fmtMoney } from "../lib";
import { PageHeader, Panel, StatusBadge, EmptyState, Spinner } from "../ui";

const RULES = [
  { id: "alphabetical", label: "Alphabetical by employee" },
  { id: "ascending_amount", label: "Ascending billable amount" },
  { id: "descending_amount", label: "Descending billable amount" },
  { id: "by_job_title", label: "Group by job title" },
];

export function FinOpsDispatch() {
  const { clientCode } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();

  const { data: clients } = useQuery({ queryKey: ["clients"], queryFn: api.listClients });
  const active = clientCode ?? clients?.[0]?.code;
  useEffect(() => {
    if (!clientCode && active) nav(`/finops/dispatch/${active}`, { replace: true });
  }, [active, clientCode, nav]);

  const { data: invoices } = useQuery({
    queryKey: ["invoices", active],
    queryFn: () => (active ? api.listInvoices(active) : Promise.resolve([])),
    enabled: !!active,
    refetchInterval: 4_000,
  });
  const client = clients?.find((c) => c.code === active);
  const initialRule = (client?.settings?.dispatch_rule as string) || "alphabetical";
  const [rule, setRule] = useState(initialRule);
  useEffect(() => setRule(initialRule), [initialRule]);

  const ordered = useMemo(() => {
    if (!invoices) return [];
    const copy = [...invoices];
    switch (rule) {
      case "ascending_amount": copy.sort((a, b) => a.amount - b.amount); break;
      case "descending_amount": copy.sort((a, b) => b.amount - a.amount); break;
      case "by_job_title":
        copy.sort((a, b) => (a.line_items[0]?.job_title ?? "").localeCompare(b.line_items[0]?.job_title ?? ""));
        break;
      default:
        copy.sort((a, b) => (a.line_items[0]?.employee_name ?? "").localeCompare(b.line_items[0]?.employee_name ?? ""));
    }
    return copy;
  }, [invoices, rule]);

  const pending = ordered.filter((i) => i.status === "generated");

  const saveRule = useMutation({
    mutationFn: () => api.updateClientSettings(active!, { dispatch_rule: rule }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["clients"] }),
  });
  const dispatchAll = useMutation({
    mutationFn: async () => { for (const inv of pending) await api.dispatchInvoice(inv.id); },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invoices", active] }),
  });

  return (
    <div>
      <PageHeader
        icon={Send}
        title="Dispatch"
        description="Per-client ordering rule and dispatch queue."
        actions={
          <select value={active} onChange={(e) => nav(`/finops/dispatch/${e.target.value}`)} className="select w-auto">
            {clients?.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}
          </select>
        }
      />

      <Panel
        title="Ordering rule"
        className="mb-4"
        actions={
          <>
            <button className="btn-outline btn-sm" disabled={saveRule.isPending || rule === initialRule} onClick={() => saveRule.mutate()}>
              {saveRule.isPending ? <Spinner /> : null} Save as default
            </button>
            <button className="btn-primary btn-sm" disabled={dispatchAll.isPending || pending.length === 0} onClick={() => dispatchAll.mutate()}>
              {dispatchAll.isPending ? <><Spinner /> Dispatching…</> : <><Send size={14} /> Dispatch {pending.length}</>}
            </button>
          </>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {RULES.map((r) => {
            const on = rule === r.id;
            return (
              <button
                key={r.id}
                onClick={() => setRule(r.id)}
                className={cn(
                  "flex items-center justify-between text-left text-sm px-3 py-2.5 rounded-md border transition-colors",
                  on ? "border-brand-500 bg-brand-50 text-brand-800" : "border-ink-200 hover:bg-ink-50 text-ink-700",
                )}
              >
                {r.label}
                {on && <Check size={15} className="text-brand-600" />}
              </button>
            );
          })}
        </div>
        {rule !== initialRule && <p className="text-xs text-amber-700 mt-2.5">Unsaved — “Save as default” to persist this client’s rule.</p>}
      </Panel>

      <Panel title={`Queue · ${ordered.length} invoice${ordered.length === 1 ? "" : "s"}`}>
        {ordered.length === 0 ? (
          <EmptyState title="No invoices for this client yet" />
        ) : (
          <ul className="space-y-2">
            {ordered.map((inv, i) => (
              <motion.li
                key={inv.id}
                layout
                transition={{ type: "spring", stiffness: 260, damping: 28 }}
                className="flex items-center justify-between border border-ink-200 rounded-lg px-3 py-2.5 bg-white"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="tnum text-xs text-ink-400 w-5 text-right">{i + 1}</span>
                  <div className="min-w-0">
                    <div className="font-medium text-sm text-ink-800 truncate">{inv.line_items[0]?.employee_name ?? inv.client_code}</div>
                    <div className="text-2xs text-ink-400 font-mono">{inv.id.slice(0, 8)} · {inv.line_items[0]?.job_title ?? "—"}</div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium tnum">{fmtMoney(inv.amount, inv.currency)}</span>
                  <StatusBadge status={inv.status} />
                </div>
              </motion.li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

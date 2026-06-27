import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { api } from "../api";
import { fmtMoney, statusBadgeClass } from "../lib";

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
        copy.sort((a, b) => {
          const ta = a.line_items[0]?.job_title ?? "";
          const tb = b.line_items[0]?.job_title ?? "";
          return ta.localeCompare(tb);
        });
        break;
      case "alphabetical":
      default:
        copy.sort((a, b) => (a.line_items[0]?.employee_name ?? "").localeCompare(b.line_items[0]?.employee_name ?? ""));
    }
    return copy;
  }, [invoices, rule]);

  const saveRule = useMutation({
    mutationFn: () => api.updateClientSettings(active!, { dispatch_rule: rule }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["clients"] }),
  });

  const dispatchAll = useMutation({
    mutationFn: async () => {
      for (const inv of ordered.filter((i) => i.status === "generated")) {
        await api.dispatchInvoice(inv.id);
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invoices", active] }),
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold">Dispatch</h1>
          <p className="text-sm text-ink-600">Per-client ordering rule and dispatch queue.</p>
        </div>
        <select
          value={active}
          onChange={(e) => nav(`/finops/dispatch/${e.target.value}`)}
          className="border border-ink-200 rounded-md px-3 py-1.5 text-sm bg-white"
        >
          {clients?.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}
        </select>
      </div>

      <div className="card p-4 mb-4">
        <h3 className="font-semibold mb-2">Ordering rule</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {RULES.map((r) => (
            <button
              key={r.id}
              onClick={() => setRule(r.id)}
              className={`text-left text-sm px-3 py-2 rounded-md border transition ${
                rule === r.id ? "border-brand-600 bg-brand-50 text-brand-700" : "border-ink-200 hover:bg-ink-50"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <button className="btn-outline" disabled={saveRule.isPending || rule === initialRule} onClick={() => saveRule.mutate()}>
            {saveRule.isPending ? "Saving…" : "Save as default"}
          </button>
          <button className="btn-primary" disabled={dispatchAll.isPending || ordered.length === 0} onClick={() => dispatchAll.mutate()}>
            {dispatchAll.isPending ? "Dispatching…" : `Dispatch ${ordered.filter((i) => i.status === "generated").length}`}
          </button>
        </div>
      </div>

      <div className="card p-4">
        <h3 className="font-semibold mb-3">Queue · {ordered.length} invoice{ordered.length === 1 ? "" : "s"}</h3>
        <ul className="space-y-2">
          {ordered.map((inv, i) => (
            <motion.li
              key={inv.id}
              layout
              transition={{ type: "spring", stiffness: 260, damping: 28 }}
              className="flex items-center justify-between border border-ink-100 rounded-lg px-3 py-2.5"
            >
              <div className="flex items-center gap-3">
                <span className="font-mono text-xs text-ink-400 w-6 text-right">{i + 1}</span>
                <div>
                  <div className="font-medium">{inv.line_items[0]?.employee_name ?? inv.client_code}</div>
                  <div className="text-xs text-ink-500">{inv.id.slice(0, 8)} · {inv.line_items[0]?.job_title ?? "—"}</div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-sm font-medium">{fmtMoney(inv.amount, inv.currency)}</div>
                <span className={statusBadgeClass(inv.status)}>{inv.status}</span>
              </div>
            </motion.li>
          ))}
          {ordered.length === 0 && (
            <li className="text-ink-400 text-sm text-center py-6">No invoices for this client yet.</li>
          )}
        </ul>
      </div>
    </div>
  );
}

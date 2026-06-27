import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Search, Inbox, TriangleAlert, BadgeCheck, ReceiptText, Send, Gauge,
  Building2, SlidersHorizontal, Upload, LayoutDashboard, CornerDownLeft,
  MessageSquare, ShieldCheck, Radar, RotateCcw,
} from "lucide-react";
import { api } from "../api";
import { cn } from "../lib";

type Item = { id: string; label: string; sub?: string; icon: typeof Search; to?: string; group: string; run?: () => Promise<void> };

const ACTIONS: Item[] = [
  { id: "s-intake", label: "Intake", sub: "Pipeline stage", icon: Inbox, to: "/console?stage=intake", group: "Console" },
  { id: "s-review", label: "Review", sub: "Needs human resolution", icon: TriangleAlert, to: "/console?stage=review", group: "Console" },
  { id: "s-validate", label: "Validated", sub: "Pipeline stage", icon: BadgeCheck, to: "/console?stage=validate", group: "Console" },
  { id: "s-invoice", label: "Invoice", sub: "Pipeline stage", icon: ReceiptText, to: "/console?stage=invoice", group: "Console" },
  { id: "s-dispatch", label: "Dispatch", sub: "Pipeline stage", icon: Send, to: "/console?stage=dispatch", group: "Console" },
  { id: "n-clients", label: "Clients & master data", icon: Building2, to: "/console/settings/clients", group: "Configure" },
  { id: "n-rules", label: "Validation rules", sub: "BTP-style rule set", icon: SlidersHorizontal, to: "/console/settings/rules", group: "Configure" },
  { id: "n-disp", label: "Dispatch rules", icon: Send, to: "/console/dispatch", group: "Configure" },
  { id: "n-track", label: "Dispatch tracking", icon: Radar, to: "/console/dispatch/tracking", group: "Configure" },
  { id: "n-eval", label: "Evaluation", sub: "Accuracy gate", icon: Gauge, to: "/console/eval", group: "Configure" },
  { id: "p-submit", label: "Submit timesheet", icon: Upload, to: "/portal", group: "Portal" },
  { id: "p-inv", label: "Client invoices", icon: ReceiptText, to: "/portal/invoices", group: "Portal" },
  { id: "p-q", label: "Client queries", icon: MessageSquare, to: "/portal/queries", group: "Portal" },
  { id: "f-close", label: "Finance - month close", icon: LayoutDashboard, to: "/finance", group: "Finance" },
  { id: "f-queue", label: "Finance approvals", icon: ShieldCheck, to: "/finance/queue", group: "Finance" },
  { id: "x-reset", label: "Reset demo data", sub: "Wipe transient state", icon: RotateCcw, group: "Admin", run: async () => { await api.demoReset(); location.reload(); } },
];

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: docs } = useQuery({ queryKey: ["docs"], queryFn: api.listDocs, enabled: open });
  const { data: clients } = useQuery({ queryKey: ["clients"], queryFn: api.listClients, enabled: open });

  useEffect(() => { if (open) { setQ(""); setActive(0); setTimeout(() => inputRef.current?.focus(), 10); } }, [open]);

  const results = useMemo<Item[]>(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return ACTIONS;
    const fromActions = ACTIONS.filter((a) => `${a.label} ${a.sub ?? ""} ${a.group}`.toLowerCase().includes(needle));
    const fromDocs: Item[] = (docs ?? [])
      .filter((d) => `${d.client_code ?? ""} ${d.period ?? ""} ${d.channel} ${d.status}`.toLowerCase().includes(needle))
      .slice(0, 6)
      .map((d) => ({ id: `d-${d.doc_id}`, label: `${d.client_code ?? "Unknown"} · ${d.period ?? "-"}`, sub: `${d.channel} · ${d.status}`, icon: Inbox, to: `/console?doc=${d.doc_id}`, group: "Documents" }));
    const fromClients: Item[] = (clients ?? [])
      .filter((c) => `${c.code} ${c.name} ${c.industry}`.toLowerCase().includes(needle))
      .slice(0, 6)
      .map((c) => ({ id: `c-${c.code}`, label: `${c.code} · ${c.name}`, sub: c.industry, icon: Building2, to: `/console/settings/clients?c=${c.code}`, group: "Clients" }));
    return [...fromActions, ...fromDocs, ...fromClients];
  }, [q, docs, clients]);

  useEffect(() => { setActive(0); }, [q]);
  if (!open) return null;

  const go = (it?: Item) => {
    if (!it) return;
    if (it.run) { void it.run(); onClose(); return; }
    if (it.to) { nav(it.to); onClose(); }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, results.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    if (e.key === "Enter") { e.preventDefault(); go(results[active]); }
  };

  let lastGroup = "";
  return (
    <div className="fixed inset-0 z-50 animate-fade-in" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-ink-950/40" />
      <div
        className="absolute left-1/2 top-[12vh] -translate-x-1/2 w-[min(92vw,640px)] card overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 border-b border-ink-200">
          <Search size={16} className="text-ink-400" />
          <input
            ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
            placeholder="Search documents, clients, invoices, or jump to…"
            className="flex-1 h-12 bg-transparent text-sm outline-none placeholder:text-ink-400"
          />
          <span className="kbd">esc</span>
        </div>
        <div className="max-h-[52vh] overflow-y-auto py-1.5">
          {results.length === 0 && <div className="px-4 py-6 text-center text-sm text-ink-400">No matches.</div>}
          {results.map((it, i) => {
            const header = it.group !== lastGroup ? ((lastGroup = it.group)) : null;
            return (
              <div key={it.id}>
                {header && <div className="eyebrow px-4 pt-2.5 pb-1">{header}</div>}
                <button
                  onMouseEnter={() => setActive(i)} onClick={() => go(it)}
                  className={cn("w-full flex items-center gap-3 px-4 py-2 text-left", i === active ? "bg-brand-50" : "hover:bg-ink-50")}
                >
                  <it.icon size={15} className={i === active ? "text-brand-600" : "text-ink-400"} />
                  <span className="min-w-0">
                    <span className="block text-sm text-ink-800 truncate">{it.label}</span>
                    {it.sub && <span className="block text-2xs text-ink-400 truncate">{it.sub}</span>}
                  </span>
                  {i === active && <CornerDownLeft size={13} className="ml-auto text-ink-300" />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

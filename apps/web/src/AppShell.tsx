import { useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Inbox, Send, Gauge, Upload, ReceiptText, TriangleAlert,
  LayoutDashboard, Menu, X, MessageSquare, Building2, FileBarChart2,
  Truck, ListChecks, type LucideIcon,
} from "lucide-react";
import { usePersona, type Persona } from "./store";
import { api } from "./api";
import { cn } from "./lib";
import { ChatWidget } from "./components/ChatWidget";

type NavEntry = { to: string; label: string; icon: LucideIcon; end?: boolean };

const PERSONAS: { id: Persona; label: string; blurb: string; nav: NavEntry[] }[] = [
  {
    id: "client",
    label: "Client",
    blurb: "Submit & approve",
    nav: [
      { to: "/client/submit", label: "Submit timesheet", icon: Upload },
      { to: "/client/invoices", label: "Invoices", icon: ReceiptText },
      { to: "/client/queries", label: "Queries", icon: MessageSquare },
    ],
  },
  {
    id: "finops",
    label: "FinOps",
    blurb: "Operate the pipeline",
    nav: [
      { to: "/finops", label: "Inbox", icon: Inbox, end: true },
      { to: "/finops/triage", label: "Triage", icon: TriangleAlert },
      { to: "/finops/dispatch", label: "Dispatch", icon: Send },
      { to: "/finops/dispatch-tracking", label: "Dispatch tracking", icon: Truck },
      { to: "/finops/clients", label: "Clients", icon: Building2 },
      { to: "/finops/eval", label: "Evaluation", icon: Gauge },
    ],
  },
  {
    id: "finance",
    label: "Finance",
    blurb: "Approve & report",
    nav: [
      { to: "/finance", label: "Dashboard", icon: LayoutDashboard },
      { to: "/finance/queue", label: "Approval queue", icon: ListChecks },
      { to: "/finops/eval", label: "Accuracy", icon: FileBarChart2 },
    ],
  },
];

function ApiStatus() {
  const { data, isError } = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    refetchInterval: 15_000,
    retry: false,
  });
  const ok = !!data && !isError;
  return (
    <div className="flex items-center gap-2 px-2.5 py-2 rounded-md bg-teal-800/40 border border-teal-700/60">
      <span className="relative flex h-2 w-2">
        {ok && <span className="absolute inline-flex h-full w-full rounded-full bg-brand-400 opacity-60 animate-ping" />}
        <span className={cn("relative inline-flex h-2 w-2 rounded-full", ok ? "bg-brand-400" : "bg-red-400")} />
      </span>
      <span className="text-xs font-medium text-teal-50/85">{ok ? "API operational" : "API unreachable"}</span>
    </div>
  );
}

function SidebarBrand() {
  return (
    <Link to="/" className="flex items-center gap-2.5 px-1">
      <span className="grid place-items-center h-9 w-9 rounded-lg bg-brand-500 text-teal-950 font-bold text-sm shadow-md">T</span>
      <span className="leading-tight">
        <span className="block text-sm font-semibold text-white tracking-tight">TIA</span>
        <span className="block text-2xs text-teal-200/80 tracking-wide">Touchless Invoice Agent</span>
      </span>
    </Link>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { persona, setPersona } = usePersona();
  const current = PERSONAS.find((p) => p.id === persona)!;
  const loc = useLocation();

  return (
    <div className="flex h-full flex-col gap-5 p-4">
      <SidebarBrand />

      <label className="block">
        <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-teal-300/80">Workspace</span>
        <div className="relative mt-1.5">
          <select
            value={persona}
            onChange={(e) => setPersona(e.target.value as Persona)}
            className="w-full rounded-md border border-teal-700/60 bg-teal-800/40 text-sm text-white px-3 py-2 font-medium pr-8 appearance-none focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30"
          >
            {PERSONAS.map((p) => (
              <option key={p.id} value={p.id} className="text-ink-900">{p.label} · {p.blurb}</option>
            ))}
          </select>
        </div>
      </label>

      <nav className="flex-1 -mx-1">
        <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-teal-300/80 px-2.5 mb-1.5">Navigation</p>
        <ul className="space-y-0.5">
          {current.nav.map((n) => {
            const active = n.end
              ? loc.pathname === n.to
              : loc.pathname === n.to || loc.pathname.startsWith(n.to + "/");
            return (
              <li key={n.to}>
                <NavLink
                  to={n.to}
                  end={n.end}
                  onClick={onNavigate}
                  className={cn(
                    "relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                    active
                      ? "bg-brand-500 text-teal-950 shadow-sm"
                      : "text-teal-100 hover:bg-teal-800/60 hover:text-white",
                  )}
                >
                  <n.icon size={17} strokeWidth={2} className="shrink-0" />
                  {n.label}
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="space-y-2">
        <ApiStatus />
        <p className="text-2xs text-teal-300/70 leading-relaxed px-1">
          TASC · Touchless Invoice Agent ·{" "}
          <span className="text-teal-200/90">Self-hosted · BTP-style rules · eval-gated</span>
        </p>
      </div>
    </div>
  );
}

export function AppShell() {
  const [open, setOpen] = useState(false);

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[var(--app-sidebar)_1fr]">
      {/* Desktop sidebar — TASC deep teal */}
      <aside className="hidden lg:block bg-teal-900 sticky top-0 h-screen">
        <SidebarContent />
      </aside>

      {/* Mobile top bar */}
      <header className="lg:hidden sticky top-0 z-30 flex items-center justify-between h-14 px-4 bg-teal-900">
        <SidebarBrand />
        <button className="grid place-items-center h-9 w-9 rounded-md text-white hover:bg-teal-800" onClick={() => setOpen(true)} aria-label="Open menu">
          <Menu size={20} />
        </button>
      </header>

      {/* Mobile drawer */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-40 animate-fade-in">
          <div className="absolute inset-0 bg-teal-950/60" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-0 bottom-0 w-72 bg-teal-900 shadow-lg">
            <button className="grid place-items-center h-9 w-9 rounded-md text-white hover:bg-teal-800 absolute top-3 right-3" onClick={() => setOpen(false)} aria-label="Close menu">
              <X size={18} />
            </button>
            <SidebarContent onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}

      {/* Main */}
      <div className="flex min-h-screen flex-col min-w-0 relative">
        <main className="flex-1 w-full max-w-[1440px] mx-auto px-5 sm:px-7 py-6 sm:py-8">
          <Outlet />
        </main>
        <ChatWidget />
      </div>
    </div>
  );
}

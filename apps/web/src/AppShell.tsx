import { useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Inbox, Send, Gauge, Upload, ReceiptText, TriangleAlert,
  LayoutDashboard, Menu, X, type LucideIcon,
} from "lucide-react";
import { usePersona, type Persona } from "./store";
import { api } from "./api";
import { cn } from "./lib";

type NavEntry = { to: string; label: string; icon: LucideIcon; end?: boolean };

const PERSONAS: { id: Persona; label: string; blurb: string; nav: NavEntry[] }[] = [
  {
    id: "client",
    label: "Client",
    blurb: "Submit & track",
    nav: [
      { to: "/client/submit", label: "Submit timesheet", icon: Upload },
      { to: "/client/invoices", label: "Invoices", icon: ReceiptText },
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
      { to: "/finops/eval", label: "Evaluation", icon: Gauge },
    ],
  },
  {
    id: "finance",
    label: "Finance",
    blurb: "Month close",
    nav: [{ to: "/finance", label: "Close dashboard", icon: LayoutDashboard }],
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
    <div className="flex items-center gap-2 px-2.5 py-2 rounded-md bg-ink-50 border border-ink-200">
      <span className="relative flex h-2 w-2">
        {ok && <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 animate-ping" />}
        <span className={cn("relative inline-flex h-2 w-2 rounded-full", ok ? "bg-emerald-500" : "bg-red-500")} />
      </span>
      <span className="text-xs font-medium text-ink-600">{ok ? "API operational" : "API unreachable"}</span>
    </div>
  );
}

function SidebarBrand() {
  return (
    <Link to="/" className="flex items-center gap-2.5 px-1">
      <span className="grid place-items-center h-8 w-8 rounded-lg bg-brand-600 text-white font-bold text-sm shadow-xs">T</span>
      <span className="leading-tight">
        <span className="block text-sm font-semibold text-ink-900">TIA</span>
        <span className="block text-2xs text-ink-400 tracking-wide">Touchless Invoice Agent</span>
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
        <span className="eyebrow">Workspace</span>
        <div className="relative mt-1.5">
          <select
            value={persona}
            onChange={(e) => setPersona(e.target.value as Persona)}
            className="select appearance-none pr-8 font-medium"
          >
            {PERSONAS.map((p) => (
              <option key={p.id} value={p.id}>{p.label} · {p.blurb}</option>
            ))}
          </select>
        </div>
      </label>

      <nav className="flex-1 -mx-1">
        <p className="eyebrow px-2.5 mb-1.5">Navigation</p>
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
                  className={cn("nav-item", active && "nav-item-active")}
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
        <p className="text-2xs text-ink-400 leading-relaxed px-1">
          Self-hosted · open-weight OCR · Hungarian assignment · eval-gated
        </p>
      </div>
    </div>
  );
}

export function AppShell() {
  const [open, setOpen] = useState(false);

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[var(--app-sidebar)_1fr]">
      {/* Desktop sidebar */}
      <aside className="hidden lg:block border-r border-ink-200 bg-white sticky top-0 h-screen">
        <SidebarContent />
      </aside>

      {/* Mobile top bar */}
      <header className="lg:hidden sticky top-0 z-30 flex items-center justify-between h-14 px-4 bg-white border-b border-ink-200">
        <SidebarBrand />
        <button className="btn-ghost btn-sm" onClick={() => setOpen(true)} aria-label="Open menu">
          <Menu size={20} />
        </button>
      </header>

      {/* Mobile drawer */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-40 animate-fade-in">
          <div className="absolute inset-0 bg-ink-950/40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-0 bottom-0 w-72 bg-white border-r border-ink-200 shadow-lg">
            <button className="btn-ghost btn-sm absolute top-3 right-3" onClick={() => setOpen(false)} aria-label="Close menu">
              <X size={18} />
            </button>
            <SidebarContent onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}

      {/* Main */}
      <div className="flex min-h-screen flex-col min-w-0">
        <main className="flex-1 w-full max-w-[1440px] mx-auto px-5 sm:px-7 py-6 sm:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

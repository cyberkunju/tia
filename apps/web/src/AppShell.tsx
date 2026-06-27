import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { usePersona, type Persona } from "./store";
import { cn } from "./lib";

const PERSONAS: { id: Persona; label: string; nav: { to: string; label: string }[] }[] = [
  {
    id: "client",
    label: "Client",
    nav: [
      { to: "/client/submit", label: "Submit timesheet" },
      { to: "/client/invoices", label: "My invoices" },
    ],
  },
  {
    id: "finops",
    label: "FinOps",
    nav: [
      { to: "/finops", label: "Inbox" },
      { to: "/finops/triage", label: "Triage" },
      { to: "/finops/dispatch", label: "Dispatch" },
      { to: "/finops/eval", label: "Eval" },
    ],
  },
  {
    id: "finance",
    label: "Finance",
    nav: [
      { to: "/finance", label: "Close dashboard" },
    ],
  },
];

export function AppShell() {
  const { persona, setPersona } = usePersona();
  const current = PERSONAS.find((p) => p.id === persona)!;
  const loc = useLocation();

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white border-b border-ink-200 sticky top-0 z-20">
        <div className="px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link to="/" className="font-semibold tracking-tight text-ink-900">
              <span className="text-brand-600">TIA</span>
              <span className="text-ink-400"> · Touchless Invoice Agent</span>
            </Link>
            <nav className="flex items-center gap-1">
              {current.nav.map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  className={({ isActive }) =>
                    cn(
                      "px-3 py-1.5 rounded-md text-sm font-medium",
                      isActive || loc.pathname.startsWith(n.to + "/")
                        ? "bg-brand-50 text-brand-700"
                        : "text-ink-600 hover:text-ink-900 hover:bg-ink-100",
                    )
                  }
                >
                  {n.label}
                </NavLink>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-ink-400 uppercase tracking-wider">persona</span>
            <select
              value={persona}
              onChange={(e) => setPersona(e.target.value as Persona)}
              className="text-sm rounded-md border border-ink-200 bg-white px-2 py-1.5"
            >
              {PERSONAS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>
        </div>
      </header>

      <main className="flex-1 px-6 py-6 max-w-[1400px] w-full mx-auto">
        <Outlet />
      </main>

      <footer className="text-xs text-ink-400 text-center py-4">
        TIA · self-hosted, open-weight OCR · evidence graph · Hungarian assignment · eval-gated
      </footer>
    </div>
  );
}

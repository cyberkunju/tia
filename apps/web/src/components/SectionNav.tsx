import { NavLink } from "react-router-dom";
import { usePersona, type Persona } from "../store";
import { cn } from "../lib";

const LINKS: Record<Persona, { to: string; label: string; end?: boolean }[]> = {
  finops: [
    { to: "/console", label: "Pipeline" },
    { to: "/console?stage=review", label: "Approvals" },
    { to: "/console/settings/clients", label: "Clients" },
    { to: "/console/settings/rules", label: "Rules" },
    { to: "/console/dispatch", label: "Dispatch", end: true },
    { to: "/console/dispatch/tracking", label: "Tracking" },
    { to: "/console/eval", label: "Evaluation" },
  ],
  client: [
    { to: "/portal", label: "Submit", end: true },
    { to: "/portal/invoices", label: "Invoices" },
    { to: "/portal/queries", label: "Queries" },
  ],
  finance: [
    { to: "/finance", label: "Overview", end: true },
    { to: "/finance/queue", label: "Approvals" },
  ],
};

export function SectionNav() {
  const { persona } = usePersona();
  return (
    <nav className="flex items-center gap-1 mb-6 -mt-1 border-b border-ink-200 pb-px overflow-x-auto">
      {LINKS[persona].map((l) => (
        <NavLink
          key={l.to}
          to={l.to}
          end={l.end}
          className={({ isActive }) =>
            cn(
              "relative px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors -mb-px border-b-2",
              isActive ? "border-brand-500 text-ink-900" : "border-transparent text-ink-500 hover:text-ink-900",
            )
          }
        >
          {l.label}
        </NavLink>
      ))}
    </nav>
  );
}

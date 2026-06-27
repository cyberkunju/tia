import { useEffect, useState } from "react";
import { Link, Outlet, useNavigate } from "react-router-dom";
import { Search } from "lucide-react";
import { usePersona, type Persona } from "./store";
import { cn } from "./lib";
import { Logo } from "./components/Logo";
import { CommandPalette } from "./components/CommandPalette";
import { Assistant } from "./components/Assistant";

const PERSONA_HOME: Record<Persona, string> = { finops: "/console", client: "/portal", finance: "/finance" };
const PERSONAS: { id: Persona; label: string }[] = [
  { id: "finops", label: "FinOps" },
  { id: "client", label: "Client" },
  { id: "finance", label: "Finance" },
];

export function AppShell() {
  const { persona, setPersona } = usePersona();
  const nav = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [aidaOpen, setAidaOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletteOpen((v) => !v); }
      if (e.key === "Escape") { setPaletteOpen(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const switchPersona = (p: Persona) => { setPersona(p); nav(PERSONA_HOME[p]); };

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-30 h-12 brand-band text-white shadow-sm">
        <div className="h-full px-3 sm:px-4 flex items-center gap-3">
          <Link to={PERSONA_HOME[persona]} className="flex items-center gap-2.5 shrink-0 group">
            <Logo className="h-[18px] text-white" accent="fill-[#ffd9c7]" />
            <span className="hidden md:block text-2xs text-white/70 border-l border-white/25 pl-2.5 leading-tight">
              Touchless<br />Invoice Agent
            </span>
          </Link>

          <button
            onClick={() => setPaletteOpen(true)}
            className="group flex items-center gap-2 h-8 rounded-lg border border-white/20 bg-white/10 text-white/70 hover:bg-white/20 hover:border-white/30 transition-colors
                       w-9 justify-center shrink-0
                       sm:w-auto sm:flex-1 sm:max-w-md sm:mx-auto sm:px-3 sm:justify-start"
          >
            <Search size={14} className="text-white/80" />
            <span className="hidden sm:inline text-xs">Search documents, clients, invoices…</span>
            <span className="ml-auto hidden sm:flex items-center gap-0.5">
              <kbd className="inline-flex items-center justify-center h-[18px] min-w-[18px] px-1 rounded border border-white/25 bg-white/10 text-[10px] font-medium text-white/80">⌘</kbd>
              <kbd className="inline-flex items-center justify-center h-[18px] min-w-[18px] px-1 rounded border border-white/25 bg-white/10 text-[10px] font-medium text-white/80">K</kbd>
            </span>
          </button>

          <div className="flex p-0.5 rounded-lg bg-white/10 border border-white/15 shrink-0 ml-auto sm:ml-0">
            {PERSONAS.map((p) => (
              <button
                key={p.id}
                onClick={() => switchPersona(p.id)}
                className={cn(
                  "px-2 sm:px-2.5 py-1 rounded-md text-[11px] sm:text-xs font-medium transition-colors",
                  persona === p.id ? "bg-white text-brand-700 shadow-xs" : "text-white/75 hover:text-white",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="flex-1 min-w-0">
        <Outlet />
      </main>

      {/* Floating AIDA launcher — vertical tab in the reserved right rail */}
      {!aidaOpen && (
        <button
          onClick={() => setAidaOpen(true)}
          aria-label="Open AIDA assistant"
          className="fixed right-0 bottom-0 z-40 flex flex-col items-center gap-2.5
                     w-10 pt-3.5 pb-5 brand-band text-white shadow-md hover:shadow-lg
                     rounded-tl-xl ring-1 ring-brand-700/30 transition-shadow"
        >
          <Logo className="h-3 text-white" accent="fill-[#ffd9c7]" />
          <span className="h-px w-4 bg-white/25" />
          <span className="[writing-mode:vertical-rl] text-[13px] font-medium">AI chat</span>
        </button>
      )}

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <Assistant open={aidaOpen} onClose={() => setAidaOpen(false)} />
    </div>
  );
}

import { useEffect, useState } from "react";
import { Link, Outlet, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCw, Search, Mail } from "lucide-react";
import { usePersona, type Persona } from "./store";
import { api } from "./api";
import { cn } from "./lib";
import { Logo } from "./components/Logo";
import { CommandPalette } from "./components/CommandPalette";
import { Assistant } from "./components/Assistant";
import { Select } from "./components/Select";

const PERSONA_HOME: Record<Persona, string> = { finops: "/console", client: "/portal", finance: "/finance" };
const PERSONAS: { id: Persona; label: string }[] = [
  { id: "client", label: "Client" },
  { id: "finops", label: "FinOps" },
  { id: "finance", label: "Finance" },
];

/**
 * Acting-as Client picker - only visible when the active persona is "client".
 * Picks the client identity the Portal pages scope to. Defaults to CL001 the
 * first time someone switches into the Client persona (handled in store.ts).
 */
function ActingAsPicker() {
  const { currentClientCode, setCurrentClientCode } = usePersona();
  const { data: clients } = useQuery({ queryKey: ["clients"], queryFn: api.listClients });
  return (
    <Select
      variant="band"
      className="hidden sm:inline-block"
      value={currentClientCode ?? ""}
      onChange={(v) => setCurrentClientCode(v || null)}
      options={(clients ?? []).map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` }))}
      placeholder={clients ? "Select client" : "Loading…"}
      ariaLabel="Client this portal is acting on behalf of"
      title="Client this portal is acting on behalf of"
    />
  );
}

/**
 * Stage helper - wipes demo data via /admin/demo-reset so the same browser can
 * replay the click-through without leaving the page. Always visible (no URL
 * gate) so it works mid-recording. Single-click - no confirm dialog - because
 * "fast" is the whole point during a demo.
 */
function DemoResetButton() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const bumpReset = usePersona((s) => s.bumpReset);
  const reset = useMutation({
    mutationFn: api.demoReset,
    onSuccess: () => {
      qc.clear();
      bumpReset();
      nav("/portal", { replace: true });
    },
  });
  return (
    <button
      onClick={() => reset.mutate()}
      disabled={reset.isPending}
      className="hidden sm:inline-flex items-center gap-1 h-8 rounded-lg border border-amber-300/40 bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 text-[11px] font-medium px-2.5 disabled:opacity-60 shrink-0"
      title="Wipe all documents, timesheets, invoices, and events - for demo replay."
    >
      <RotateCw size={11} className={reset.isPending ? "animate-spin" : ""} />
      {reset.isPending ? "Resetting…" : "Reset demo"}
    </button>
  );
}

export function AppShell() {
  const { persona, setPersona, aidaOpen, setAidaOpen } = usePersona();
  const nav = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);

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

          {/* Acting-as Client identity - only relevant for the Client persona. */}
          {persona === "client" && <ActingAsPicker />}

          {/* Quick contact - WhatsApp + email. Hidden on mobile so the compact
              header doesn't overflow (search + persona switch take priority). */}
          <div className="hidden sm:flex items-center gap-1.5 shrink-0">
            <a
              href="https://wa.me/919400245958?text=Hi"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Chat on WhatsApp"
              title="WhatsApp +91 94002 45958"
              className="inline-flex items-center justify-center h-8 w-8 rounded-lg border border-white/20 bg-white/10 text-white/80 hover:bg-white/20 hover:border-white/30 transition-colors"
            >
              <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor" aria-hidden="true">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.872.118.57-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.885-9.885 9.885M20.52 3.449C18.24 1.245 15.24 0 12.045 0 5.463 0 .104 5.359.101 11.892c0 2.096.549 4.142 1.595 5.945L0 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.582 0 11.943-5.359 11.945-11.893a11.821 11.821 0 00-3.418-8.453z" />
              </svg>
            </a>
            <a
              href="mailto:tia@cyberkunju.com"
              aria-label="Send an email"
              title="Email tia@cyberkunju.com"
              className="inline-flex items-center justify-center h-8 w-8 rounded-lg border border-white/20 bg-white/10 text-white/80 hover:bg-white/20 hover:border-white/30 transition-colors"
            >
              <Mail size={15} />
            </a>
          </div>

          <DemoResetButton />

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

      {/* Floating AIDA launcher - vertical tab in the reserved right rail */}
      {!aidaOpen && (
        <button
          onClick={() => setAidaOpen(true)}
          aria-label="Open TIA chat"
          className="fixed right-0 bottom-0 z-40 flex flex-col items-center gap-2.5
                     w-10 pt-3.5 pb-5 brand-band text-white shadow-md hover:shadow-lg
                     rounded-tl-xl ring-1 ring-brand-700/30 transition-shadow"
        >
          <Logo className="h-3 text-white" accent="fill-[#ffd9c7]" />
          <span className="h-px w-4 bg-white/25" />
          <span className="[writing-mode:vertical-rl] text-[13px] font-medium">Chat</span>
        </button>
      )}

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <Assistant open={aidaOpen} onClose={() => setAidaOpen(false)} />
    </div>
  );
}

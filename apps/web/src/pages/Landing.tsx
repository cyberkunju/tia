import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import {
  Inbox, ScanText, Users, ShieldCheck, ReceiptText, Send,
  Layers, MessageSquareText, BadgeCheck, Scale, Link2, Gauge,
  LayoutDashboard, Building2, LineChart, ArrowRight, ArrowUpRight, Check,
} from "lucide-react";
import { api } from "../api";
import { fmtPct } from "../lib";
import { Logo } from "../components/Logo";

/* ────────────────────────────── content ────────────────────────────── */

const STAGES: { icon: typeof Inbox; name: string; line: string }[] = [
  { icon: Inbox, name: "Ingest", line: "Email, Excel, PDF, handwriting, or WhatsApp. Any shape lands here." },
  { icon: ScanText, name: "Extract", line: "OCR and deterministic parsers turn every page into structured lines." },
  { icon: Users, name: "Resolve", line: "Match each associate to the right contract, rate card, and emp ID." },
  { icon: ShieldCheck, name: "Validate", line: "Rate, OT caps, scope, VAT and anomalies, checked by rules R1 to R15." },
  { icon: ReceiptText, name: "Invoice", line: "A UAE tax invoice with TRN, SAC code, and 5% VAT, line by line." },
  { icon: Send, name: "Dispatch", line: "Auto-sent under tolerance. People step in only on real exceptions." },
];

const FEATURES: { icon: typeof Layers; title: string; body: string }[] = [
  { icon: Layers, title: "Every input shape", body: "Seven real-world formats, from clean spreadsheets to a photo of a signed sheet. No template required." },
  { icon: MessageSquareText, title: "Grounded TIA chat", body: "Ask anything about the live pipeline. Every answer is read from the database and cited, never invented." },
  { icon: BadgeCheck, title: "UAE-ready invoices", body: "Tax invoices with TRN, SAC codes, and 5% VAT, formatted the way Finance expects to file them." },
  { icon: Scale, title: "Deterministic rules", body: "Rate mismatches, overtime caps, out-of-scope work, and padded sheets are caught before billing." },
  { icon: Link2, title: "Tamper-evident audit", body: "A hash-linked chain over every event. Any edit to history is detectable at a glance." },
  { icon: Gauge, title: "Straight-through", body: "Confidence-gated automation dispatches the clean cases and routes only the doubtful ones to a human." },
];

const PERSONAS: { icon: typeof LayoutDashboard; name: string; desc: string; to: string; cta: string }[] = [
  { icon: LayoutDashboard, name: "FinOps", desc: "The pipeline console: review queue, dispatch, rules, and evaluation.", to: "/console", cta: "Open console" },
  { icon: Building2, name: "Client", desc: "Submit timesheets, track invoices, and raise billing queries.", to: "/portal", cta: "Open portal" },
  { icon: LineChart, name: "Finance", desc: "Month close: touchless rate, cycle time, accuracy, and billed value.", to: "/finance", cta: "Open dashboard" },
];

/* ────────────────────────────── helpers ────────────────────────────── */

function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="eyebrow text-brand-600">{children}</div>;
}

/* ────────────────────────────── nav ────────────────────────────── */

function LandingNav() {
  const [solid, setSolid] = useState(false);
  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 12);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <header className={`fixed inset-x-0 top-0 z-40 transition-colors duration-300 ${solid ? "bg-white/85 backdrop-blur-md border-b border-ink-200/70" : "border-b border-transparent"}`}>
      <div className="mx-auto max-w-[1180px] px-4 sm:px-6 h-16 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2.5">
          <Logo className="h-5 text-brand-500" accent="fill-brand-500" />
          <span className="hidden sm:block text-2xs text-ink-400 border-l border-ink-300 pl-2.5 leading-tight">
            Touchless<br />Invoice Agent
          </span>
        </Link>
        <nav className="hidden md:flex items-center gap-7 text-sm text-ink-600">
          <a href="#how" className="hover:text-ink-900 transition-colors">How it works</a>
          <a href="#capabilities" className="hover:text-ink-900 transition-colors">Capabilities</a>
          <a href="#personas" className="hover:text-ink-900 transition-colors">For your team</a>
        </nav>
        <Link to="/console" className="btn-primary btn-sm">
          Open console <ArrowRight size={14} />
        </Link>
      </div>
    </header>
  );
}

/* ────────────────────────────── hero ────────────────────────────── */

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="absolute inset-0 hero-glow" aria-hidden />
      <div className="absolute inset-0 bg-dotgrid opacity-60" aria-hidden />
      <div className="relative mx-auto max-w-[1180px] px-4 sm:px-6 pt-32 pb-20 lg:pt-40 lg:pb-28">
        <div className="grid lg:grid-cols-[1.05fr_0.95fr] gap-12 lg:gap-10 items-center">
          <div>
            <Reveal>
              <div className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50/70 px-3 py-1 text-2xs font-semibold text-brand-700">
                <span className="tnum">TASC Outsourcing</span>
                <span className="h-1 w-1 rounded-full bg-brand-400" />
                United Arab Emirates
              </div>
            </Reveal>
            <Reveal delay={0.05}>
              <h1 className="mt-5 text-4xl sm:text-5xl lg:text-[3.4rem] font-semibold leading-[1.05] tracking-tight text-ink-900">
                Timesheets in.<br />
                <span className="text-brand-gradient">Compliant invoices out.</span>
              </h1>
            </Reveal>
            <Reveal delay={0.1}>
              <p className="mt-5 text-base sm:text-lg text-ink-600 leading-relaxed max-w-xl">
                TIA reads timesheets from email, Excel, PDF, WhatsApp, or a photo. It extracts every
                line, matches people to contracts, checks your rules and UAE VAT, then issues and
                dispatches the invoice. Every figure traces back to its source.
              </p>
            </Reveal>
            <Reveal delay={0.15}>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link to="/console" className="btn-primary px-5 py-2.5 text-sm">
                  Open the console <ArrowRight size={16} />
                </Link>
                <a href="#how" className="btn-outline px-5 py-2.5 text-sm">See how it works</a>
              </div>
            </Reveal>
            <Reveal delay={0.2}>
              <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-ink-500">
                {["No templates", "No wrappers", "Full audit trail"].map((t) => (
                  <span key={t} className="inline-flex items-center gap-1.5">
                    <Check size={14} className="text-brand-500" /> {t}
                  </span>
                ))}
              </div>
            </Reveal>
          </div>

          <Reveal delay={0.12}>
            <HeroPanel />
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/* A calm product glance: a generated tax invoice with a touchless chip. */
function HeroPanel() {
  return (
    <div className="relative">
      <div className="absolute -inset-4 brand-band rounded-[1.6rem] opacity-[0.07] blur-xl" aria-hidden />
      <div className="relative rounded-2xl border border-ink-200 bg-white shadow-lg overflow-hidden">
        <div className="h-1.5 brand-band" />
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-ink-100">
          <div className="flex items-center gap-2">
            <Logo className="h-3.5 text-brand-500" accent="fill-brand-500" />
            <span className="text-xs font-medium text-ink-500">Tax invoice</span>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 text-emerald-700 px-2 py-0.5 text-2xs font-semibold">
            <Check size={11} /> Touchless
          </span>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="flex items-center justify-between text-sm">
            <div>
              <div className="font-semibold text-ink-900">Emirates Steel Industries LLC</div>
              <div className="text-2xs text-ink-400 font-mono">CL001 · June 2026 · TRN 100312345600003</div>
            </div>
            <div className="text-right">
              <div className="eyebrow">Total incl. VAT</div>
              <div className="text-lg font-semibold tnum text-ink-900">AED 48,720.00</div>
            </div>
          </div>
          <div className="rounded-lg border border-ink-100 divide-y divide-ink-100">
            {[
              ["Carlos Smith", "20 days", "AED 21,600.00"],
              ["Ahmed Khan", "20 days · 2 OT", "AED 22,840.00"],
            ].map(([n, m, a]) => (
              <div key={n} className="flex items-center justify-between px-3 py-2 text-sm">
                <div className="min-w-0">
                  <div className="font-medium text-ink-800 truncate">{n}</div>
                  <div className="text-2xs text-ink-400">{m}</div>
                </div>
                <span className="tnum text-ink-700 shrink-0">{a}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between text-2xs text-ink-500">
            <span className="inline-flex items-center gap-1"><ShieldCheck size={12} className="text-brand-500" /> R1 to R15 passed</span>
            <span className="font-mono">SAC 998515 · VAT 5%</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────── live metrics ────────────────────────────── */

function MetricsStrip() {
  const { data: stp } = useQuery({ queryKey: ["m-stp"], queryFn: api.metricsStp, retry: false, staleTime: 30_000 });
  const { data: time } = useQuery({ queryKey: ["m-time"], queryFn: api.metricsTimeToInvoice, retry: false, staleTime: 30_000 });
  const { data: acc } = useQuery({ queryKey: ["m-acc"], queryFn: api.metricsAccuracy, retry: false, staleTime: 30_000 });

  const touchless = stp && stp.total > 0 ? fmtPct(stp.touchless_rate) : "Target 90%";
  const cycle = time && time.samples > 0 ? `${time.mean_minutes.toFixed(1)} min` : "Under 5 min";
  const f1 = acc?.overall_macro_f1 != null ? acc.overall_macro_f1.toFixed(2) : "0.98+";

  const items = [
    { k: touchless, v: "Touchless rate", note: "invoices sent with zero human touch" },
    { k: cycle, v: "Cycle time", note: "from timesheet to dispatched invoice" },
    { k: f1, v: "Extraction F1", note: "field accuracy on the eval set" },
    { k: "R1-R15", v: "Rule coverage", note: "rate, OT, scope, VAT, anomalies" },
  ];
  return (
    <section className="border-y border-ink-200 bg-white/60">
      <div className="mx-auto max-w-[1180px] px-4 sm:px-6 py-8 grid grid-cols-2 lg:grid-cols-4 gap-y-6 gap-x-4">
        {items.map((it, i) => (
          <Reveal key={it.v} delay={i * 0.05}>
            <div className="text-center lg:text-left">
              <div className="text-2xl sm:text-3xl font-semibold tnum tracking-tight text-ink-900">{it.k}</div>
              <div className="mt-1 text-sm font-medium text-ink-700">{it.v}</div>
              <div className="text-2xs text-ink-400">{it.note}</div>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

/* ────────────────────────────── pipeline ────────────────────────────── */

function PipelineSection() {
  return (
    <section id="how" className="relative scroll-mt-20">
      <div className="mx-auto max-w-[1180px] px-4 sm:px-6 py-20 lg:py-28">
        <Reveal>
          <Eyebrow>The pipeline</Eyebrow>
          <h2 className="mt-2 text-3xl sm:text-4xl font-semibold tracking-tight text-ink-900 max-w-2xl">
            One path from a raw timesheet to a dispatched invoice.
          </h2>
          <p className="mt-3 text-ink-600 max-w-2xl">
            Six deterministic stages. Each one shows its work, so every billable number can be
            traced back to the exact line it came from.
          </p>
        </Reveal>

        <div className="mt-12 grid sm:grid-cols-2 lg:grid-cols-3 gap-px bg-ink-200 rounded-2xl overflow-hidden border border-ink-200">
          {STAGES.map((s, i) => (
            <Reveal key={s.name} delay={(i % 3) * 0.06}>
              <div className="group h-full bg-white p-6 transition-colors hover:bg-brand-50/40">
                <div className="flex items-center justify-between">
                  <span className="grid place-items-center h-10 w-10 rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100 transition-colors group-hover:bg-brand-100">
                    <s.icon size={19} strokeWidth={2} />
                  </span>
                  <span className="text-3xl font-semibold tnum text-ink-200 group-hover:text-brand-200 transition-colors">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                </div>
                <h3 className="mt-4 text-base font-semibold text-ink-900">{s.name}</h3>
                <p className="mt-1 text-sm text-ink-500 leading-relaxed">{s.line}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ────────────────────────────── capabilities ────────────────────────────── */

function CapabilitiesSection() {
  return (
    <section id="capabilities" className="relative scroll-mt-20 bg-dotgrid">
      <div className="mx-auto max-w-[1180px] px-4 sm:px-6 py-20 lg:py-28">
        <Reveal>
          <Eyebrow>Capabilities</Eyebrow>
          <h2 className="mt-2 text-3xl sm:text-4xl font-semibold tracking-tight text-ink-900 max-w-2xl">
            Built for real staffing operations, not a happy-path demo.
          </h2>
        </Reveal>
        <div className="mt-12 grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURES.map((f, i) => (
            <Reveal key={f.title} delay={(i % 3) * 0.06}>
              <div className="h-full rounded-2xl border border-ink-200 bg-white p-6 shadow-xs hover:shadow-md hover:-translate-y-0.5 transition-all duration-200">
                <span className="grid place-items-center h-10 w-10 rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100">
                  <f.icon size={19} strokeWidth={2} />
                </span>
                <h3 className="mt-4 text-base font-semibold text-ink-900">{f.title}</h3>
                <p className="mt-1.5 text-sm text-ink-500 leading-relaxed">{f.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ────────────────────────────── personas ────────────────────────────── */

function PersonasSection() {
  return (
    <section id="personas" className="relative scroll-mt-20">
      <div className="mx-auto max-w-[1180px] px-4 sm:px-6 py-20 lg:py-28">
        <Reveal>
          <Eyebrow>For your team</Eyebrow>
          <h2 className="mt-2 text-3xl sm:text-4xl font-semibold tracking-tight text-ink-900 max-w-2xl">
            Three views, one source of truth.
          </h2>
        </Reveal>
        <div className="mt-12 grid md:grid-cols-3 gap-4">
          {PERSONAS.map((p, i) => (
            <Reveal key={p.name} delay={i * 0.06}>
              <Link
                to={p.to}
                className="group flex h-full flex-col rounded-2xl border border-ink-200 bg-white p-6 shadow-xs hover:border-brand-300 hover:shadow-md transition-all duration-200"
              >
                <span className="grid place-items-center h-11 w-11 rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100">
                  <p.icon size={20} strokeWidth={2} />
                </span>
                <h3 className="mt-4 text-lg font-semibold text-ink-900">{p.name}</h3>
                <p className="mt-1 text-sm text-ink-500 leading-relaxed flex-1">{p.desc}</p>
                <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-brand-700">
                  {p.cta}
                  <ArrowUpRight size={15} className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                </span>
              </Link>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ────────────────────────────── cta + footer ────────────────────────────── */

function CtaBand() {
  return (
    <section className="mx-auto max-w-[1180px] px-4 sm:px-6 pb-20 lg:pb-28">
      <Reveal>
        <div className="relative overflow-hidden rounded-3xl brand-band px-8 py-14 sm:px-14 text-center shadow-lg">
          <div className="absolute inset-0 bg-dotgrid opacity-10" aria-hidden />
          <div className="relative">
            <Logo className="h-7 mx-auto text-white" accent="fill-[#ffd9c7]" />
            <h2 className="mt-5 text-2xl sm:text-3xl font-semibold tracking-tight text-white">
              See it run on live data.
            </h2>
            <p className="mt-2 text-white/85 max-w-lg mx-auto">
              Open the console and walk a timesheet from intake to a dispatched, audited tax invoice.
            </p>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
              <Link to="/console" className="inline-flex items-center gap-1.5 rounded-md bg-white px-5 py-2.5 text-sm font-semibold text-brand-700 hover:bg-white/90 transition-colors shadow-xs">
                Open the console <ArrowRight size={16} />
              </Link>
              <Link to="/portal" className="inline-flex items-center gap-1.5 rounded-md border border-white/35 px-5 py-2.5 text-sm font-medium text-white hover:bg-white/10 transition-colors">
                Try the client portal
              </Link>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

function LandingFooter() {
  return (
    <footer className="border-t border-ink-200">
      <div className="mx-auto max-w-[1180px] px-4 sm:px-6 py-10 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <Logo className="h-4 text-brand-500" accent="fill-brand-500" />
          <span className="text-sm text-ink-500">Touchless Invoice Agent</span>
        </div>
        <p className="text-2xs text-ink-400 text-center sm:text-right">
          Built for TASC Outsourcing, United Arab Emirates · UAE VAT and TRN compliant
        </p>
      </div>
    </footer>
  );
}

/* ────────────────────────────── page ────────────────────────────── */

export function Landing() {
  return (
    <div className="min-h-screen">
      <LandingNav />
      <main>
        <Hero />
        <MetricsStrip />
        <PipelineSection />
        <CapabilitiesSection />
        <PersonasSection />
        <CtaBand />
      </main>
      <LandingFooter />
    </div>
  );
}

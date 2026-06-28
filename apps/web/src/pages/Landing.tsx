import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import {
  Inbox, ScanText, Users, ShieldCheck, ReceiptText, Send,
  Layers, MessageSquareText, BadgeCheck, Scale, Link2, Gauge,
  LayoutDashboard, Building2, LineChart, ArrowRight, ArrowUpRight, Check, ImagePlus,
  Mail, UploadCloud, Code2, MessagesSquare, FileSpreadsheet,
} from "lucide-react";
import { api } from "../api";
import { fmtPct, cn } from "../lib";
import { Logo } from "../components/Logo";
import { WhatsAppDemo } from "../components/WhatsAppDemo";

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

const CHANNELS: { icon: typeof Mail; label: string }[] = [
  { icon: MessagesSquare, label: "WhatsApp" },
  { icon: Mail, label: "Email" },
  { icon: UploadCloud, label: "Portal upload" },
  { icon: Code2, label: "REST API" },
];

/* ────────────────────────────── helpers ────────────────────────────── */

/** Fluid, full-width container — fills the viewport with gutters that scale. */
function Container({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-[1720px] px-5 sm:px-8 lg:px-12 xl:px-16 2xl:px-24", className)}>{children}</div>;
}

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
    <header className={cn("fixed inset-x-0 top-0 z-40 transition-colors duration-300", solid ? "bg-white/85 backdrop-blur-md border-b border-ink-200/70" : "border-b border-transparent")}>
      <Container className="h-16 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2.5">
          <Logo className="h-5 text-brand-500" accent="fill-brand-500" />
          <span className="hidden sm:block text-2xs text-ink-400 border-l border-ink-300 pl-2.5 leading-tight">
            Touchless<br />Invoice Agent
          </span>
        </Link>
        <nav className="hidden md:flex items-center gap-8 text-sm text-ink-600">
          <a href="#whatsapp" className="hover:text-ink-900 transition-colors">Live demo</a>
          <a href="#how" className="hover:text-ink-900 transition-colors">How it works</a>
          <a href="#capabilities" className="hover:text-ink-900 transition-colors">Capabilities</a>
          <a href="#personas" className="hover:text-ink-900 transition-colors">For your team</a>
        </nav>
        <Link to="/console" className="btn-primary btn-sm">
          Open console <ArrowRight size={14} />
        </Link>
      </Container>
    </header>
  );
}

/* ────────────────────────────── hero ────────────────────────────── */

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="absolute inset-0 hero-glow" aria-hidden />
      <div className="absolute inset-0 bg-dotgrid opacity-60" aria-hidden />
      <Container className="relative pt-28 pb-16 lg:pt-36 lg:pb-24">
        <div className="grid items-center gap-12 lg:gap-16 lg:grid-cols-[1.15fr_minmax(320px,400px)]">
          <div>
            <Reveal>
              <div className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50/70 px-3 py-1 text-2xs font-semibold text-brand-700">
                TASC Outsourcing
                <span className="h-1 w-1 rounded-full bg-brand-400" />
                United Arab Emirates
              </div>
            </Reveal>
            <Reveal delay={0.05}>
              <h1 className="mt-5 text-4xl sm:text-6xl xl:text-7xl font-semibold leading-[1.02] tracking-tight text-ink-900">
                Bill a timesheet<br />
                <span className="text-brand-gradient">from a chat.</span>
              </h1>
            </Reveal>
            <Reveal delay={0.1}>
              <p className="mt-6 text-base sm:text-lg text-ink-600 leading-relaxed max-w-2xl">
                Send TIA a timesheet over WhatsApp, email, or the portal. It extracts every line,
                matches people to contracts, checks your rules and UAE VAT, then sends back a
                compliant tax invoice you can question in plain language.
              </p>
            </Reveal>
            <Reveal delay={0.15}>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link to="/console" className="btn-primary px-5 py-2.5 text-sm">
                  Open the console <ArrowRight size={16} />
                </Link>
                <a href="#whatsapp" className="btn-outline px-5 py-2.5 text-sm">Try the live demo</a>
              </div>
            </Reveal>
            <Reveal delay={0.2}>
              <div className="mt-10">
                <div className="text-2xs font-semibold uppercase tracking-[0.09em] text-ink-400">Arrives on any channel</div>
                <div className="mt-3 flex flex-wrap gap-2.5">
                  {CHANNELS.map((c) => (
                    <span key={c.label} className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-xs font-medium text-ink-600 shadow-xs">
                      <c.icon size={14} className="text-brand-500" /> {c.label}
                    </span>
                  ))}
                </div>
              </div>
            </Reveal>
          </div>

          <Reveal delay={0.12}>
            <HeroFlow />
          </Reveal>
        </div>
      </Container>
    </section>
  );
}

/* The hero's signature visual: a live "timesheet in -> engine -> invoice out"
 * loop. One animated progress drives a scan over the raw sheet, an engine bar
 * stepping through the six stages, and a count-up invoice with a Touchless stamp. */
const FLOW = [
  { label: "Ingesting", icon: Inbox },
  { label: "Extracting", icon: ScanText },
  { label: "Resolving", icon: Users },
  { label: "Validating", icon: ShieldCheck },
  { label: "Invoicing", icon: ReceiptText },
  { label: "Dispatching", icon: Send },
];

function HeroFlow() {
  const reduce = useReducedMotion();
  const [p, setP] = useState(reduce ? 100 : 0);

  useEffect(() => {
    if (reduce) { setP(100); return; }
    let raf = 0; let start = 0;
    const DUR = 3600, HOLD = 1500;
    const loop = (ts: number) => {
      if (!start) start = ts;
      const e = ts - start;
      if (e <= DUR) setP((e / DUR) * 100);
      else if (e <= DUR + HOLD) setP(100);
      else { start = ts; setP(0); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [reduce]);

  const frac = p / 100;
  const active = Math.min(5, Math.floor(frac * 6));
  const stage = FLOW[active];
  const total = Math.round(48720 * Math.min(1, frac * 1.05));
  const totalStr = total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const billed = frac > 0.6;
  const dispatched = p >= 99;

  return (
    <div className="relative">
      <div className="absolute -inset-6 brand-band rounded-[2rem] opacity-[0.08] blur-2xl" aria-hidden />
      <div className="relative rounded-2xl border border-brand-200/80 bg-white shadow-lg overflow-hidden">
        {/* IN */}
        <div className="px-5 pt-4 pb-3">
          <div className="flex items-center justify-between">
            <div className="eyebrow">Timesheet in</div>
            <span className="text-2xs text-ink-400 font-mono">WhatsApp · CL001</span>
          </div>
          <div className="relative mt-2 overflow-hidden rounded-xl border border-ink-200 bg-ink-50/60 p-3">
            <div className="flex items-center gap-2.5">
              <span className="grid place-items-center h-8 w-8 rounded-lg bg-emerald-50 text-emerald-600 shrink-0"><FileSpreadsheet size={17} /></span>
              <span className="text-xs font-medium text-ink-600">Timesheet_June2026.xlsx</span>
            </div>
            <div className="mt-2.5 space-y-1.5">
              {[["Carlos Smith", "20 days"], ["Ahmed Khan", "20 days · 2 OT"]].map(([n, d]) => (
                <div key={n} className="flex items-center justify-between text-[13px]">
                  <span className="text-ink-700">{n}</span>
                  <span className="text-ink-400 tnum">{d}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ENGINE */}
        <div className="px-5 py-3 border-y border-ink-100 bg-ink-50/40">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <span className="grid place-items-center h-7 w-7 rounded-lg bg-brand-50 ring-1 ring-brand-100 text-brand-600 shrink-0">
                <stage.icon size={15} />
              </span>
              <span className="text-sm font-medium text-ink-800 truncate">{dispatched ? "Dispatched" : `${stage.label}…`}</span>
            </div>
            <span className="text-2xs font-semibold tnum text-brand-600">{Math.round(p)}%</span>
          </div>
          <div className="mt-2 h-1.5 rounded-full bg-ink-200/70 overflow-hidden">
            <div className="h-full rounded-full brand-band" style={{ width: `${p}%`, transition: "width 80ms linear" }} />
          </div>
        </div>

        {/* OUT */}
        <div className="px-5 pt-3.5 pb-4">
          <div className="flex items-center justify-between">
            <div className="eyebrow">Tax invoice out</div>
            <span
              className="inline-flex items-center gap-1 rounded-full bg-emerald-50 text-emerald-700 px-2 py-0.5 text-2xs font-semibold transition-all duration-500"
              style={{ opacity: dispatched ? 1 : 0, transform: dispatched ? "rotate(-3deg) scale(1)" : "scale(0.9)" }}
            >
              <Check size={11} /> Touchless
            </span>
          </div>
          <div className="mt-1 flex items-end justify-between gap-3">
            <div className="min-w-0">
              <div className="font-semibold text-ink-900 truncate">Emirates Steel Industries LLC</div>
              <div className="text-2xs text-ink-400 font-mono">June 2026 · TRN 100312345600003</div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-xl font-semibold tnum text-ink-900">AED {totalStr}</div>
              <div className="text-2xs text-ink-400">incl. 5% VAT</div>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-1.5 text-2xs text-ink-500" style={{ opacity: billed ? 1 : 0.35, transition: "opacity 300ms" }}>
            <ShieldCheck size={12} className="text-brand-500" /> R1 to R15 passed
            <span className="ml-auto font-mono">SAC 998515</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────── whatsapp ────────────────────────────── */

const WA_FEATURES: { icon: typeof ImagePlus; title: string; body: string }[] = [
  { icon: ImagePlus, title: "Send anything", body: "A photo of a signed sheet, an Excel export, or just type the days into a message." },
  { icon: ReceiptText, title: "Get the invoice back", body: "A compliant tax invoice in seconds, validated against the contract and UAE VAT." },
  { icon: MessageSquareText, title: "Ask in plain language", body: "Question the VAT, the total, or any line. Answers are read straight from the record." },
  { icon: BadgeCheck, title: "Approve in the thread", body: "Reply to approve or raise a query. Every step is written to the audit chain." },
];

function WhatsAppSection() {
  return (
    <section id="whatsapp" className="relative scroll-mt-20 bg-dotgrid">
      <Container className="py-20 lg:py-28">
        <div className="grid items-center gap-12 lg:gap-20 lg:grid-cols-[1fr_minmax(320px,380px)]">
          <div>
            <Reveal>
              <div className="inline-flex items-center gap-1.5 rounded-full bg-[#25D366]/10 text-[#0f7a43] px-3 py-1 text-2xs font-semibold">
                <MessagesSquare size={13} /> On WhatsApp
              </div>
              <h2 className="mt-4 text-3xl sm:text-4xl xl:text-5xl font-semibold tracking-tight text-ink-900 max-w-2xl leading-[1.05]">
                Bill straight from a WhatsApp chat.
              </h2>
              <p className="mt-4 text-base sm:text-lg text-ink-600 leading-relaxed max-w-2xl">
                No app to learn and no portal to open. A site manager forwards the timesheet to
                TIA's number, and the invoice comes back in the same thread, ready to question or
                approve.
              </p>
            </Reveal>
            <div className="mt-10 grid sm:grid-cols-2 gap-x-8 gap-y-7">
              {WA_FEATURES.map((f, i) => (
                <Reveal key={f.title} delay={(i % 2) * 0.06}>
                  <div className="flex gap-3.5">
                    <span className="grid place-items-center h-10 w-10 rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100 shrink-0">
                      <f.icon size={18} strokeWidth={2} />
                    </span>
                    <div>
                      <h3 className="text-base font-semibold text-ink-900">{f.title}</h3>
                      <p className="mt-0.5 text-sm text-ink-500 leading-relaxed">{f.body}</p>
                    </div>
                  </div>
                </Reveal>
              ))}
            </div>
            <Reveal delay={0.1}>
              <p className="mt-9 text-2xs text-ink-400 max-w-xl">
                Powered by the WhatsApp Cloud API. The conversation on the right plays automatically
                and runs against the live TIA pipeline; names are demo data.
              </p>
            </Reveal>
          </div>

          <Reveal delay={0.12}>
            <WhatsAppDemo />
          </Reveal>
        </div>
      </Container>
    </section>
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
      <Container className="py-8 grid grid-cols-2 lg:grid-cols-4 gap-y-6 gap-x-4">
        {items.map((it, i) => (
          <Reveal key={it.v} delay={i * 0.05}>
            <div className="text-center lg:text-left">
              <div className="text-2xl sm:text-3xl font-semibold tnum tracking-tight text-ink-900">{it.k}</div>
              <div className="mt-1 text-sm font-medium text-ink-700">{it.v}</div>
              <div className="text-2xs text-ink-400">{it.note}</div>
            </div>
          </Reveal>
        ))}
      </Container>
    </section>
  );
}

/* ────────────────────────────── pipeline ────────────────────────────── */

function PipelineSection() {
  return (
    <section id="how" className="relative scroll-mt-20">
      <Container className="py-20 lg:py-28">
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
              <div className="group h-full bg-white p-6 lg:p-8 transition-colors hover:bg-brand-50/40">
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
      </Container>
    </section>
  );
}

/* ────────────────────────────── capabilities ────────────────────────────── */

function CapabilitiesSection() {
  return (
    <section id="capabilities" className="relative scroll-mt-20 bg-dotgrid">
      <Container className="py-20 lg:py-28">
        <Reveal>
          <Eyebrow>Capabilities</Eyebrow>
          <h2 className="mt-2 text-3xl sm:text-4xl font-semibold tracking-tight text-ink-900 max-w-2xl">
            Built for real staffing operations, not a happy-path demo.
          </h2>
        </Reveal>
        <div className="mt-12 grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURES.map((f, i) => (
            <Reveal key={f.title} delay={(i % 3) * 0.06}>
              <div className="h-full rounded-2xl border border-ink-200 bg-white p-6 lg:p-7 shadow-xs hover:shadow-md hover:-translate-y-0.5 transition-all duration-200">
                <span className="grid place-items-center h-10 w-10 rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100">
                  <f.icon size={19} strokeWidth={2} />
                </span>
                <h3 className="mt-4 text-base font-semibold text-ink-900">{f.title}</h3>
                <p className="mt-1.5 text-sm text-ink-500 leading-relaxed">{f.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </Container>
    </section>
  );
}

/* ────────────────────────────── personas ────────────────────────────── */

function PersonasSection() {
  return (
    <section id="personas" className="relative scroll-mt-20">
      <Container className="py-20 lg:py-28">
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
                className="group flex h-full flex-col rounded-2xl border border-ink-200 bg-white p-6 lg:p-7 shadow-xs hover:border-brand-300 hover:shadow-md transition-all duration-200"
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
      </Container>
    </section>
  );
}

/* ────────────────────────────── cta + footer ────────────────────────────── */

function CtaBand() {
  return (
    <Container className="pb-20 lg:pb-28">
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
    </Container>
  );
}

function LandingFooter() {
  return (
    <footer className="border-t border-ink-200">
      <Container className="py-10 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <Logo className="h-4 text-brand-500" accent="fill-brand-500" />
          <span className="text-sm text-ink-500">Touchless Invoice Agent</span>
        </div>
        <p className="text-2xs text-ink-400 text-center sm:text-right">
          Built for TASC Outsourcing, United Arab Emirates · UAE VAT and TRN compliant
        </p>
      </Container>
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
        <WhatsAppSection />
        <PipelineSection />
        <CapabilitiesSection />
        <PersonasSection />
        <CtaBand />
      </main>
      <LandingFooter />
    </div>
  );
}

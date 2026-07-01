import { useEffect, useRef, useState } from "react";
import { useInView } from "framer-motion";
import {
  ChevronLeft, Video, Phone, Plus, Camera, Mic, Send, Lock,
  CheckCheck, FileSpreadsheet, FileText, Wifi, SignalHigh, BatteryFull, RotateCw,
} from "lucide-react";
import { api } from "../api";
import { fmtAED } from "../lib";
import { Logo } from "./Logo";

type Bubble =
  | { id: number; from: "me" | "tia"; kind: "text"; text: string; t: string }
  | { id: number; from: "me" | "tia"; kind: "doc"; name: string; meta: string; variant: "sheet" | "invoice"; t: string };

type Draft =
  | { from: "me" | "tia"; kind: "text"; text: string }
  | { from: "me" | "tia"; kind: "doc"; name: string; meta: string; variant: "sheet" | "invoice" };

type Inv = { id?: string; total: number; client: string; period: string; seq: string };

const SAMPLE_BODY =
  "Client: Emirates Steel Industries LLC (CL001)\nPeriod: June 2026\n\nEMP10001 Carlos Smith - 20 days\nEMP10002 Ahmed Khan - 20 days, 2 OT hours\n\nApproved by: Site Manager";

const QUESTIONS = ["What's the VAT on this?", "Why is the total what it is?", "Has it been sent to Finance?"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clock = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }).replace(/^0/, "");
let _id = 0;
const nextId = () => ++_id;

const GREETING = "Send me a timesheet and I'll bill it. A photo, an Excel, or just type the days.";

export function WhatsAppDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-120px" });
  const started = useRef(false);

  const [msgs, setMsgs] = useState<Bubble[]>([{ id: nextId(), from: "tia", kind: "text", text: GREETING, t: clock() }]);
  const [status, setStatus] = useState<"online" | "typing">("online");
  const [composer, setComposer] = useState("");
  const [done, setDone] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, status, composer]);

  const push = (b: Draft) => setMsgs((m) => [...m, { ...b, id: nextId(), t: clock() } as Bubble]);

  const typeOut = async (text: string) => {
    for (let i = 1; i <= text.length; i++) { setComposer(text.slice(0, i)); await sleep(28); }
    await sleep(280);
    setComposer("");
  };

  const bill = async (): Promise<Inv> => {
    const fallback: Inv = { total: 48720, client: "Emirates Steel Industries LLC", period: "June 2026", seq: "TIA-INV-2026-0001" };
    try {
      const sub = await api.submitEmail(SAMPLE_BODY, "CL001 June 2026 timesheet");
      for (let i = 0; i < 9; i++) {
        await sleep(1100);
        try {
          const doc = await api.getDoc(sub.doc_id);
          const x = doc.invoices?.[0];
          if (x) return { id: x.id, total: x.total_incl_vat ?? x.amount, seq: x.invoice_sequence_no ?? "TIA-INV", client: "Emirates Steel Industries LLC", period: x.period ?? "June 2026" };
        } catch { /* keep polling */ }
      }
    } catch { /* offline */ }
    return fallback;
  };

  const canned = (q: string, inv: Inv) => {
    const n = q.toLowerCase();
    const net = Math.round((inv.total / 1.05) * 100) / 100;
    if (n.includes("vat")) return `VAT is ${fmtAED(Math.round(net * 0.05 * 100) / 100)} at the UAE standard 5%, on a net of ${fmtAED(net)}.`;
    if (n.includes("total") || n.includes("why")) return `${fmtAED(inv.total)} incl. VAT: 20 days for Carlos Smith plus 20 days and 2 OT hours for Ahmed Khan, priced on the CL001 rate card.`;
    /* v8 ignore start -- canned() is only invoked with the three fixed QUESTIONS ("…sent to Finance?" matches on `sent`), so the finance/dispatch operands and the generic default are unreachable */
    if (n.includes("sent") || n.includes("finance") || n.includes("dispatch")) return "Yes, dispatched to Finance right after validation passed, with a full audit trail.";
    return `It's invoice ${inv.seq} for ${inv.client}, ${inv.period}, totalling ${fmtAED(inv.total)} incl. VAT.`;
    /* v8 ignore stop */
  };

  const answer = async (q: string, inv: Inv) => {
    try {
      if (inv.id) {
        const r = await api.qa(q, { kind: "invoice", id: inv.id });
        const bad = /not configured|OPENAI_API_KEY|no evidence|missing/i.test(r.answer);
        return bad ? canned(q, inv) : r.answer;
      }
    } catch { /* fall through */ }
    return canned(q, inv);
  };

  const play = async () => {
    await sleep(900);
    setComposer("June timesheet for Emirates Steel");
    await sleep(700);
    setComposer("");
    push({ from: "me", kind: "doc", name: "Timesheet_June2026.xlsx", meta: "2 associates · CL001", variant: "sheet" });
    push({ from: "me", kind: "text", text: "June timesheet for Emirates Steel" });
    await sleep(500);
    setStatus("typing");

    const inv = await bill();
    setStatus("online");
    push({ from: "tia", kind: "text", text: "Read it, matched both associates to the CL001 contract, and ran R1 to R15. All clear." });
    await sleep(450);
    push({ from: "tia", kind: "doc", name: `Invoice_${inv.seq}.pdf`, meta: `${fmtAED(inv.total)} · incl. 5% VAT`, variant: "invoice" });
    await sleep(450);
    push({ from: "tia", kind: "text", text: "Dispatched to Finance. Ask me anything about it." });

    for (const q of QUESTIONS) {
      await sleep(1400);
      await typeOut(q);
      push({ from: "me", kind: "text", text: q });
      await sleep(500);
      setStatus("typing");
      const a = await answer(q, inv);
      await sleep(700);
      setStatus("online");
      push({ from: "tia", kind: "text", text: a });
    }
    setDone(true);
  };

  useEffect(() => {
    if (inView && !started.current) { started.current = true; play(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inView]);

  const replay = () => {
    _id = 0;
    started.current = true;
    setDone(false);
    setStatus("online");
    setComposer("");
    setMsgs([{ id: nextId(), from: "tia", kind: "text", text: GREETING, t: clock() }]);
    setTimeout(play, 300);
  };

  return (
    <div ref={ref} className="flex flex-col items-center">
      <Iphone status={status} composer={composer} done={done} onReplay={replay} scrollRef={scrollRef} msgs={msgs} />
    </div>
  );
}

/* ─────────────────────────── presentation ─────────────────────────── */

function Iphone({
  msgs, status, composer, done, onReplay, scrollRef,
}: {
  msgs: Bubble[]; status: "online" | "typing"; composer: string; done: boolean;
  onReplay: () => void; scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="relative mx-auto w-full max-w-[342px]">
      {/* side buttons */}
      <div className="absolute -left-[3px] top-[120px] h-9 w-[3px] rounded-l bg-[#0c0c0d]" />
      <div className="absolute -left-[3px] top-[168px] h-14 w-[3px] rounded-l bg-[#0c0c0d]" />
      <div className="absolute -left-[3px] top-[236px] h-14 w-[3px] rounded-l bg-[#0c0c0d]" />
      <div className="absolute -right-[3px] top-[196px] h-20 w-[3px] rounded-r bg-[#0c0c0d]" />

      {/* titanium frame */}
      <div className="rounded-[3.3rem] bg-gradient-to-b from-[#42454a] via-[#27292c] to-[#1a1b1d] p-[3px] shadow-[0_50px_100px_-30px_rgba(15,23,42,0.6)]">
        <div className="rounded-[3.15rem] bg-[#0a0a0b] p-[10px]">
          <div className="relative overflow-hidden rounded-[2.5rem] bg-[#d9d2c8]" style={{ height: 640 }}>
            {/* Dynamic Island */}
            <div className="absolute top-[11px] left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 h-[27px] w-[96px] rounded-full bg-black">
              <span className="ml-auto mr-2.5 h-2 w-2 rounded-full bg-[#1c1c2b] ring-1 ring-[#2b2b3a]" />
            </div>

            {/* Header */}
            <div className="relative z-20 bg-[#f6f6f6]/95 backdrop-blur">
              <div className="flex items-center justify-between px-6 pt-2.5 pb-0.5 text-[12.5px] font-semibold text-ink-900">
                <span className="tnum">9:41</span>
                <span className="flex items-center gap-1.5"><SignalHigh size={15} /><Wifi size={15} /><BatteryFull size={18} /></span>
              </div>
              <div className="flex items-center gap-2 px-2.5 pb-2 pt-1 border-b border-black/10">
                <button className="flex items-center text-[#128C7E] shrink-0"><ChevronLeft size={24} /></button>
                <span className="grid place-items-center h-9 w-9 rounded-full bg-brand-50 ring-1 ring-brand-100 shrink-0">
                  <Logo className="h-2.5 text-brand-500" accent="fill-brand-500" />
                </span>
                <div className="min-w-0 leading-tight">
                  <div className="text-[15px] font-semibold text-ink-900 truncate">TIA</div>
                  <div className="text-[11px] text-ink-400 truncate">{status === "typing" ? "typing…" : "online"}</div>
                </div>
                <div className="ml-auto flex items-center gap-5 text-[#128C7E] pr-1.5">
                  <Video size={20} /><Phone size={18} />
                </div>
              </div>
            </div>

            {/* Chat */}
            <div
              ref={scrollRef}
              className="absolute inset-x-0 overflow-y-auto px-2.5 py-2.5 space-y-1.5"
              style={{ top: 96, bottom: 60, scrollbarWidth: "none", backgroundColor: "#d9d2c8", backgroundImage: WALLPAPER }}
            >
              <div className="mx-auto my-1.5 w-fit rounded-md bg-[#fbf4d4] px-2.5 py-1 text-[10.5px] text-[#8a7f55] shadow-xs flex items-center gap-1 text-center max-w-[78%]">
                <Lock size={10} className="shrink-0" /> Messages are end-to-end encrypted.
              </div>
              <div className="mx-auto mb-1 w-fit rounded-md bg-[#cfdceb] px-2.5 py-0.5 text-[10px] font-medium text-[#5b6b7e] shadow-xs">Today</div>
              {msgs.map((m) => <ChatBubble key={m.id} b={m} />)}
            </div>

            {/* Composer */}
            <div className="absolute inset-x-0 bottom-0 z-20 bg-[#f6f6f6]/95 backdrop-blur border-t border-black/10 px-2 py-2">
              <div className="flex items-center gap-2">
                <Plus size={22} className="text-[#128C7E] shrink-0" />
                <div className="flex-1 flex items-center gap-2 rounded-full bg-white border border-black/10 px-3.5 py-2 min-w-0">
                  <span className={`flex-1 min-w-0 truncate text-[13px] ${composer ? "text-ink-900" : "text-ink-400"}`}>
                    {composer || "Message"}{composer && <span className="inline-block w-px h-3.5 align-middle bg-[#25D366] ml-px animate-pulse" />}
                  </span>
                  <Camera size={18} className="text-[#128C7E] shrink-0" />
                </div>
                <button className="grid place-items-center h-9 w-9 rounded-full bg-[#25D366] text-white shrink-0 shadow-sm">
                  {composer ? <Send size={16} /> : <Mic size={18} />}
                </button>
              </div>
            </div>

            <div className="absolute bottom-[6px] left-1/2 -translate-x-1/2 h-[5px] w-[124px] rounded-full bg-black/30 z-30" />
          </div>
        </div>
      </div>

      {done && (
        <button onClick={onReplay} className="mx-auto mt-4 flex items-center gap-1.5 rounded-full border border-ink-200 bg-white px-3.5 py-1.5 text-xs font-medium text-ink-600 hover:border-brand-300 hover:text-brand-700 shadow-xs transition-colors">
          <RotateCw size={13} /> Replay
        </button>
      )}
    </div>
  );
}

function ChatBubble({ b }: { b: Bubble }) {
  const mine = b.from === "me";
  const base = mine ? "ml-auto bg-[#d9fdd3] rounded-2xl rounded-tr-md" : "mr-auto bg-white rounded-2xl rounded-tl-md";
  return (
    <div className={`relative max-w-[80%] w-fit px-2.5 py-1.5 shadow-[0_1px_0.5px_rgba(0,0,0,0.15)] ${base}`}>
      {b.kind === "text" ? (
        <p className="text-[13px] leading-[1.35] text-ink-900 whitespace-pre-wrap pr-9">{b.text}</p>
      ) : (
        <div className="flex items-center gap-2.5 py-0.5 pr-9">
          <span className={`grid place-items-center h-10 w-10 rounded-lg ${b.variant === "invoice" ? "bg-brand-50 text-brand-600" : "bg-emerald-50 text-emerald-600"}`}>
            {b.variant === "invoice" ? <FileText size={19} /> : <FileSpreadsheet size={19} />}
          </span>
          <div className="min-w-0">
            <div className="text-[12.5px] font-medium text-ink-900 truncate max-w-[150px]">{b.name}</div>
            <div className="text-[10.5px] text-ink-400 truncate max-w-[150px]">{b.meta}</div>
          </div>
        </div>
      )}
      <span className="absolute bottom-1 right-2 flex items-center gap-0.5">
        <span className="text-[9.5px] text-ink-400 tnum">{b.t}</span>
        {mine && <CheckCheck size={13} className="text-[#34b7f1]" />}
      </span>
    </div>
  );
}

// Faint WhatsApp-style doodle texture over the beige wallpaper.
const WALLPAPER =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='84' height='84' viewBox='0 0 84 84'%3E%3Cg fill='none' stroke='%23b9b09f' stroke-opacity='0.18' stroke-width='1.4'%3E%3Cpath d='M12 16h10M14 13l-2 3 2 3'/%3E%3Ccircle cx='62' cy='20' r='5'/%3E%3Cpath d='M58 58c0 3 2 5 5 5s5-2 5-5-2-5-5-5'/%3E%3Cpath d='M22 64l3-6 3 6'/%3E%3C/g%3E%3C/svg%3E\")";

import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft, Video, Phone, Plus, Camera, Mic, Send,
  CheckCheck, FileSpreadsheet, FileText, Wifi, SignalHigh, BatteryFull,
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

const SAMPLE_BODY =
  "Client: Emirates Steel Industries LLC (CL001)\nPeriod: June 2026\n\nEMP10001 Carlos Smith - 20 days\nEMP10002 Ahmed Khan - 20 days, 2 OT hours\n\nApproved by: Site Manager";

const QUICK = ["What's the VAT?", "Why this total?", "When was it sent?"];

function clock() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }).replace(/^0/, "");
}

let _id = 0;
const nextId = () => ++_id;

/**
 * A precise iOS WhatsApp chat in an iPhone frame, wired to the live backend:
 * tap to "send" a timesheet -> TIA bills it and replies with the invoice ->
 * chat about that invoice (grounded /qa, with a canned fallback if offline).
 */
export function WhatsAppDemo() {
  const [msgs, setMsgs] = useState<Bubble[]>([
    { id: nextId(), from: "tia", kind: "text", text: "Send me a timesheet and I'll bill it. A photo, an Excel, or just type the days.", t: clock() },
  ]);
  const [phase, setPhase] = useState<"intro" | "billing" | "ready">("intro");
  const [typing, setTyping] = useState(false);
  const [input, setInput] = useState("");
  const [invoice, setInvoice] = useState<{ id?: string; total: number; client: string; period: string; seq: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, typing]);

  const push = (b: Draft) =>
    setMsgs((m) => [...m, { ...b, id: nextId(), t: clock() } as Bubble]);

  const sendTimesheet = async () => {
    if (phase !== "intro") return;
    setPhase("billing");
    push({ from: "me", kind: "doc", name: "Timesheet_June2026.xlsx", meta: "2 associates · CL001", variant: "sheet" });
    push({ from: "me", kind: "text", text: "June timesheet for Emirates Steel" });
    setTyping(true);

    const fallback = { total: 48720, client: "Emirates Steel Industries LLC", period: "June 2026", seq: "TIA-INV-2026-0001" };
    try {
      const sub = await api.submitEmail(SAMPLE_BODY, "CL001 June 2026 timesheet");
      let inv = null as null | { id: string; total: number; seq: string; client: string; period: string };
      for (let i = 0; i < 10 && !inv; i++) {
        await new Promise((r) => setTimeout(r, 1200));
        try {
          const doc = await api.getDoc(sub.doc_id);
          const x = doc.invoices?.[0];
          if (x) inv = {
            id: x.id,
            total: x.total_incl_vat ?? x.amount,
            seq: x.invoice_sequence_no ?? "TIA-INV",
            client: "Emirates Steel Industries LLC",
            period: x.period ?? "June 2026",
          };
        } catch { /* keep polling */ }
      }
      finishBilling(inv ?? fallback);
    } catch {
      finishBilling(fallback);
    }
  };

  const finishBilling = (inv: { id?: string; total: number; client: string; period: string; seq: string }) => {
    setInvoice(inv);
    setTyping(false);
    push({ from: "tia", kind: "text", text: "Read it, matched both associates to the CL001 contract, and ran R1 to R15. All clear." });
    push({ from: "tia", kind: "doc", name: `Invoice_${inv.seq}.pdf`, meta: `${fmtAED(inv.total)} · incl. 5% VAT`, variant: "invoice" });
    push({ from: "tia", kind: "text", text: "Dispatched to Finance. Ask me anything about it." });
    setPhase("ready");
  };

  const cannedAnswer = (q: string, inv: NonNullable<typeof invoice>) => {
    const n = q.toLowerCase();
    if (n.includes("vat")) return `VAT is ${fmtAED(Math.round((inv.total / 1.05) * 0.05 * 100) / 100)} at the UAE standard 5%, on a net of ${fmtAED(Math.round((inv.total / 1.05) * 100) / 100)}.`;
    if (n.includes("total") || n.includes("amount") || n.includes("why")) return `${fmtAED(inv.total)} incl. VAT: 20 days for Carlos Smith plus 20 days and 2 OT hours for Ahmed Khan, priced on the CL001 rate card.`;
    if (n.includes("sent") || n.includes("when") || n.includes("dispatch")) return `Just now, straight after validation passed. It went to Finance with a full audit trail.`;
    return `It's invoice ${inv.seq} for ${inv.client}, ${inv.period}, totalling ${fmtAED(inv.total)} incl. VAT.`;
  };

  const ask = async (q: string) => {
    const question = q.trim();
    if (!question || phase !== "ready" || typing) return;
    setInput("");
    push({ from: "me", kind: "text", text: question });
    setTyping(true);
    try {
      if (invoice?.id) {
        const r = await api.qa(question, { kind: "invoice", id: invoice.id });
        const bad = /not configured|OPENAI_API_KEY|no evidence|missing/i.test(r.answer);
        push({ from: "tia", kind: "text", text: bad && invoice ? cannedAnswer(question, invoice) : r.answer });
      } else if (invoice) {
        push({ from: "tia", kind: "text", text: cannedAnswer(question, invoice) });
      }
    } catch {
      if (invoice) push({ from: "tia", kind: "text", text: cannedAnswer(question, invoice) });
    } finally {
      setTyping(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[330px] select-none">
      {/* iPhone */}
      <div className="relative rounded-[3rem] bg-[#1b1b1d] p-[11px] shadow-[0_40px_90px_-30px_rgba(15,23,42,0.55)] ring-1 ring-black/20">
        <div className="relative overflow-hidden rounded-[2.4rem] bg-[#ECE5DD]" style={{ height: 624 }}>
          {/* Dynamic Island */}
          <div className="absolute top-[12px] left-1/2 -translate-x-1/2 z-30 h-[26px] w-[92px] rounded-full bg-black" />

          {/* Header (status bar + contact) */}
          <div className="relative z-20 bg-[#f6f6f6]/95 backdrop-blur border-b border-black/10">
            <div className="flex items-center justify-between px-5 pt-2.5 pb-1 text-[12px] font-semibold text-ink-900">
              <span className="tnum">9:41</span>
              <span className="flex items-center gap-1">
                <SignalHigh size={14} /><Wifi size={14} /><BatteryFull size={16} />
              </span>
            </div>
            <div className="flex items-center gap-2 px-3 pb-2">
              <ChevronLeft size={22} className="text-[#1e88e5] shrink-0" />
              <span className="grid place-items-center h-8 w-8 rounded-full bg-brand-50 ring-1 ring-brand-100 shrink-0">
                <Logo className="h-2.5 text-brand-500" accent="fill-brand-500" />
              </span>
              <div className="min-w-0 leading-tight">
                <div className="text-[14px] font-semibold text-ink-900 truncate">TIA</div>
                <div className="text-[11px] text-ink-400 truncate">{typing ? "typing…" : "online"}</div>
              </div>
              <div className="ml-auto flex items-center gap-4 text-[#25D366]">
                <Video size={19} /><Phone size={17} />
              </div>
            </div>
          </div>

          {/* Chat */}
          <div
            ref={scrollRef}
            className="absolute inset-x-0 bottom-[58px] overflow-y-auto px-2.5 py-3 space-y-1.5"
            style={{ top: 92, backgroundColor: "#ECE5DD", scrollbarWidth: "none" }}
          >
            <div className="mx-auto mb-2 w-fit rounded-md bg-[#d6e6f5] px-2 py-0.5 text-[10px] text-ink-500 shadow-xs">
              Today
            </div>
            {msgs.map((m) => <ChatBubble key={m.id} b={m} />)}
          </div>

          {/* Composer */}
          <div className="absolute inset-x-0 bottom-0 z-20 bg-[#f6f6f6]/95 backdrop-blur border-t border-black/10 px-2 py-1.5">
            {phase === "ready" && (
              <div className="flex gap-1.5 overflow-x-auto pb-1.5 mb-0.5" style={{ scrollbarWidth: "none" }}>
                {QUICK.map((q) => (
                  <button key={q} onClick={() => ask(q)} className="shrink-0 rounded-full border border-[#25D366]/40 bg-white px-2.5 py-1 text-[11px] text-ink-700 hover:bg-[#25D366]/10 transition-colors">
                    {q}
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <Plus size={20} className="text-ink-400 shrink-0" />
              <div className="flex-1 flex items-center gap-1.5 rounded-full bg-white border border-black/10 px-3 py-1.5">
                {phase === "intro" ? (
                  <button onClick={sendTimesheet} className="flex-1 text-left text-[12.5px] text-[#25D366] font-medium">
                    Tap to send June timesheet
                  </button>
                ) : (
                  <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") ask(input); }}
                    disabled={phase !== "ready"}
                    placeholder={phase === "billing" ? "TIA is billing…" : "Message"}
                    className="flex-1 min-w-0 bg-transparent text-[13px] text-ink-900 placeholder:text-ink-400 focus:outline-none"
                  />
                )}
                <Camera size={17} className="text-ink-400 shrink-0" />
              </div>
              <button
                onClick={() => (phase === "intro" ? sendTimesheet() : ask(input))}
                className="grid place-items-center h-9 w-9 rounded-full bg-[#25D366] text-white shrink-0 shadow-sm active:scale-95 transition-transform"
                aria-label="Send"
              >
                {phase === "intro" || input.trim() ? <Send size={16} /> : <Mic size={17} />}
              </button>
            </div>
          </div>
        </div>
        {/* home indicator */}
        <div className="absolute bottom-[6px] left-1/2 -translate-x-1/2 h-[5px] w-[120px] rounded-full bg-white/70" />
      </div>
    </div>
  );
}

function ChatBubble({ b }: { b: Bubble }) {
  const mine = b.from === "me";
  const base = mine
    ? "ml-auto bg-[#d9fdd3] rounded-2xl rounded-tr-sm"
    : "mr-auto bg-white rounded-2xl rounded-tl-sm";
  return (
    <div className={`max-w-[82%] w-fit px-2.5 py-1.5 shadow-[0_1px_0.5px_rgba(0,0,0,0.13)] ${base}`}>
      {b.kind === "text" ? (
        <p className="text-[13px] leading-snug text-ink-900 whitespace-pre-wrap">{b.text}</p>
      ) : (
        <div className="flex items-center gap-2.5 py-0.5">
          <span className={`grid place-items-center h-9 w-9 rounded-lg ${b.variant === "invoice" ? "bg-brand-50 text-brand-600" : "bg-emerald-50 text-emerald-600"}`}>
            {b.variant === "invoice" ? <FileText size={18} /> : <FileSpreadsheet size={18} />}
          </span>
          <div className="min-w-0 pr-1">
            <div className="text-[12.5px] font-medium text-ink-900 truncate max-w-[150px]">{b.name}</div>
            <div className="text-[10.5px] text-ink-400 truncate max-w-[150px]">{b.meta}</div>
          </div>
        </div>
      )}
      <div className={`flex items-center gap-1 ${mine ? "justify-end" : "justify-start"} -mb-0.5`}>
        <span className="text-[9.5px] text-ink-400 tnum">{b.t}</span>
        {mine && <CheckCheck size={13} className="text-[#53bdeb]" />}
      </div>
    </div>
  );
}

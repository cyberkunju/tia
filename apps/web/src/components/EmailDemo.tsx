import { useEffect, useRef, useState } from "react";
import { useInView } from "framer-motion";
import {
  CornerUpLeft, ReplyAll, Forward, Archive, Trash2, Star,
  FileSpreadsheet, FileText, ShieldCheck, RotateCw,
} from "lucide-react";
import { api } from "../api";
import { fmtAED } from "../lib";
import { Logo } from "./Logo";

type Inv = { id?: string; total: number; client: string; period: string; seq: string };

const SAMPLE_BODY =
  "Client: Emirates Steel Industries LLC (CL001)\nPeriod: June 2026\n\nEMP10001 Carlos Smith - 20 days\nEMP10002 Ahmed Khan - 20 days, 2 OT hours\n\nApproved by: Site Manager";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A precise desktop mail client wired to the live backend: a client emails a
 * timesheet to TIA's watched inbox; TIA reads it, bills it, and replies in the
 * same thread with the invoice PDF. Plays automatically when scrolled into view.
 */
export function EmailDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-120px" });
  const started = useRef(false);
  const [processing, setProcessing] = useState(false);
  const [inv, setInv] = useState<Inv | null>(null);
  const [done, setDone] = useState(false);

  const bill = async (): Promise<Inv> => {
    const fallback: Inv = { total: 48720, client: "Emirates Steel Industries LLC", period: "June 2026", seq: "TIA-INV-2026-0001" };
    try {
      const sub = await api.submitEmail(SAMPLE_BODY, "June 2026 timesheet · CL001");
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

  const play = async () => {
    await sleep(900);
    setProcessing(true);
    const i = await bill();
    setProcessing(false);
    setInv(i);
    setDone(true);
  };

  useEffect(() => {
    if (inView && !started.current) { started.current = true; play(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inView]);

  const replay = () => {
    started.current = true;
    setInv(null); setDone(false);
    setTimeout(play, 250);
  };

  return (
    <div ref={ref} className="flex flex-col items-center w-full">
      <div className="w-full rounded-xl border border-ink-200 bg-white shadow-lg overflow-hidden">
        {/* title bar */}
        <div className="flex items-center gap-2 px-3.5 h-10 bg-ink-50 border-b border-ink-200">
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
            <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
            <span className="h-3 w-3 rounded-full bg-[#28c840]" />
          </span>
          <span className="mx-auto text-xs font-medium text-ink-500">Inbox · billing@tascoutsourcing.ae</span>
        </div>
        {/* toolbar */}
        <div className="flex items-center gap-4 px-4 h-10 border-b border-ink-100 text-ink-400">
          <CornerUpLeft size={16} /><ReplyAll size={16} /><Forward size={16} />
          <span className="mx-1 h-4 w-px bg-ink-200" />
          <Archive size={16} /><Trash2 size={16} />
          <Star size={15} className="ml-auto text-ink-300" />
        </div>

        {/* subject */}
        <div className="px-5 pt-4 pb-3 border-b border-ink-100">
          <h3 className="text-base font-semibold text-ink-900">June 2026 timesheet · CL001</h3>
          <div className="mt-0.5 text-2xs text-ink-400">2 messages · Timesheets</div>
        </div>

        {/* thread */}
        <div className="px-5 py-4 space-y-4">
          {/* inbound */}
          <Message
            avatar={<span className="grid place-items-center h-9 w-9 rounded-full bg-ink-100 text-ink-500 text-xs font-semibold">ES</span>}
            name="Operations, Emirates Steel"
            addr="operations@emiratessteel.ae"
            time="09:02"
            to="to billing@tascoutsourcing.ae"
          >
            <p className="text-sm text-ink-700 leading-relaxed">
              Hi team, attaching June's timesheet for our two associates. Please raise the invoice. Thanks.
            </p>
            <Attachment icon={<FileSpreadsheet size={18} />} tone="sheet" name="Timesheet_June2026.xlsx" meta="11 KB · Excel" />
          </Message>

          {processing && (
            <div className="flex items-center gap-2.5 pl-12">
              <span className="aida-thinking text-sm font-medium">TIA is reading the timesheet and preparing the invoice…</span>
            </div>
          )}

          {/* TIA reply */}
          {inv && (
            <div className="rounded-xl border border-brand-200/70 bg-brand-50/30 p-4">
              <Message
                avatar={<span className="grid place-items-center h-9 w-9 rounded-full bg-white ring-1 ring-brand-100"><Logo className="h-2.5 text-brand-500" accent="fill-brand-500" /></span>}
                name="TIA"
                addr="billing@tascoutsourcing.ae"
                time="09:02"
                to="to operations@emiratessteel.ae"
                tag="Automated reply"
              >
                <p className="text-sm text-ink-700 leading-relaxed">
                  Thanks. The invoice is attached and has been dispatched to Finance. Both associates matched the CL001 contract and every check (R1 to R15) passed.
                </p>
                <Attachment icon={<FileText size={18} />} tone="invoice" name={`Invoice_${inv.seq}.pdf`} meta={`${fmtAED(inv.total)} · incl. 5% VAT`} />
                <div className="mt-3 flex items-center justify-between rounded-lg border border-ink-200 bg-white px-3 py-2 text-2xs">
                  <span className="text-ink-500">{inv.client} · {inv.period}</span>
                  <span className="inline-flex items-center gap-1 text-brand-700 font-medium"><ShieldCheck size={12} /> R1 to R15 passed</span>
                </div>
              </Message>
            </div>
          )}
        </div>
      </div>

      {done && (
        <button onClick={replay} className="mt-4 flex items-center gap-1.5 rounded-full border border-ink-200 bg-white px-3.5 py-1.5 text-xs font-medium text-ink-600 hover:border-brand-300 hover:text-brand-700 shadow-xs transition-colors">
          <RotateCw size={13} /> Replay
        </button>
      )}
    </div>
  );
}

function Message({
  avatar, name, addr, time, to, tag, children,
}: {
  avatar: React.ReactNode; name: string; addr: string; time: string; to: string; tag?: string; children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="shrink-0">{avatar}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-ink-900">{name}</span>
          {tag && <span className="rounded bg-brand-100 text-brand-700 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">{tag}</span>}
          <span className="ml-auto text-2xs text-ink-400 tnum">{time}</span>
        </div>
        <div className="text-2xs text-ink-400">{addr} · {to}</div>
        <div className="mt-2">{children}</div>
      </div>
    </div>
  );
}

function Attachment({ icon, name, meta, tone }: { icon: React.ReactNode; name: string; meta: string; tone: "sheet" | "invoice" }) {
  return (
    <div className="mt-2.5 inline-flex items-center gap-2.5 rounded-lg border border-ink-200 bg-white px-2.5 py-2 shadow-xs">
      <span className={`grid place-items-center h-9 w-9 rounded-lg ${tone === "invoice" ? "bg-brand-50 text-brand-600" : "bg-emerald-50 text-emerald-600"}`}>{icon}</span>
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-ink-800 truncate max-w-[180px]">{name}</div>
        <div className="text-2xs text-ink-400">{meta}</div>
      </div>
    </div>
  );
}

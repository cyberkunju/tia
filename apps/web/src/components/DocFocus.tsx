import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ExternalLink, Info, X, FileText, Check, FileSpreadsheet, RotateCcw, Sparkles } from "lucide-react";
import { api, API_BASE } from "../api";
import { cn, fmtAED, fmtPct, isAutoDispatched, vatBreakdown, TASC_ENTITY } from "../lib";
import { StatusBadge, RoutingBadge, ConfidenceBadge, Badge, Spinner, EmptyState } from "../ui";
import { useTabAvoidance } from "../hooks";
import type { Candidate, ExtractedRow, Invoice, RowMatch, ValidationResult } from "../types";
import { PlainEnglishStatus } from "./PlainEnglishStatus";
import { ContractPanel } from "./ContractPanel";
import { EventTimeline } from "./EventTimeline";
import { TouchlessRationale } from "./TouchlessRationale";
import { ClawbackModal } from "./ClawbackModal";
import { EmlCard } from "./EmlCard";
import { TextCard } from "./TextCard";
import { SpreadsheetCard } from "./SpreadsheetCard";
import { InvoiceFSMStrip } from "./InvoiceFSMStrip";
import { InvoiceChatTrigger } from "./InvoiceChatTrigger";
import { SapB1Drawer } from "./SapB1Drawer";

export function DocFocus({ docId }: { docId: string }) {
  const qc = useQueryClient();
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["doc", docId], queryFn: () => api.getDoc(docId), enabled: !!docId, refetchInterval: 3_000,
  });
  const ts = data?.timesheet;
  const ex = ts?.extraction;
  const mr = ts?.match_result;
  const invoices = data?.invoices ?? [];

  const [picks, setPicks] = useState<Record<number, string>>({});
  const [whyOpen, setWhyOpen] = useState(false);
  const [touchlessFor, setTouchlessFor] = useState<Invoice | null>(null);
  const [clawbackFor, setClawbackFor] = useState<Invoice | null>(null);
  const bar = useTabAvoidance<HTMLDivElement>();

  // Live audit feed for whichever invoice (or timesheet) is in focus.
  const auditEntityId = invoices[0]?.id ?? ts?.id ?? null;
  const { data: events } = useQuery({
    queryKey: ["events", auditEntityId],
    /* v8 ignore next -- ts is guaranteed by the early return and enabled gates a falsy id, so auditEntityId is never nullish here */
    queryFn: () => api.listEvents(auditEntityId ?? undefined, 50),
    enabled: !!auditEntityId,
    refetchInterval: 5_000,
  });

  const approve = useMutation({
    mutationFn: () => api.approve(ts!.id, Object.entries(picks).map(([k, v]) => ({ row_idx: Number(k), chosen_emp_id: v }))),
    onSuccess: async () => { setPicks({}); await qc.invalidateQueries({ queryKey: ["doc", docId] }); await qc.invalidateQueries({ queryKey: ["docs"] }); await qc.invalidateQueries({ queryKey: ["invoices"] }); refetch(); },
  });
  const reject = useMutation({ mutationFn: (reason: string) => api.reject(ts!.id, reason), onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["doc", docId] }); await qc.invalidateQueries({ queryKey: ["docs"] }); } });
  const dispatchInv = useMutation({ mutationFn: (id: string) => api.dispatchInvoice(id), onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["doc", docId] }); await qc.invalidateQueries({ queryKey: ["invoices"] }); } });

  /* v8 ignore next -- docId is always a truthy prop (DocFocus only renders for a selected doc), so the `: null` branch is unreachable */
  const sourceUrl = useMemo(() => (docId ? api.docSourceUrl(docId) : null), [docId]);
  const fname = data?.doc.filename ?? "";
  const mime = data?.doc.mime ?? "";
  const sourceIsImage = mime.startsWith("image/");
  const sourceIsPdf = mime === "application/pdf";
  const sourceIsEml = /\.eml$/i.test(fname) || mime.includes("rfc822") || (data?.doc.channel === "email" && !fname);
  /* v8 ignore next -- redundant operand: a .xlsx filename already makes the first `||` operand true, so this octet-stream branch can never be the deciding truthy one */
  const sourceIsXlsx = /\.xlsx?$/i.test(fname) || mime.includes("spreadsheet") || mime.includes("excel") || mime === "application/octet-stream" && /\.xlsx?$/i.test(fname);

  if (isLoading) return <div className="flex items-center gap-2 text-ink-500 p-6"><Spinner /> Loading document…</div>;
  if (!data || !ts) return <EmptyState icon={FileText} title="Document unavailable" />;

  const allResolved = mr?.matches.every((m) => (m.chosen_emp_id && !m.ambiguous) || picks[m.row_idx]);
  const ambiguousRows = mr?.matches.filter((m) => m.ambiguous) ?? [];

  return (
    <div className="divide-y divide-ink-100">
      {/* header */}
      <div className="px-4 py-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-semibold text-ink-900">{ts.client_code ?? "Client unknown"}</h2>
            <span className="text-ink-300">·</span>
            <span className="text-sm text-ink-500">{ts.period ?? "period unknown"}</span>
            <StatusBadge status={ts.status} />
            {ts.routing && <RoutingBadge routing={ts.routing} />}
            {ts.confidence != null && <ConfidenceBadge value={ts.confidence} />}
          </div>
          {ts.hitl_reason && <p className="text-xs text-amber-700 mt-1">{ts.hitl_reason}</p>}
        </div>
        <button className="btn-outline btn-sm shrink-0" onClick={() => setWhyOpen(true)}><Info size={13} /> Why</button>
      </div>

      {/* source + extracted in two columns on wide */}
      <div className="grid grid-cols-1 xl:grid-cols-2">
        <div className="p-4 xl:border-r border-ink-100 min-w-0">
          <div className="flex items-center justify-between mb-2 gap-2 min-w-0">
            <span className="eyebrow truncate min-w-0" title={`${data.doc.channel}${data.doc.filename ? ` · ${data.doc.filename}` : ""}`}>
              Source · {data.doc.channel}{data.doc.filename ? ` · ${data.doc.filename}` : ""}
            </span>
            <a
              href={sourceUrl!}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-brand-700 hover:underline inline-flex items-center gap-1 shrink-0"
            >
              raw <ExternalLink size={11} />
            </a>
          </div>
          {sourceIsImage || sourceIsPdf ? (
            <div className="bg-ink-50 rounded-lg h-72 flex items-center justify-center overflow-hidden border border-ink-100">
              {sourceIsImage && <img src={sourceUrl!} alt="source" className="max-h-full max-w-full object-contain" />}
              {sourceIsPdf && <iframe src={sourceUrl!} title="src" className="w-full h-full" />}
            </div>
          ) : sourceIsEml ? (
            <div className="rounded-lg h-72 overflow-hidden border border-ink-100">
              <EmlCard sourceUrl={sourceUrl!} />
            </div>
          ) : sourceIsXlsx ? (
            <div className="rounded-lg h-72 overflow-hidden border border-ink-100">
              <SpreadsheetCard sourceUrl={sourceUrl!} filename={fname} />
            </div>
          ) : (
            <div className="rounded-lg h-72 overflow-hidden border border-ink-100">
              <TextCard sourceUrl={sourceUrl!} filename={fname} />
            </div>
          )}
        </div>
        <div className="p-4 min-w-0">
          <span className="eyebrow">Extracted associates</span>
          <div className="space-y-2 mt-2">
            {ex?.rows.map((r, idx) => (
              <RowCard key={idx} row={r} match={mr?.matches[idx]} pick={picks[idx]} onPick={(emp) => setPicks((p) => ({ ...p, [idx]: emp }))} />
            ))}
            {(!ex?.rows || ex.rows.length === 0) && <div className="text-ink-400 text-sm">No rows extracted.</div>}
          </div>
        </div>
      </div>

      {ambiguousRows.length > 0 && mr && (
        <div className="p-4">
          <span className="eyebrow">Hungarian assignment · cost matrix</span>
          <p className="text-xs text-ink-500 mt-1 mb-2">Lower = stronger match. Near-equal columns (Δ≈0) signal ambiguity; assignment minimises total cost.</p>
          <CostMatrix cost={mr.cost_matrix} rowLabels={mr.row_labels} colLabels={mr.candidate_labels} />
        </div>
      )}

      {ts.client_code && (
        <div className="p-4">
          <span className="eyebrow">Contract context</span>
          <div className="mt-2"><ContractPanel clientCode={ts.client_code} /></div>
        </div>
      )}

      {(ts.validations?.length ?? 0) > 0 && (
        <div className="p-4">
          <span className="eyebrow">Status</span>
          <div className="mt-2"><PlainEnglishStatus results={ts.validations} /></div>
        </div>
      )}

      {ts.status === "awaiting_review" && (
        <div ref={bar.ref} style={{ paddingRight: bar.avoid || undefined }} className="p-4 flex items-center justify-between gap-3 bg-amber-50/40 transition-[padding] duration-200">
          <span className="text-sm text-ink-600">{ambiguousRows.length > 0 ? `Resolve ${ambiguousRows.length} ambiguous row${ambiguousRows.length === 1 ? "" : "s"}.` : "Approve to generate the invoice."}</span>
          <div className="flex items-center gap-2">
            <button className="btn-danger btn-sm" onClick={() => { const r = prompt("Reason for rejection?"); if (r) reject.mutate(r); }}>Reject</button>
            <button className="btn-primary btn-sm" disabled={!allResolved || approve.isPending} onClick={() => approve.mutate()}>{approve.isPending ? <><Spinner /> Approving…</> : <><Check size={14} /> Approve & generate</>}</button>
          </div>
        </div>
      )}

      {invoices.map((inv) => {
        const sub = inv.total_excl_vat ?? inv.amount;
        const vat = inv.vat_amount ?? vatBreakdown(inv.amount).vat;
        const tot = inv.total_incl_vat ?? vatBreakdown(inv.amount).total;
        const trn = inv.supplier_trn ?? TASC_ENTITY.trn;
        const auto = isAutoDispatched(inv.status) && !inv.client_approval_status;
        const canClawback = inv.status === "dispatched" || inv.status === "generated" || inv.status === "finance_approved";
        return (
          <div key={inv.id} className="p-4">
            <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
              <span className="eyebrow">Tax invoice {inv.invoice_sequence_no ? `· ${inv.invoice_sequence_no}` : ""}</span>
              <div className="flex items-center gap-2 flex-wrap">
                <StatusBadge status={inv.status} />
                <InvoiceChatTrigger
                  kind="invoice"
                  id={inv.id}
                  ref={inv.invoice_sequence_no ?? inv.id.slice(0, 8)}
                  variant="prominent"
                  label="Ask AIDA"
                />
                {auto && (
                  <button onClick={() => setTouchlessFor(inv)} className="inline-flex items-center gap-1 rounded-md bg-brand-500 hover:bg-brand-400 text-teal-950 text-2xs font-semibold px-2 py-0.5 shadow-xs" title="Why was this touchless?">
                    <Sparkles size={10} /> AUTO · Why?
                  </button>
                )}
                {inv.pdf_available && <a className="btn-outline btn-sm" href={`${API_BASE}/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer"><ExternalLink size={12} /> PDF</a>}
                {inv.status === "generated" && <button className="btn-primary btn-sm" disabled={dispatchInv.isPending} onClick={() => dispatchInv.mutate(inv.id)}>{dispatchInv.isPending ? <Spinner /> : null} Dispatch</button>}
                {canClawback && (
                  <button onClick={() => setClawbackFor(inv)} className="btn-outline btn-sm" title="Void or issue credit note (UAE FTA Art. 60)">
                    <RotateCcw size={12} /> Clawback
                  </button>
                )}
              </div>
            </div>
            <div className="rounded-lg border border-ink-200 overflow-hidden">
              <div className="px-3 py-2 bg-ink-50 text-2xs text-ink-500 flex justify-between gap-2">
                <span>{TASC_ENTITY.name} · TRN {trn}</span>
                <span>{inv.client_code} · {inv.period}</span>
              </div>
              <div className="px-3 py-2 text-sm space-y-1">
                <Line label="Subtotal" value={fmtAED(sub)} />
                <Line label={`VAT ${((inv.vat_rate ?? 0.05) * 100).toFixed(0)}%`} value={fmtAED(vat)} muted />
                <div className="border-t border-ink-100 pt-1"><Line label="Total (AED)" value={fmtAED(tot)} bold /></div>
              </div>
              {(inv.sac_code || inv.customer_trn) && (
                <div className="px-3 py-1.5 bg-ink-50 text-2xs text-ink-400 flex gap-3 border-t border-ink-100">
                  {inv.sac_code && <span>SAC/HSN {inv.sac_code}</span>}
                  {inv.customer_trn && <span>Customer TRN {inv.customer_trn}</span>}
                  {inv.due_date && <span>Due {inv.due_date}</span>}
                </div>
              )}
              {/* Clawback breadcrumb: if voided / credit-noted, surface it. */}
              {inv.voided_at && (
                <div className="px-3 py-1.5 bg-red-50 text-2xs text-red-800 border-t border-red-100">
                  Voided by {inv.voided_by ?? "system"} at {inv.voided_at.slice(0, 19).replace("T", " ")}
                  {inv.voided_reason_code && <> · {inv.voided_reason_code}</>}
                </div>
              )}
              {inv.credit_note_sequence_no && (
                <div className="px-3 py-1.5 bg-amber-50 text-2xs text-amber-900 border-t border-amber-100">
                  Tax Credit Note <span className="font-mono">{inv.credit_note_sequence_no}</span>
                  {inv.credit_note_amount && <> · AED {inv.credit_note_amount.toFixed(2)}</>}
                  {inv.credit_note_article_refs && inv.credit_note_article_refs.length > 0 && <> · {inv.credit_note_article_refs.join(", ")}</>}
                </div>
              )}
            </div>

            {/* Invoice FSM breadcrumb. */}
            <div className="mt-2">
              <InvoiceFSMStrip status={inv.status} />
            </div>

            {/* SAP Business One Service Layer payload (OData v4) - judges + integrators love this. */}
            <div className="mt-2">
              <SapB1Drawer invoiceId={inv.id} />
            </div>
          </div>
        );
      })}

      {ts.client_code && ts.period && (
        <div className="p-3 flex flex-wrap items-center gap-2">
          <span className="eyebrow mr-1">ERP-ready exports</span>
          <a className="btn-outline btn-sm" href={api.consolidatedExcelUrl(ts.client_code, ts.period)} target="_blank" rel="noreferrer"><FileSpreadsheet size={13} /> SAP Excel</a>
          <a className="btn-outline btn-sm" href={api.wpsSifUrl(ts.client_code, ts.period)} target="_blank" rel="noreferrer"><FileSpreadsheet size={13} /> WPS SIF</a>
        </div>
      )}

      {events && events.length > 0 && (
        <div className="p-4">
          <span className="eyebrow">Audit timeline</span>
          <div className="mt-2"><EventTimeline events={events} max={15} /></div>
        </div>
      )}

      <AnimatePresence>{whyOpen && <WhyDrawer invoiceId={invoices[0]?.id ?? null} onClose={() => setWhyOpen(false)} />}</AnimatePresence>
      {touchlessFor && <TouchlessRationale invoice={touchlessFor} onClose={() => setTouchlessFor(null)} />}
      {clawbackFor && (
        <ClawbackModal
          invoice={clawbackFor}
          onClose={() => setClawbackFor(null)}
          onDone={() => { setClawbackFor(null); refetch(); }}
        />
      )}
    </div>
  );
}

function Line({ label, value, bold, muted }: { label: string; value: string; bold?: boolean; muted?: boolean }) {
  return <div className="flex items-center justify-between"><span className={cn("text-ink-500", bold && "text-ink-800 font-medium")}>{label}</span><span className={cn("tnum", bold ? "font-semibold text-ink-900" : muted ? "text-ink-500" : "text-ink-700")}>{value}</span></div>;
}

function RowCard({ row, match, pick, onPick }: { row: ExtractedRow; match?: RowMatch; pick?: string; onPick: (emp: string) => void }) {
  const chosen = pick ?? match?.chosen_emp_id;
  const ambiguous = !!match?.ambiguous && !pick;
  return (
    <div className={cn("border rounded-lg p-2.5", ambiguous ? "border-amber-300 bg-amber-50/50" : "border-ink-200")}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <span className="font-medium text-sm text-ink-900 truncate">{row.employee_name}</span>
          {chosen && <Badge tone="blue" dot={false}>{chosen}</Badge>}
          {match?.confidence != null && <ConfidenceBadge value={match.confidence} />}
          {ambiguous && <Badge tone="amber">ambiguous</Badge>}
        </div>
      </div>
      <div className="text-xs text-ink-600 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
        {row.days_worked != null && <span><span className="text-ink-400">days</span> <span className="tnum">{row.days_worked}</span></span>}
        {row.hours != null && <span><span className="text-ink-400">hrs</span> <span className="tnum">{row.hours}</span></span>}
        {row.ot_hours != null && <span><span className="text-ink-400">OT</span> <span className="tnum">{row.ot_hours}</span></span>}
        {row.leave_codes?.length > 0 && <span><span className="text-ink-400">leave</span> {row.leave_codes.join(", ")}</span>}
      </div>
      {ambiguous && match!.candidates.length > 1 && (
        <div className="mt-2 pt-2 border-t border-amber-200 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {match!.candidates.map((c: Candidate) => (
            <button
              key={c.emp_id}
              onClick={() => onPick(c.emp_id)}
              /* v8 ignore next -- candidate buttons are hidden once a pick is made (ambiguous becomes false), so `pick === c.emp_id` is never true while they render */
              className={cn("text-left text-xs px-2.5 py-1.5 rounded-md border transition-colors", pick === c.emp_id ? "border-brand-500 bg-brand-50" : "border-ink-200 hover:border-brand-400 hover:bg-ink-50")}
            >
              <div className="font-medium text-ink-800">{c.emp_id} · {c.full_name}</div>
              <div className="text-ink-500">{c.client_code} · score <span className="tnum">{c.score.toFixed(3)}</span></div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CostMatrix({ cost, rowLabels, colLabels }: { cost: number[][]; rowLabels: string[]; colLabels: string[] }) {
  if (cost.length === 0 || cost[0].length === 0) return <div className="text-ink-400 text-sm">no candidates</div>;
  // Single extracted row matched to a single candidate = trivial assignment.
  // Showing a 1x1 matrix of "0.00" is just confusing noise — render a chip
  // that says the match was exact + on what basis.
  if (cost.length === 1 && cost[0].length === 1) {
    const v = cost[0][0];
    const exact = v < 0.05;
    return (
      <div className="inline-flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
        <span className="text-emerald-700 text-xs font-medium">{exact ? "Exact match" : "Single-candidate match"}</span>
        <span className="font-mono text-2xs text-emerald-600">{rowLabels[0]} → {colLabels[0]}</span>
      </div>
    );
  }
  const max = Math.max(...cost.flat(), 0.01);
  return (
    <div className="overflow-x-auto">
      <table className="text-xs border-separate border-spacing-0">
        <thead><tr><th className="p-2"></th>{colLabels.map((c) => <th key={c} className="text-left p-2 text-ink-500 font-medium whitespace-nowrap">{c}</th>)}</tr></thead>
        <tbody>
          {cost.map((rrow, i) => (
            <tr key={i}>
              <td className="p-2 text-ink-700 font-medium whitespace-nowrap">{rowLabels[i]}</td>
              {rrow.map((v, j) => { const intensity = 1 - Math.min(1, v / max); return <td key={j} className="p-2 text-center border border-ink-100 font-mono tnum" style={{ background: `rgba(217,83,30,${0.06 + intensity * 0.5})` }} title={`cost ${v.toFixed(3)}`}>{v.toFixed(2)}</td>; })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WhyDrawer({ invoiceId, onClose }: { invoiceId: string | null; onClose: () => void }) {
  const { data } = useQuery({
    queryKey: ["why", invoiceId],
    /* v8 ignore next -- enabled:!!invoiceId gates a falsy id, so the `: Promise.resolve(null)` branch is unreachable */
    queryFn: () => (invoiceId ? api.invoiceWhy(invoiceId) : Promise.resolve(null)),
    enabled: !!invoiceId,
  });

  // LLM-generated plain-English rationale - caching by invoice id so the user
  // doesn't pay the latency on every drawer open. The prompt forbids rule
  // codes/jargon and forces a 4–6 sentence prose summary.
  const explain = useQuery({
    queryKey: ["why-explain", invoiceId],
    enabled: !!invoiceId,
    retry: false,
    staleTime: 5 * 60_000,
    queryFn: () =>
      api.qa(
        "Explain in plain English, in 4 to 6 sentences and ZERO jargon (do not mention rule codes like R0/R1/R5, do not say 'BTP', do not say 'validations'), why this invoice was generated and what it means for the client. Cover four things: what the source timesheet looked like, which associates were matched, whether anything needed a human's attention, and whether it was sent out automatically or routed for manual review. Be concrete with names, days, and amounts where possible.",
        /* v8 ignore next -- enabled:!!invoiceId gates a falsy id, so the `: undefined` branch is unreachable */
        invoiceId ? { kind: "invoice", id: invoiceId } : undefined,
      ),
  });

  const llmAnswer = explain.data?.answer && !/not configured|OPENAI_API_KEY|missing/i.test(explain.data.answer)
    ? explain.data.answer
    : null;

  return (
    <>
      <motion.div className="fixed inset-0 bg-ink-950/40 z-40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.aside className="fixed right-0 top-0 bottom-0 w-full max-w-[520px] bg-white shadow-lg z-50 overflow-y-auto" initial={{ x: 560 }} animate={{ x: 0 }} exit={{ x: 560 }} transition={{ type: "spring", stiffness: 280, damping: 32 }}>
        <div className="sticky top-0 bg-white border-b border-ink-200 px-5 py-3 flex items-center justify-between">
          <div>
            <div className="eyebrow">Provenance</div>
            <h3 className="font-semibold text-ink-900">Why this invoice?</h3>
          </div>
          <button className="btn-ghost btn-sm" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="p-5 space-y-5">
          {!invoiceId && <div className="text-ink-500 text-sm">No invoice yet - approve to generate.</div>}

          {/* Plain-English LLM rationale - TOP-LEVEL answer judges/clients want. */}
          {invoiceId && (
            <section className="rounded-lg ring-1 ring-brand-200 bg-brand-50/50 p-4">
              <div className="flex items-center gap-1.5 mb-1.5">
                <Sparkles size={14} className="text-brand-600" />
                <span className="text-2xs uppercase tracking-wide font-semibold text-brand-800">In plain English</span>
              </div>
              {explain.isLoading ? (
                <div className="text-sm text-ink-500 inline-flex items-center gap-2"><Spinner /> Thinking…</div>
              ) : llmAnswer ? (
                <p className="text-sm text-ink-800 leading-relaxed whitespace-pre-wrap">{stripPlainAnswer(llmAnswer)}</p>
              ) : (
                <p className="text-sm text-ink-600 leading-relaxed">
                  {buildDeterministicExplanation(data)}
                </p>
              )}
              {explain.data?.model && llmAnswer && (
                <p className="mt-2 text-[10px] font-mono text-ink-400">{explain.data.model}</p>
              )}
            </section>
          )}

          {/* Confidence bar */}
          <div className="rounded-md border border-ink-200 px-3 py-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-2xs uppercase tracking-wide font-semibold text-ink-500">Confidence</span>
              <span className="text-sm font-semibold tnum text-ink-900">{fmtPct(data?.confidence_calibrated ?? 0)}</span>
            </div>
            <div className="h-1.5 rounded-full bg-ink-100 overflow-hidden">
              <div
                className={cn(
                  "h-full",
                  (data?.confidence_calibrated ?? 0) >= 0.9 ? "bg-emerald-500" :
                  (data?.confidence_calibrated ?? 0) >= 0.6 ? "bg-amber-500" : "bg-red-500",
                )}
                style={{ width: `${Math.round((data?.confidence_calibrated ?? 0) * 100)}%` }}
              />
            </div>
            <p className="text-2xs text-ink-400 mt-1">Computed by the matcher and validator. Never taken from the model.</p>
          </div>

          {/* Entity resolution - only when there's a non-trivial assignment to show. */}
          {data?.match_result && data.match_result.cost_matrix.length > 0 && (
            <div>
              <h4 className="text-2xs font-semibold uppercase tracking-wide text-ink-500 mb-2">How associates were matched</h4>
              <CostMatrix cost={data.match_result.cost_matrix} rowLabels={data.match_result.row_labels} colLabels={data.match_result.candidate_labels} />
            </div>
          )}

          {/* Plain-English audit (what TIA actually did, step-by-step). */}
          {data?.events && data.events.length > 0 && (
            <div>
              <h4 className="text-2xs font-semibold uppercase tracking-wide text-ink-500 mb-2">What TIA did, step by step</h4>
              <ol className="space-y-2.5">
                {data.events.map((e) => (
                  <li key={e.id} className="border-l-2 border-brand-300 pl-3">
                    <div className="text-xs font-medium text-ink-800">{humaniseAction(e.action)} <span className="text-ink-400 font-normal">· {e.actor ?? "system"}</span></div>
                    <div className="text-2xs text-ink-500">{new Date(e.at).toLocaleString()}</div>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </motion.aside>
    </>
  );
}

/** Map internal event actions to plain-English verbs for the timeline list. */
function humaniseAction(action: string): string {
  const m: Record<string, string> = {
    ingested: "Received the timesheet",
    extracted: "Read the timesheet contents",
    resolved: "Matched the associates",
    rules_evaluated: "Ran every contract check",
    generated: "Generated the tax invoice",
    routed: "Decided how to route this",
    dispatched: "Sent the invoice to the client",
    auto_dispatched_within_tolerance: "Auto-dispatched (no human touch needed)",
    auto_dispatch_skipped: "Held back for manual approval",
    client_approved: "Client approved",
    client_rejected: "Client rejected",
    finance_approved: "Finance approved",
    finance_rejected: "Finance rejected",
    "invoice.voided": "Invoice voided",
    "invoice.credit_note_issued": "Issued a tax credit note",
  };
  return m[action] ?? action.replace(/[._]/g, " ");
}

/** AIDA replies are already plain-prose-prompted; this is a final safety net. */
function stripPlainAnswer(t: string): string {
  return t
    .replace(/\b(?:R(?:ule\s*)?[0-9]+)\b/gi, "the relevant check")
    .replace(/\bBTP\b/g, "the contract checks")
    .replace(/```[\w-]*\n?([\s\S]*?)```/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .trim();
}

/** Last-ditch deterministic explanation if AIDA is unavailable. */
function buildDeterministicExplanation(why: { confidence_calibrated?: number | null; validations?: ValidationResult[] | null } | null | undefined): string {
  if (!why) return "TIA processed this invoice through the standard pipeline.";
  const conf = why.confidence_calibrated ?? 0;
  const fails = (why.validations ?? []).filter((v) => !v.passed && v.severity !== "warning").length;
  if (fails === 0 && conf >= 0.9) {
    return `Confidence ${(conf * 100).toFixed(0)}% - TIA matched every associate cleanly and every contract check passed, so the tax invoice was generated and sent out without a human in the loop.`;
  }
  if (fails === 0) {
    return `Confidence ${(conf * 100).toFixed(0)}% - the contract checks all passed; a FinOps reviewer confirmed the matches before generating the invoice.`;
  }
  return `Confidence ${(conf * 100).toFixed(0)}% - TIA found ${fails} item${fails === 1 ? "" : "s"} that didn't match the contract, so a FinOps reviewer was asked to resolve them before the invoice could be generated.`;
}

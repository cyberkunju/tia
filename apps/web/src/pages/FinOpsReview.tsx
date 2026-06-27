import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "react-router-dom";
import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft, ExternalLink, Info, X, FileText, Check, ListChecks,
} from "lucide-react";
import { api, API_BASE } from "../api";
import { cn, fmtMoney, fmtPct } from "../lib";
import { StatusBadge, RoutingBadge, ConfidenceBadge, Badge, Panel, Spinner } from "../ui";
import type { Candidate, ExtractedRow, RowMatch } from "../types";

export function FinOpsReview() {
  const { docId = "" } = useParams();
  const qc = useQueryClient();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["doc", docId],
    queryFn: () => api.getDoc(docId),
    enabled: !!docId,
    refetchInterval: 3_000,
  });

  const ts = data?.timesheet;
  const ex = ts?.extraction;
  const mr = ts?.match_result;
  const invoices = data?.invoices ?? [];

  const [picks, setPicks] = useState<Record<number, string>>({});
  const [whyOpen, setWhyOpen] = useState(false);

  const approve = useMutation({
    mutationFn: () => api.approve(ts!.id, Object.entries(picks).map(([k, v]) => ({ row_idx: Number(k), chosen_emp_id: v }))),
    onSuccess: async () => {
      setPicks({});
      await qc.invalidateQueries({ queryKey: ["doc", docId] });
      await qc.invalidateQueries({ queryKey: ["invoices"] });
      await qc.invalidateQueries({ queryKey: ["docs"] });
      refetch();
    },
  });
  const reject = useMutation({
    mutationFn: (reason: string) => api.reject(ts!.id, reason),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["doc", docId] }); },
  });
  const dispatchInv = useMutation({
    mutationFn: (id: string) => api.dispatchInvoice(id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["doc", docId] });
      await qc.invalidateQueries({ queryKey: ["invoices"] });
    },
  });

  const sourceUrl = useMemo(() => (docId ? api.docSourceUrl(docId) : null), [docId]);
  const sourceIsImage = data?.doc.mime?.startsWith("image/");
  const sourceIsPdf = data?.doc.mime === "application/pdf";

  if (isLoading) return <div className="flex items-center gap-2 text-ink-500"><Spinner /> Loading document…</div>;
  if (!data || !ts) {
    return (
      <div className="text-ink-500">
        Document not found. <Link to="/finops" className="text-brand-700 hover:underline">Back to inbox</Link>
      </div>
    );
  }

  const allResolved = mr?.matches.every((m) => (m.chosen_emp_id && !m.ambiguous) || picks[m.row_idx]);
  const ambiguousRows = mr?.matches.filter((m) => m.ambiguous) ?? [];

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4">
        <Link to="/finops" className="inline-flex items-center gap-1.5 text-sm text-ink-500 hover:text-ink-900">
          <ArrowLeft size={15} /> Inbox
        </Link>
        <button className="btn-outline btn-sm" onClick={() => setWhyOpen(true)}>
          <Info size={14} /> Why this invoice?
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* LEFT: source */}
        <section className="lg:sticky lg:top-6 self-start">
          <Panel
            title="Source document"
            subtitle={`${data.doc.filename} · ${data.doc.channel} · ${data.doc.mime || "unknown"}`}
            actions={<a href={sourceUrl!} target="_blank" rel="noreferrer" className="btn-outline btn-sm"><ExternalLink size={13} /> Raw</a>}
            bodyClassName="p-0"
          >
            <div className="bg-ink-50 h-[560px] flex items-center justify-center overflow-hidden rounded-b-lg">
              {sourceIsImage && <img src={sourceUrl!} alt="source" className="max-h-full max-w-full object-contain" />}
              {sourceIsPdf && <iframe src={sourceUrl!} title="source pdf" className="w-full h-full" />}
              {!sourceIsImage && !sourceIsPdf && (
                <div className="flex flex-col items-center gap-2 text-ink-400 text-sm px-6 text-center">
                  <FileText size={22} />
                  Source is {data.doc.mime || "text"}. Open raw to view.
                </div>
              )}
            </div>
          </Panel>
        </section>

        {/* RIGHT: extracted / matched / validated */}
        <section className="space-y-4">
          <div className="card p-4">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-sm font-semibold text-ink-900">Timesheet</h2>
              <StatusBadge status={ts.status} />
              {ts.routing && <RoutingBadge routing={ts.routing} />}
              {ts.confidence != null && <ConfidenceBadge value={ts.confidence} />}
            </div>
            <p className="text-xs text-ink-500 mt-1.5">
              {ts.client_code ?? "client unknown"} · {ts.period ?? "period unknown"}
              {ts.hitl_reason ? ` · ${ts.hitl_reason}` : ""}
            </p>
          </div>

          <Panel title="Extracted rows">
            <div className="space-y-2">
              {ex?.rows.map((r, idx) => (
                <RowCard key={idx} row={r} match={mr?.matches[idx]} pick={picks[idx]} onPick={(emp) => setPicks((p) => ({ ...p, [idx]: emp }))} />
              ))}
              {(!ex?.rows || ex.rows.length === 0) && <div className="text-ink-400 text-sm">No rows extracted.</div>}
            </div>
          </Panel>

          {ambiguousRows.length > 0 && mr && (
            <Panel title="Hungarian assignment — cost matrix"
              subtitle={`Lower cost = stronger match. Near-equal columns (Δ≈0) signal ambiguity; the assignment minimizes total cost across rows.`}>
              <CostMatrix cost={mr.cost_matrix} rowLabels={mr.row_labels} colLabels={mr.candidate_labels} />
            </Panel>
          )}

          {(ts.validations?.length ?? 0) > 0 && (
            <Panel title="Validations">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {ts.validations.map((v, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <Badge tone={v.passed ? "green" : "red"} dot={false}>{v.passed ? "Pass" : "Fail"}</Badge>
                    <div className="min-w-0">
                      <div className="font-medium text-ink-800 text-sm">{v.rule}{v.emp_id && <span className="text-ink-400 font-normal"> · {v.emp_id}</span>}</div>
                      <div className="text-ink-500 text-xs">{v.message}</div>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {ts.status === "awaiting_review" && (
            <div className="card p-4 flex items-center justify-between gap-3">
              <div className="text-sm text-ink-600">
                {ambiguousRows.length > 0
                  ? `Pick a candidate for ${ambiguousRows.length} ambiguous row${ambiguousRows.length === 1 ? "" : "s"}.`
                  : "Approve to generate the invoice."}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button className="btn-danger btn-sm" onClick={() => { const r = prompt("Reason for rejection?"); if (r) reject.mutate(r); }}>
                  Reject
                </button>
                <button className="btn-primary btn-sm" disabled={!allResolved || approve.isPending} onClick={() => approve.mutate()}>
                  {approve.isPending ? <><Spinner /> Approving…</> : <><Check size={14} /> Approve & generate</>}
                </button>
              </div>
            </div>
          )}

          {invoices.length > 0 && (
            <Panel title="Invoice">
              {invoices.map((inv) => (
                <div key={inv.id} className="flex items-center justify-between py-2 border-b border-ink-100 last:border-0">
                  <div>
                    <div className="font-medium text-ink-800">{fmtMoney(inv.amount, inv.currency)}</div>
                    <div className="text-xs text-ink-500">{inv.client_code} · {inv.period}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={inv.status} />
                    {inv.pdf_available && (
                      <a className="btn-outline btn-sm" href={`${API_BASE}/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer"><ExternalLink size={13} /> PDF</a>
                    )}
                    {inv.status === "generated" && (
                      <button className="btn-primary btn-sm" disabled={dispatchInv.isPending} onClick={() => dispatchInv.mutate(inv.id)}>
                        {dispatchInv.isPending ? <Spinner /> : null} Dispatch
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </Panel>
          )}
        </section>
      </div>

      <AnimatePresence>
        {whyOpen && <WhyDrawer invoiceId={invoices[0]?.id ?? null} onClose={() => setWhyOpen(false)} />}
      </AnimatePresence>
    </div>
  );
}

function RowCard({ row, match, pick, onPick }: { row: ExtractedRow; match?: RowMatch; pick?: string; onPick: (emp: string) => void }) {
  const chosen = pick ?? match?.chosen_emp_id;
  const ambiguous = !!match?.ambiguous && !pick;
  return (
    <div className={cn("border rounded-lg p-3", ambiguous ? "border-amber-300 bg-amber-50/50" : "border-ink-200")}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-ink-900">{row.employee_name}</span>
          {chosen && <Badge tone="blue" dot={false}>{chosen}</Badge>}
          {match?.confidence != null && <ConfidenceBadge value={match.confidence} />}
          {ambiguous && <Badge tone="amber">ambiguous</Badge>}
        </div>
        <div className="text-2xs text-ink-400 text-right shrink-0">{match?.reason}</div>
      </div>
      <div className="text-sm text-ink-600 mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
        {row.days_worked != null && <span><span className="text-ink-400">days</span> <span className="tnum">{row.days_worked}</span></span>}
        {row.hours != null && <span><span className="text-ink-400">hrs</span> <span className="tnum">{row.hours}</span></span>}
        {row.ot_hours != null && <span><span className="text-ink-400">OT</span> <span className="tnum">{row.ot_hours}</span></span>}
        {row.leave_codes?.length > 0 && <span><span className="text-ink-400">leave</span> {row.leave_codes.join(", ")}</span>}
        {row.reimbursements?.length > 0 && (
          <span><span className="text-ink-400">reimb</span> {row.reimbursements.map((r) => `${r.reason}:${r.amount_aed}`).join(", ")}</span>
        )}
      </div>
      {ambiguous && match!.candidates.length > 1 && (
        <div className="mt-3 pt-3 border-t border-amber-200">
          <div className="text-xs font-medium text-ink-700 mb-2">Pick the correct employee</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {match!.candidates.map((c: Candidate) => (
              <button
                key={c.emp_id}
                onClick={() => onPick(c.emp_id)}
                className={cn(
                  "text-left text-sm px-3 py-2 rounded-md border transition-colors",
                  pick === c.emp_id ? "border-brand-500 bg-brand-50" : "border-ink-200 hover:border-brand-400 hover:bg-ink-50",
                )}
              >
                <div className="font-medium text-ink-800">{c.emp_id} · {c.full_name}</div>
                <div className="text-2xs text-ink-500">{c.client_code} · score <span className="tnum">{c.score.toFixed(3)}</span></div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CostMatrix({ cost, rowLabels, colLabels }: { cost: number[][]; rowLabels: string[]; colLabels: string[] }) {
  if (cost.length === 0 || cost[0].length === 0) return <div className="text-ink-400 text-sm">no candidates</div>;
  const max = Math.max(...cost.flat(), 0.01);
  return (
    <div className="overflow-x-auto">
      <table className="text-xs border-separate border-spacing-0">
        <thead>
          <tr>
            <th className="p-2"></th>
            {colLabels.map((c) => <th key={c} className="text-left p-2 text-ink-500 font-medium whitespace-nowrap">{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {cost.map((row, i) => (
            <tr key={i}>
              <td className="p-2 text-ink-700 font-medium whitespace-nowrap">{rowLabels[i]}</td>
              {row.map((v, j) => {
                const intensity = 1 - Math.min(1, v / max);
                return (
                  <td key={j} className="p-2 text-center border border-ink-100 font-mono tnum"
                      style={{ background: `rgba(217, 83, 30, ${0.06 + intensity * 0.5})` }} title={`cost ${v.toFixed(3)}`}>
                    {v.toFixed(2)}
                  </td>
                );
              })}
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
    queryFn: () => (invoiceId ? api.invoiceWhy(invoiceId) : Promise.resolve(null)),
    enabled: !!invoiceId,
  });

  return (
    <>
      <motion.div className="fixed inset-0 bg-ink-950/40 z-40"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.aside
        className="fixed right-0 top-0 bottom-0 w-full max-w-[520px] bg-white shadow-lg z-50 overflow-y-auto"
        initial={{ x: 600 }} animate={{ x: 0 }} exit={{ x: 600 }}
        transition={{ type: "spring", stiffness: 280, damping: 32 }}
      >
        <div className="sticky top-0 bg-white border-b border-ink-200 px-5 py-3.5 flex items-center justify-between">
          <div>
            <div className="eyebrow">Provenance</div>
            <h3 className="font-semibold text-ink-900">Why this invoice?</h3>
          </div>
          <button className="btn-ghost btn-sm" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="p-5 space-y-6">
          {!invoiceId && <div className="text-ink-500 text-sm">No invoice yet for this timesheet — approve it to generate.</div>}
          {data?.invoice && (
            <div>
              <h4 className="text-xs font-semibold text-ink-700 mb-2 flex items-center gap-1.5"><ListChecks size={14} /> Invoice</h4>
              <div className="text-sm text-ink-700">
                <div className="tnum">{fmtMoney(data.invoice.amount, data.invoice.currency)} · {data.invoice.client_code} · {data.invoice.period}</div>
                <div className="text-xs text-ink-500 mt-0.5">status: {data.invoice.status}</div>
              </div>
            </div>
          )}
          {data?.match_result && data.match_result.cost_matrix.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-ink-700 mb-2">Entity resolution</h4>
              <CostMatrix cost={data.match_result.cost_matrix} rowLabels={data.match_result.row_labels} colLabels={data.match_result.candidate_labels} />
            </div>
          )}
          {data?.validations && data.validations.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-ink-700 mb-2">Validations</h4>
              <div className="space-y-1.5">
                {data.validations.map((v, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <Badge tone={v.passed ? "green" : "red"} dot={false}>{v.passed ? "✓" : "×"}</Badge>
                    <div><div className="font-medium text-xs text-ink-800">{v.rule}{v.emp_id ? ` · ${v.emp_id}` : ""}</div>
                      <div className="text-ink-500 text-xs">{v.message}</div></div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {data?.events && (
            <div>
              <h4 className="text-xs font-semibold text-ink-700 mb-2">Audit timeline</h4>
              <ol className="space-y-2.5">
                {data.events.map((e) => (
                  <li key={e.id} className="border-l-2 border-brand-300 pl-3">
                    <div className="font-medium text-ink-800 text-xs">{e.kind}.{e.action} <span className="text-ink-400 font-normal">· {e.actor}</span></div>
                    <div className="text-ink-500 text-2xs">{new Date(e.at).toLocaleString()}</div>
                    {e.idempotency_key && <div className="text-ink-400 font-mono text-2xs truncate">key {e.idempotency_key}</div>}
                  </li>
                ))}
              </ol>
            </div>
          )}
          <p className="text-2xs text-ink-400">Confidence is computed by the matcher/validator — {fmtPct(data?.confidence_calibrated ?? 0)} calibrated. Never taken from the model.</p>
        </div>
      </motion.aside>
    </>
  );
}

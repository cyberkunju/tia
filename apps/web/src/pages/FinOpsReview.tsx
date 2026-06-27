import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "react-router-dom";
import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { api, API_BASE } from "../api";
import {
  confidenceBadgeClass, fmtMoney, fmtPct, routingBadgeClass, statusBadgeClass,
} from "../lib";
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

  if (isLoading) return <div className="text-ink-500">Loading…</div>;
  if (!data || !ts) {
    return <div className="text-ink-500">Document not found. <Link to="/finops" className="underline">Back to inbox</Link></div>;
  }

  const allResolved = mr?.matches.every((m) => m.chosen_emp_id && !m.ambiguous || picks[m.row_idx]);
  const ambiguousRows = mr?.matches.filter((m) => m.ambiguous) ?? [];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      {/* LEFT: source */}
      <section className="card p-4 lg:sticky lg:top-20 self-start">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="font-semibold">Source document</h2>
            <p className="text-xs text-ink-500">
              {data.doc.filename} · {data.doc.channel} · {data.doc.mime || "unknown mime"}
            </p>
          </div>
          <a href={sourceUrl!} target="_blank" rel="noreferrer" className="btn-outline text-xs">
            Open raw
          </a>
        </div>
        <div className="bg-ink-50 rounded-lg overflow-hidden h-[560px] flex items-center justify-center">
          {sourceIsImage && (
            <img src={sourceUrl!} alt="source" className="max-h-full max-w-full object-contain" />
          )}
          {sourceIsPdf && (
            <iframe src={sourceUrl!} title="source pdf" className="w-full h-full" />
          )}
          {!sourceIsImage && !sourceIsPdf && (
            <div className="text-ink-500 text-sm px-6 text-center">
              Source is {data.doc.mime || "text"}. Click "Open raw" to view.
            </div>
          )}
        </div>
      </section>

      {/* RIGHT: extracted, matched, validated */}
      <section className="space-y-4">
        <div className="card p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-semibold">Timesheet</h2>
                <span className={statusBadgeClass(ts.status)}>{ts.status}</span>
                {ts.routing && <span className={routingBadgeClass(ts.routing)}>{ts.routing}</span>}
                {ts.confidence != null && (
                  <span className={confidenceBadgeClass(ts.confidence)}>conf {fmtPct(ts.confidence)}</span>
                )}
              </div>
              <p className="text-xs text-ink-500 mt-1">
                {ts.client_code ?? "client unknown"} · {ts.period ?? "period unknown"}
                {ts.hitl_reason ? ` · ${ts.hitl_reason}` : ""}
              </p>
            </div>
            <button className="btn-outline text-xs" onClick={() => setWhyOpen(true)}>
              Why this invoice?
            </button>
          </div>
        </div>

        <div className="card p-4">
          <h3 className="font-semibold mb-3">Extracted rows</h3>
          <div className="space-y-2">
            {ex?.rows.map((r, idx) => {
              const m = mr?.matches[idx];
              return (
                <RowCard
                  key={idx}
                  row={r}
                  match={m}
                  pick={picks[idx]}
                  onPick={(emp) => setPicks((p) => ({ ...p, [idx]: emp }))}
                />
              );
            })}
            {(!ex?.rows || ex.rows.length === 0) && (
              <div className="text-ink-400 text-sm">No rows extracted.</div>
            )}
          </div>
        </div>

        {ambiguousRows.length > 0 && mr && (
          <div className="card p-4">
            <h3 className="font-semibold mb-2">Hungarian assignment — cost matrix</h3>
            <p className="text-xs text-ink-500 mb-3">
              Lower cost = stronger match. Equal columns ({"\u0394"}≈0) signal ambiguity; the assignment minimizes total cost across all rows.
            </p>
            <CostMatrix
              cost={mr.cost_matrix}
              rowLabels={mr.row_labels}
              colLabels={mr.candidate_labels}
            />
          </div>
        )}

        {(ts.validations?.length ?? 0) > 0 && (
          <div className="card p-4">
            <h3 className="font-semibold mb-2">Validations</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
              {ts.validations.map((v, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className={v.passed ? "badge-green" : "badge-red"}>{v.passed ? "PASS" : "FAIL"}</span>
                  <div>
                    <div className="font-medium text-ink-900">{v.rule}{v.emp_id && <span className="text-ink-400"> · {v.emp_id}</span>}</div>
                    <div className="text-ink-600 text-xs">{v.message}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {ts.status === "awaiting_review" && (
          <div className="card p-4 flex items-center justify-between">
            <div className="text-sm text-ink-600">
              {ambiguousRows.length > 0
                ? `Pick a candidate for ${ambiguousRows.length} ambiguous row${ambiguousRows.length === 1 ? "" : "s"}.`
                : "Approve to generate the invoice."}
            </div>
            <div className="flex items-center gap-2">
              <button
                className="btn-outline"
                onClick={() => {
                  const r = prompt("Reason for rejection?");
                  if (r) reject.mutate(r);
                }}
              >
                Reject
              </button>
              <button
                className="btn-primary"
                disabled={!allResolved || approve.isPending}
                onClick={() => approve.mutate()}
              >
                {approve.isPending ? "Approving…" : "Approve & generate invoice"}
              </button>
            </div>
          </div>
        )}

        {invoices.length > 0 && (
          <div className="card p-4">
            <h3 className="font-semibold mb-2">Invoice</h3>
            {invoices.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between py-2 border-b border-ink-100 last:border-0">
                <div>
                  <div className="font-medium">{fmtMoney(inv.amount, inv.currency)}</div>
                  <div className="text-xs text-ink-500">{inv.client_code} · {inv.period}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={statusBadgeClass(inv.status)}>{inv.status}</span>
                  {inv.pdf_available && (
                    <a className="btn-outline text-xs" href={`${API_BASE}/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer">PDF</a>
                  )}
                  {inv.status === "generated" && (
                    <button className="btn-primary text-xs" disabled={dispatchInv.isPending}
                            onClick={() => dispatchInv.mutate(inv.id)}>
                      {dispatchInv.isPending ? "Dispatching…" : "Dispatch"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <AnimatePresence>
        {whyOpen && (
          <WhyDrawer invoiceId={invoices[0]?.id ?? null} timesheetId={ts.id} onClose={() => setWhyOpen(false)} />
        )}
      </AnimatePresence>
    </div>
  );
}

function RowCard({ row, match, pick, onPick }: {
  row: ExtractedRow; match?: RowMatch; pick?: string;
  onPick: (emp: string) => void;
}) {
  const chosen = pick ?? match?.chosen_emp_id;
  const ambiguous = !!match?.ambiguous && !pick;
  return (
    <div className={`border rounded-lg p-3 ${ambiguous ? "border-amber-300 bg-amber-50/40" : "border-ink-100"}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-medium">{row.employee_name}</span>
          {chosen && <span className="badge-blue">{chosen}</span>}
          {match?.confidence != null && (
            <span className={confidenceBadgeClass(match.confidence)}>{fmtPct(match.confidence)}</span>
          )}
          {ambiguous && <span className="badge-amber">ambiguous</span>}
        </div>
        <div className="text-xs text-ink-500">{match?.reason}</div>
      </div>
      <div className="text-sm text-ink-600 mt-1 flex flex-wrap gap-x-4 gap-y-1">
        {row.days_worked != null && <span><span className="text-ink-400">days</span> {row.days_worked}</span>}
        {row.hours != null && <span><span className="text-ink-400">hrs</span> {row.hours}</span>}
        {row.ot_hours != null && <span><span className="text-ink-400">OT</span> {row.ot_hours}</span>}
        {row.leave_codes?.length > 0 && (
          <span><span className="text-ink-400">leave</span> {row.leave_codes.join(", ")}</span>
        )}
        {row.reimbursements?.length > 0 && (
          <span>
            <span className="text-ink-400">reimb</span>{" "}
            {row.reimbursements.map((r) => `${r.reason}:${r.amount_aed}`).join(", ")}
          </span>
        )}
      </div>
      {ambiguous && match!.candidates.length > 1 && (
        <div className="mt-3 pt-3 border-t border-amber-200">
          <div className="text-xs font-medium text-ink-700 mb-1.5">Pick the correct employee:</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {match!.candidates.map((c: Candidate) => (
              <button
                key={c.emp_id}
                onClick={() => onPick(c.emp_id)}
                className={`text-left text-sm px-3 py-2 rounded-md border transition ${
                  pick === c.emp_id
                    ? "border-brand-600 bg-brand-50"
                    : "border-ink-200 hover:border-brand-400 hover:bg-ink-50"
                }`}
              >
                <div className="font-medium">{c.emp_id} · {c.full_name}</div>
                <div className="text-xs text-ink-500">
                  {c.client_code} · score {c.score.toFixed(3)}
                </div>
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
  const flat = cost.flat();
  const max = Math.max(...flat, 0.01);
  return (
    <div className="overflow-x-auto">
      <table className="text-xs border-separate border-spacing-0">
        <thead>
          <tr>
            <th className="text-left p-2 text-ink-500"></th>
            {colLabels.map((c) => (
              <th key={c} className="text-left p-2 text-ink-500 font-medium whitespace-nowrap">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cost.map((row, i) => (
            <tr key={i}>
              <td className="p-2 text-ink-700 font-medium whitespace-nowrap">{rowLabels[i]}</td>
              {row.map((v, j) => {
                const intensity = 1 - Math.min(1, v / max);
                const bg = `rgba(234, 88, 12, ${0.08 + intensity * 0.5})`;
                return (
                  <td
                    key={j}
                    className="p-2 text-center border border-ink-100 font-mono"
                    style={{ background: bg }}
                    title={`cost ${v.toFixed(3)}`}
                  >
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

function WhyDrawer({ invoiceId, timesheetId: _ts, onClose }: { invoiceId: string | null; timesheetId: string; onClose: () => void }) {
  const { data } = useQuery({
    queryKey: ["why", invoiceId],
    queryFn: () => invoiceId ? api.invoiceWhy(invoiceId) : Promise.resolve(null),
    enabled: !!invoiceId,
  });

  return (
    <>
      <motion.div
        className="fixed inset-0 bg-ink-900/40 z-40"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={onClose}
      />
      <motion.aside
        className="fixed right-0 top-0 bottom-0 w-full max-w-[520px] bg-white shadow-xl z-50 overflow-y-auto"
        initial={{ x: 600 }} animate={{ x: 0 }} exit={{ x: 600 }}
        transition={{ type: "spring", stiffness: 280, damping: 32 }}
      >
        <div className="sticky top-0 bg-white border-b border-ink-200 px-5 py-3 flex items-center justify-between">
          <div>
            <div className="text-xs uppercase tracking-wider text-ink-500">Provenance</div>
            <h3 className="font-semibold">Why this invoice?</h3>
          </div>
          <button className="btn-ghost" onClick={onClose}>Close</button>
        </div>
        <div className="p-5 space-y-5">
          {!invoiceId && (
            <div className="text-ink-500 text-sm">
              No invoice yet for this timesheet — approve it to generate.
            </div>
          )}
          {data?.invoice && (
            <div>
              <h4 className="font-medium mb-2">Invoice</h4>
              <div className="text-sm text-ink-700">
                <div>{fmtMoney(data.invoice.amount, data.invoice.currency)} · {data.invoice.client_code} · {data.invoice.period}</div>
                <div className="text-xs text-ink-500">status: {data.invoice.status}</div>
              </div>
            </div>
          )}
          {data?.match_result && data.match_result.cost_matrix.length > 0 && (
            <div>
              <h4 className="font-medium mb-2">Entity resolution</h4>
              <CostMatrix
                cost={data.match_result.cost_matrix}
                rowLabels={data.match_result.row_labels}
                colLabels={data.match_result.candidate_labels}
              />
            </div>
          )}
          {data?.validations && data.validations.length > 0 && (
            <div>
              <h4 className="font-medium mb-2">Validations</h4>
              <div className="space-y-1.5 text-sm">
                {data.validations.map((v, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className={v.passed ? "badge-green" : "badge-red"}>{v.passed ? "✓" : "×"}</span>
                    <div>
                      <div className="font-medium text-xs">{v.rule}{v.emp_id ? ` · ${v.emp_id}` : ""}</div>
                      <div className="text-ink-600 text-xs">{v.message}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {data?.events && (
            <div>
              <h4 className="font-medium mb-2">Audit timeline</h4>
              <ol className="space-y-2 text-xs">
                {data.events.map((e) => (
                  <li key={e.id} className="border-l-2 border-brand-300 pl-3">
                    <div className="font-medium text-ink-800">
                      {e.kind}.{e.action} <span className="text-ink-400">· {e.actor}</span>
                    </div>
                    <div className="text-ink-500">{new Date(e.at).toLocaleString()}</div>
                    {e.idempotency_key && (
                      <div className="text-ink-400 font-mono text-[10px] truncate">key {e.idempotency_key}</div>
                    )}
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

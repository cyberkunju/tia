import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ListChecks, CheckCircle2, XCircle, FileText, ExternalLink, AlertOctagon, Loader2 } from "lucide-react";
import { api, API_BASE } from "../api";
import { fmtMoney } from "../lib";
import { PageHeader, Panel, EmptyState, Badge, StatusBadge } from "../ui";

export function FinanceQueue() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["fin-queue"], queryFn: api.financeQueue, refetchInterval: 5_000,
  });

  const approve = useMutation({
    mutationFn: (id: string) => api.financeApprove(id, "finance"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fin-queue"] }),
  });
  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.financeReject(id, reason, "finance"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fin-queue"] }),
  });

  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  return (
    <div className="space-y-5">
      <PageHeader
        icon={ListChecks}
        title="Finance approval queue"
        description="Invoices over the per-client validation threshold need Finance sign-off before dispatch."
      />

      {isLoading ? (
        <div className="text-sm text-ink-500">Loading…</div>
      ) : !data || data.length === 0 ? (
        <Panel>
          <EmptyState
            icon={ListChecks}
            title="Queue is empty"
            hint="When an invoice exceeds the client's threshold, it lands here for Finance to approve or reject."
          />
        </Panel>
      ) : (
        <div className="space-y-3">
          {data.map((row) => (
            <div key={row.id} className="card p-4">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-xs text-ink-700">{row.invoice_sequence_no ?? row.id.slice(0, 8)}</span>
                    <StatusBadge status={row.status} />
                    {row.rule_failures.length > 0 && (
                      <Badge tone="red"><AlertOctagon size={11} /> {row.rule_failures.length} rule fail</Badge>
                    )}
                  </div>
                  <p className="text-base font-semibold text-ink-900">
                    {row.client_name ?? row.client_code} · {row.period}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-500">
                    <span className="tnum">{fmtMoney(row.total_incl_vat ?? row.amount, row.currency)}</span>
                    {" "}incl VAT · threshold {fmtMoney(row.threshold, row.currency)}
                  </p>
                  {row.rule_failures.length > 0 && (
                    <ul className="mt-2 text-2xs text-red-700 space-y-0.5">
                      {row.rule_failures.slice(0, 3).map((f, i) => (
                        <li key={i}><strong>{f.rule_id ?? f.rule}</strong>: {f.message}</li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  <a href={`${API_BASE}/invoices/${row.id}/pdf`} target="_blank" rel="noreferrer" className="btn-outline btn-sm">
                    <FileText size={14} /> PDF
                  </a>
                  <button
                    onClick={() => setRejectingId(row.id)}
                    className="btn-danger btn-sm"
                  >
                    <XCircle size={14} /> Reject
                  </button>
                  <button
                    onClick={() => approve.mutate(row.id)}
                    disabled={approve.isPending}
                    className="inline-flex items-center gap-1.5 rounded-md bg-brand-500 hover:bg-brand-400 text-teal-950 text-xs font-semibold px-3 py-1.5 shadow-xs disabled:opacity-50"
                  >
                    {approve.isPending ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                    Approve
                  </button>
                </div>
              </div>

              {rejectingId === row.id && (
                <div className="mt-3 border-t border-ink-200 pt-3 space-y-2">
                  <textarea
                    autoFocus
                    rows={2}
                    placeholder="Why reject?"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="textarea text-sm"
                  />
                  <div className="flex items-center justify-end gap-2">
                    <button onClick={() => { setRejectingId(null); setReason(""); }} className="btn-outline btn-sm">Cancel</button>
                    <button
                      onClick={() => {
                        reject.mutate({ id: row.id, reason });
                        setRejectingId(null); setReason("");
                      }}
                      disabled={!reason.trim()}
                      className="btn-danger btn-sm"
                    >
                      Confirm reject
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="text-2xs text-ink-400 mt-4">
        ← <Link to="/finance" className="underline">back to Finance dashboard</Link>
        <span className="mx-2">·</span>
        Need details? <a href="#" className="underline" onClick={(e) => { e.preventDefault(); document.querySelector<HTMLButtonElement>('button[aria-label="Open TIA chat"]')?.click(); }}>Ask TIA <ExternalLink size={9} className="inline" /></a>
      </p>
    </div>
  );
}

import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, FileText, FileImage, Mail, FileSpreadsheet, ExternalLink,
  CheckCircle2, XCircle, ShieldAlert, Activity, Users, Loader2, AlertCircle,
  Receipt, Truck,
} from "lucide-react";
import { api, API_BASE } from "../api";
import type { Candidate, ExtractedRow, RowMatch } from "../types";
import {
  PageHeader, Panel, StatusBadge, RoutingBadge, ConfidenceBadge, Spinner, Badge,
} from "../ui";
import { fmtMoney, cn } from "../lib";
import { ContractPanel } from "../components/ContractPanel";
import { RuleChip, RuleSummary } from "../components/RuleChip";
import { EmlCard } from "../components/EmlCard";
import { EventTimeline } from "../components/EventTimeline";

export function FinOpsReview() {
  const { docId = "" } = useParams();
  const nav = useNavigate();
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
  const invoice = invoices[0];

  const events = useQuery({
    queryKey: ["events", docId],
    queryFn: () => api.listEvents(docId, 50),
    enabled: !!docId,
    refetchInterval: 3_000,
  });

  const [picks, setPicks] = useState<Record<number, string>>({});
  const [hoverRow, _setHoverRow] = useState<number | null>(null);
  // _setHoverRow keeps the prop interface stable for future highlighting on hover
  void hoverRow; void _setHoverRow;

  const approve = useMutation({
    mutationFn: () => api.approve(
      ts!.id,
      Object.entries(picks).map(([idx, emp]) => ({ row_idx: Number(idx), chosen_emp_id: emp })),
    ),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["doc", docId] }); refetch(); },
  });
  const reject = useMutation({
    mutationFn: (reason: string) => api.reject(ts!.id, reason),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["doc", docId] }); refetch(); },
  });

  if (isLoading) return <div className="text-ink-500 text-sm flex items-center gap-2"><Spinner /> Loading review…</div>;
  if (!data || !ts) return <div className="text-ink-500 text-sm">Document not found.</div>;

  const mime = data.doc.mime ?? "";
  const sourceUrl = api.docSourceUrl(docId);
  const sourceIsImage = mime.startsWith("image/");
  const sourceIsPdf = mime === "application/pdf";
  const sourceIsEml = mime === "message/rfc822" || data.doc.filename?.toLowerCase().endsWith(".eml");
  const sourceIsExcel = mime.includes("spreadsheet") || mime.includes("excel") || data.doc.filename?.toLowerCase().endsWith(".xlsx");

  const ambiguous = mr?.matches?.some((m) => m.ambiguous);
  const canApprove = ts.routing === "hitl" || ts.routing === "escalate";

  return (
    <div className="space-y-4">
      <PageHeader
        icon={FileText}
        title={data.doc.filename || `Document · ${docId.slice(0, 8)}`}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="text-2xs uppercase tracking-wide text-ink-400 font-semibold">{data.doc.channel}</span>
            <span className="text-ink-300">·</span>
            <span>{data.doc.uploaded_at?.slice(0, 19).replace("T", " ")}</span>
            {data.doc.uploaded_by && <span className="text-ink-400">· by {data.doc.uploaded_by}</span>}
          </span>
        }
        actions={
          <>
            <button onClick={() => nav("/finops")} className="btn-outline btn-sm">
              <ArrowLeft size={14} /> Inbox
            </button>
            <a href={sourceUrl} target="_blank" rel="noreferrer" className="btn-outline btn-sm">
              Open raw <ExternalLink size={12} />
            </a>
          </>
        }
      />

      <div className="grid lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-4">
        {/* LEFT — source viewer */}
        <div className="card-flush overflow-hidden flex flex-col">
          <header className="flex items-center justify-between px-4 py-2.5 border-b border-ink-200 bg-ink-50/50">
            <div className="flex items-center gap-2 text-2xs uppercase tracking-wide text-ink-500 font-semibold">
              {sourceIsImage ? <FileImage size={13} /> :
                sourceIsPdf ? <FileText size={13} /> :
                sourceIsEml ? <Mail size={13} /> :
                sourceIsExcel ? <FileSpreadsheet size={13} /> : <FileText size={13} />}
              Source · {mime || data.doc.channel}
            </div>
            <span className="text-2xs text-ink-400 font-mono">{data.doc.filename}</span>
          </header>

          <div className="flex-1 min-h-[520px] bg-ink-50/40 overflow-auto">
            {sourceIsImage && (
              <div className="h-full flex items-center justify-center p-3">
                <img src={sourceUrl} alt="source" className="max-h-[560px] max-w-full object-contain" />
              </div>
            )}
            {sourceIsPdf && (
              <iframe src={sourceUrl} title="source pdf" className="w-full h-[640px] border-0" />
            )}
            {sourceIsEml && <EmlCard sourceUrl={sourceUrl} />}
            {sourceIsExcel && (
              <div className="h-full flex flex-col items-center justify-center text-ink-500 text-sm gap-2 px-6 text-center">
                <FileSpreadsheet size={36} className="text-emerald-600" />
                <p>Excel source · use Open raw or see the extracted rows on the right.</p>
                <a href={sourceUrl} target="_blank" rel="noreferrer" className="btn-outline btn-sm mt-1">
                  Download .xlsx
                </a>
              </div>
            )}
            {!sourceIsImage && !sourceIsPdf && !sourceIsEml && !sourceIsExcel && (
              <div className="h-full flex flex-col items-center justify-center text-ink-500 text-sm px-6 text-center">
                Source: {mime || "text"}.{" "}
                <a className="text-brand-700 underline ml-1" href={sourceUrl} target="_blank" rel="noreferrer">
                  Open raw
                </a>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT — extracted + contract + rules + activity */}
        <div className="space-y-4 min-w-0">
          {/* Status / routing strip */}
          <Panel
            title={<span className="flex items-center gap-2">
              <ShieldAlert size={14} className="text-brand-700" />
              Pipeline status
            </span>}
          >
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={ts.status} />
              <RoutingBadge routing={ts.routing} />
              <ConfidenceBadge value={ts.confidence} />
              {ts.client_code && (
                <span className="inline-flex items-center gap-1 rounded-md bg-teal-50 text-teal-800 border border-teal-200 px-2 py-0.5 text-xs font-medium">
                  Client {ts.client_code}
                </span>
              )}
              {ts.period && (
                <span className="inline-flex items-center gap-1 rounded-md bg-ink-100 text-ink-700 border border-ink-200 px-2 py-0.5 text-xs font-medium">
                  Period {ts.period}
                </span>
              )}
            </div>
            {ts.hitl_reason && (
              <div className="mt-3 text-xs rounded-md border border-amber-200 bg-amber-50 text-amber-900 px-3 py-2 font-medium">
                <ShieldAlert size={12} className="inline mr-1.5" /> {ts.hitl_reason}
              </div>
            )}
          </Panel>

          {/* Contract panel (BTP-rule parameters we validate against) */}
          <ContractPanel clientCode={ts.client_code} />

          {/* Extracted rows + Hungarian resolution */}
          {ex?.rows && ex.rows.length > 0 && (
            <Panel
              title={<span className="flex items-center gap-2">
                <Users size={14} className="text-teal-700" />
                Extracted {ex.rows.length} row{ex.rows.length === 1 ? "" : "s"}
              </span>}
              subtitle={ex.client_code ? `Resolved against ${ex.client_code}'s roster` : undefined}
            >
              <div className="space-y-2">
                {ex.rows.map((r, idx) => (
                  <RowCard
                    key={idx}
                    row={r}
                    match={mr?.matches[idx]}
                    pick={picks[idx]}
                    onPick={(emp) => setPicks((p) => ({ ...p, [idx]: emp }))}
                  />
                ))}
              </div>
            </Panel>
          )}

          {/* BTP-style validation rules */}
          {ts.validations && ts.validations.length > 0 && (
            <Panel
              title={<span className="flex items-center gap-2">
                <ShieldAlert size={14} className="text-brand-700" />
                Validation rules
              </span>}
              subtitle="BTP-style rule engine output. Failures route to HITL."
            >
              <RuleSummary results={ts.validations} />
              <div className="mt-3 space-y-2">
                {ts.validations
                  .filter((v) => !v.passed || v.severity === "warning")
                  .map((r, i) => <RuleChip key={i} result={r} />)}
              </div>
              {ts.validations.every((v) => v.passed && v.severity !== "warning") && (
                <p className="mt-2 text-xs text-emerald-700">
                  ✓ All {ts.validations.length} rules passed.
                </p>
              )}
            </Panel>
          )}

          {/* Activity */}
          <Panel
            title={<span className="flex items-center gap-2">
              <Activity size={14} className="text-teal-700" />
              Activity
            </span>}
            subtitle="Append-only audit. Replay-safe."
          >
            <EventTimeline events={events.data ?? []} />
          </Panel>

          {/* Generated invoice */}
          {invoice && (
            <Panel
              title={<span className="flex items-center gap-2">
                <Receipt size={14} className="text-brand-700" /> Generated invoice
              </span>}
            >
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="font-mono text-xs">{invoice.invoice_sequence_no ?? invoice.id.slice(0, 8)}</span>
                <span className="tnum font-semibold">{fmtMoney(invoice.total_incl_vat ?? invoice.amount, invoice.currency)}</span>
                <StatusBadge status={invoice.status} />
                {invoice.pdf_available && (
                  <a href={`${API_BASE}/invoices/${invoice.id}/pdf`} target="_blank" rel="noreferrer" className="btn-outline btn-sm">
                    <FileText size={14} /> Open PDF
                  </a>
                )}
                <a href={`/finops/dispatch/${invoice.client_code}`} className="btn-outline btn-sm">
                  <Truck size={14} /> Dispatch view
                </a>
              </div>
            </Panel>
          )}

          {/* Approve / Reject (only when HITL) */}
          {canApprove && (
            <div className="card p-4 sticky bottom-3 z-10 bg-white shadow-md">
              <div className="flex flex-wrap items-center gap-3">
                {ambiguous && (
                  <Badge tone="amber">Pick a candidate for each ambiguous row, then approve.</Badge>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <button
                    onClick={() => {
                      const r = window.prompt("Reject reason:");
                      if (r) reject.mutate(r);
                    }}
                    disabled={reject.isPending}
                    className="btn-danger btn-sm"
                  >
                    {reject.isPending ? <Loader2 size={14} className="animate-spin" /> : <XCircle size={14} />} Reject
                  </button>
                  <button
                    onClick={() => approve.mutate()}
                    disabled={approve.isPending}
                    className="inline-flex items-center gap-1.5 rounded-md bg-brand-500 hover:bg-brand-400 text-teal-950 text-sm font-semibold px-4 py-2 shadow-sm disabled:opacity-60"
                  >
                    {approve.isPending ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                    Approve & generate invoice
                  </button>
                </div>
              </div>
              {(approve.isError || reject.isError) && (
                <div className="mt-2 text-xs text-red-700 inline-flex items-center gap-1">
                  <AlertCircle size={12} /> {String(approve.error ?? reject.error)}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ───────────── row card ───────────── */

function RowCard({ row, match, pick, onPick }: {
  row: ExtractedRow; match?: RowMatch; pick?: string;
  onPick: (emp: string) => void;
}) {
  const chosen = pick ?? match?.chosen_emp_id;
  const ambiguous = !!match?.ambiguous && !pick;

  return (
    <div className={cn(
      "rounded-md border p-3 transition-colors",
      ambiguous ? "border-amber-300 bg-amber-50/40" : "border-ink-200 bg-white",
    )}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink-900">
            {row.employee_name || <em className="text-ink-400">(no name)</em>}
          </p>
          <p className="mt-0.5 text-2xs text-ink-500 flex flex-wrap items-center gap-1.5">
            {row.emp_id && <code className="font-mono">{row.emp_id}</code>}
            {row.days_worked != null && <span>· {row.days_worked} days</span>}
            {row.ot_hours != null && row.ot_hours > 0 && <span>· {row.ot_hours} OT hrs</span>}
            {row.leave_codes?.length > 0 && (
              <span>· leave: <span className="font-mono">{row.leave_codes.join(", ")}</span></span>
            )}
          </p>
        </div>
        {chosen && !ambiguous && (
          <Badge tone="green">→ {chosen}</Badge>
        )}
        {ambiguous && (
          <Badge tone="amber">Ambiguous · pick one</Badge>
        )}
      </div>

      {match && match.candidates.length > 0 && (
        <div className="mt-2 grid sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
          {match.candidates.slice(0, 6).map((c) => {
            const active = chosen === c.emp_id;
            return (
              <CandidateButton key={c.emp_id} c={c} active={active} onPick={() => onPick(c.emp_id)} />
            );
          })}
        </div>
      )}

      {match?.reason && (
        <p className="mt-2 text-2xs text-ink-500 italic">{match.reason}</p>
      )}
    </div>
  );
}

function CandidateButton({ c, active, onPick }: { c: Candidate; active: boolean; onPick: () => void }) {
  return (
    <button
      onClick={onPick}
      className={cn(
        "text-left rounded border px-2 py-1.5 text-xs transition-colors",
        active
          ? "border-brand-500 bg-brand-50"
          : "border-ink-200 hover:border-brand-300 hover:bg-brand-50/40",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-2xs text-ink-700">{c.emp_id}</span>
        <span className="tnum text-2xs text-ink-500">{(c.score * 100).toFixed(0)}%</span>
      </div>
      <div className="truncate text-ink-800">{c.full_name}</div>
      <div className="text-2xs text-ink-500">{c.client_code}</div>
    </button>
  );
}

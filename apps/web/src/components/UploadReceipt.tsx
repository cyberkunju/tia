import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, Loader2, FileText, ExternalLink, Sparkles, ArrowRight } from "lucide-react";
import { api, API_BASE } from "../api";
import { cn, fmtAED } from "../lib";
import { usePersona } from "../store";

/**
 * UploadReceipt — what the client sees the moment a file goes in.
 *
 * Polls /documents/{doc_id} every 1.5s and renders a live 5-step pipeline
 * (Received → Extracted → Matched → Checked → Invoiced). When the invoice is
 * generated the card surfaces the PDF link directly. When confidence is high
 * enough the backend auto-dispatches, and the card promotes "Auto-dispatched"
 * with a one-click Why? deep-link into the FinOps Console.
 */
export function UploadReceipt({ docId }: { docId: string }) {
  const nav = useNavigate();
  const { setPersona } = usePersona();
  const { data } = useQuery({
    queryKey: ["doc", docId],
    queryFn: () => api.getDoc(docId),
    enabled: !!docId,
    refetchInterval: 1500,
  });

  const ts = data?.timesheet;
  const inv = data?.invoices?.[0];
  const conf = ts?.confidence ?? 0;
  const routing = ts?.routing;
  const fails = (ts?.validations ?? []).filter((v) => !v.passed && v.severity !== "warning").length;

  // Stage progression — stop where we currently are.
  // 1 received → 2 extracted → 3 matched → 4 checked → 5 invoiced → (dispatched)
  let stage = 1;
  if (ts?.extraction?.rows && ts.extraction.rows.length > 0) stage = 2;
  if (ts?.match_result?.matches && ts.match_result.matches.length > 0) stage = 3;
  if ((ts?.validations ?? []).length > 0) stage = 4;
  if (inv) stage = 5;
  const dispatched = inv?.status === "dispatched";
  const awaitingReview = ts?.status === "awaiting_review";

  const STAGES = [
    { id: 1, label: "Received" },
    { id: 2, label: "Read" },
    { id: 3, label: "Matched" },
    { id: 4, label: "Checked" },
    { id: 5, label: "Invoiced" },
  ];

  const trackInPipeline = () => {
    setPersona("finops");
    nav(`/console?doc=${docId}`);
  };

  return (
    <div className="card overflow-hidden">
      {/* Headline — what's happening right now in plain English */}
      <div className={cn(
        "px-4 py-3 border-b",
        dispatched ? "bg-emerald-50 border-emerald-200" :
        inv ? "bg-brand-50 border-brand-200" :
        awaitingReview ? "bg-amber-50 border-amber-200" :
        "bg-ink-50 border-ink-200",
      )}>
        <div className="flex items-center gap-2 text-sm font-semibold">
          {dispatched ? <><CheckCircle2 size={15} className="text-emerald-700" /> Auto-dispatched · invoice sent</>
            : inv ? <><Sparkles size={15} className="text-brand-700" /> Tax invoice ready</>
            : awaitingReview ? <><Loader2 size={15} className="text-amber-700" /> A FinOps reviewer is taking a look</>
            : <><Loader2 size={15} className="text-ink-500 animate-spin" /> Working on it…</>}
        </div>
        <p className="text-xs text-ink-600 mt-0.5">
          {dispatched ? `Confidence ${(conf * 100).toFixed(0)}% — every contract check passed, so no human was needed.`
            : inv ? "Ready for your approval — open the PDF below."
            : awaitingReview ? `Confidence ${(conf * 100).toFixed(0)}% · ${fails} item${fails === 1 ? "" : "s"} need${fails === 1 ? "s" : ""} a quick look.`
            : "Reading the timesheet and matching associates."}
        </p>
      </div>

      {/* Live 5-step strip — every step lights up the moment the backend reaches it. */}
      <div className="px-4 py-3 flex items-center justify-between gap-1 overflow-x-auto">
        {STAGES.map((s, i) => {
          const reached = s.id <= stage;
          const current = s.id === stage && !dispatched && !awaitingReview;
          return (
            <div key={s.id} className="flex items-center gap-1.5 shrink-0">
              <span
                className={cn(
                  "grid place-items-center h-6 w-6 rounded-full text-[10px] font-semibold border",
                  reached && !current && "bg-emerald-100 text-emerald-800 border-emerald-200",
                  current && "bg-brand-500 text-teal-950 border-brand-600 ring-2 ring-brand-200 animate-pulse",
                  !reached && "bg-ink-50 text-ink-400 border-ink-200",
                )}
              >
                {reached && !current ? <CheckCircle2 size={11} /> : s.id}
              </span>
              <span className={cn("text-2xs font-medium", reached ? "text-ink-800" : "text-ink-400")}>{s.label}</span>
              {i < STAGES.length - 1 && (
                <span className={cn("h-px w-3 sm:w-5", s.id < stage ? "bg-emerald-300" : "bg-ink-200")} />
              )}
            </div>
          );
        })}
      </div>

      {/* Summary chips + actions */}
      <div className="px-4 pb-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {ts?.client_code && <span className="badge-slate">{ts.client_code}</span>}
          {ts?.period && <span className="badge-blue">{ts.period}</span>}
          {routing === "auto" && <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 bg-brand-50 text-brand-800 border border-brand-200 font-medium">⚡ auto</span>}
          {routing === "hitl" && <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 bg-amber-50 text-amber-900 border border-amber-200 font-medium">👤 needs review</span>}
          {inv?.total_incl_vat != null && (
            <span className="ml-auto tnum font-semibold text-ink-900">{fmtAED(inv.total_incl_vat)}</span>
          )}
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          {inv?.pdf_available && (
            <a
              href={`${API_BASE}/invoices/${inv.id}/pdf`}
              target="_blank"
              rel="noreferrer"
              className="btn-primary btn-sm justify-center flex-1"
            >
              <FileText size={13} /> Open tax invoice (PDF) <ExternalLink size={11} />
            </a>
          )}
          <button onClick={trackInPipeline} className={cn("btn-outline btn-sm justify-center", !inv?.pdf_available && "flex-1")}>
            Track in pipeline <ArrowRight size={13} />
          </button>
        </div>

        {/* Tiny audit hint — links to the same doc in FinOps Console */}
        <p className="text-2xs text-ink-400 leading-snug">
          Every step above is recorded in TIA's tamper-evident audit chain. Click <em>Track in pipeline</em> to see the full timeline and rationale.
        </p>
      </div>
    </div>
  );
}
